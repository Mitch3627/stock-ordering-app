const express = require('express');
const { requireManager } = require('../lib/auth');
const { applyEvent, getOnHand, setBatchQty, reconcileBatches } = require('../ledger/ledger');
const { badRequest, toNumber } = require('../lib/validate');
const { todayLocal } = require('../lib/dates');

const ITEM_FIELDS = [
  'name', 'category', 'supplier_name', 'supplier_product_id', 'supplier_unit', 'supplier_order_pack', 'unit_label',
  'items_per_order_unit', 'usage_per_100_sales', 'buffer_value', 'max_boxes', 'case_multiple',
  'price_per_unit', 'shelf_life_days', 'track_use_by', 'active',
];

// Numeric fields: which may be left blank, and which must be above (not just at least) zero.
const NUMBER_FIELDS = {
  items_per_order_unit: { nullable: false, positive: true },
  usage_per_100_sales: { nullable: false },
  buffer_value: { nullable: false },
  max_boxes: { nullable: true },
  case_multiple: { nullable: true, positive: true },
  price_per_unit: { nullable: true },
  shelf_life_days: { nullable: true },
  supplier_order_pack: { nullable: true, positive: true },
};

// Fields used in CSV import/export (excludes internal fields)
const CSV_FIELDS = [
  'name', 'category', 'unit_label', 'items_per_order_unit',
  'usage_per_100_sales', 'buffer_value', 'max_boxes', 'case_multiple',
  'price_per_unit', 'shelf_life_days',
];

function toCsvValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const lines = text.trim().split('\n').filter(l => l.length > 0);
  const header = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = values[i] === '' ? null : values[i]; });
    return row;
  });
}

// Checks the fields present in a create/update body and returns them cleaned up.
function cleanFields(body) {
  const out = {};
  for (const f of ITEM_FIELDS) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if (NUMBER_FIELDS[f]) {
      const rule = NUMBER_FIELDS[f];
      if (v === null || v === '') {
        if (!rule.nullable) throw badRequest(`${f.replace(/_/g, ' ')} can't be blank`);
        v = null;
      } else {
        v = toNumber(v);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (rule.positive && v === 0)) {
          throw badRequest(`${f.replace(/_/g, ' ')} must be a number ${rule.positive ? 'above 0' : 'of 0 or more'}`);
        }
      }
    } else if (f === 'track_use_by' || f === 'active') {
      v = v ? 1 : 0;
    } else if (f === 'name' || f === 'category' || f === 'unit_label') {
      v = String(v ?? '').trim();
      if (!v) throw badRequest(`${f === 'unit_label' ? 'unit' : f} can't be blank`);
    } else if (typeof v === 'string') {
      v = v.trim() || null;
    }
    out[f] = v;
  }
  return out;
}

function createItemsRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(db.prepare(`
      SELECT items.*, COALESCE(inventory_ledger.on_hand_qty, 0) AS on_hand_qty
      FROM items
      LEFT JOIN inventory_ledger ON inventory_ledger.item_id = items.id
      ORDER BY items.category, items.name
    `).all());
  });

  router.get('/export.csv', (req, res) => {
    const items = db.prepare('SELECT * FROM items ORDER BY category, name').all();
    const header = CSV_FIELDS.join(',');
    const rows = items.map(item => CSV_FIELDS.map(f => toCsvValue(item[f])).join(','));
    res.set('Content-Type', 'text/csv');
    res.send([header, ...rows].join('\n'));
  });

  router.post('/import', requireManager, (req, res) => {
    const rows = parseCsv(req.body.csv);
    if (rows.length === 0) {
      return res.json({ imported: 0 });
    }

    // Determine which fields are present in the CSV
    const firstRow = rows[0];
    const csvFields = Object.keys(firstRow).filter(f => ITEM_FIELDS.includes(f));

    const updates = csvFields.filter(f => f !== 'name').map(f => `${f} = excluded.${f}`);
    const upsert = db.prepare(`
      INSERT INTO items (${csvFields.join(', ')})
      VALUES (${csvFields.map(() => '?').join(', ')})
      ON CONFLICT(name) DO ${updates.length ? 'UPDATE SET ' + updates.join(', ') : 'NOTHING'}
    `);
    const run = db.transaction(() => {
      for (const row of rows) {
        upsert.run(...csvFields.map(f => row[f] === undefined || row[f] === null ? null : row[f]));
      }
    });
    run();
    res.json({ imported: rows.length });
  });

  router.get('/:id', (req, res) => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json(item);
  });

  router.post('/', requireManager, (req, res) => {
    const fields = cleanFields(req.body);
    for (const f of ['name', 'category', 'unit_label']) {
      if (!fields[f]) return res.status(400).json({ error: `${f === 'unit_label' ? 'unit' : f} is required` });
    }
    if (db.prepare('SELECT 1 FROM items WHERE name = ?').get(fields.name)) {
      return res.status(409).json({ error: 'another item is already called "' + fields.name + '"' });
    }
    const names = Object.keys(fields);
    const info = db.prepare(`
      INSERT INTO items (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
    `).run(...names.map(f => fields[f]));
    res.status(201).json(db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid));
  });

  router.put('/:id', requireManager, (req, res) => {
    const fields = cleanFields(req.body);
    const names = Object.keys(fields);
    if (names.length === 0) return res.status(400).json({ error: 'no fields to update' });

    const current = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'not found' });

    // The official supplier name / product id link this item to the supplier system (future auto-ordering):
    // they can be set once but never changed, so a display rename can't break the link.
    for (const f of ['supplier_name', 'supplier_product_id']) {
      if (fields[f] !== undefined && current[f] !== null && current[f] !== '' && String(fields[f]) !== String(current[f])) {
        return res.status(400).json({ error: f + ' is the official supplier link and cannot be changed' });
      }
    }
    if (fields.name !== undefined) {
      const clash = db.prepare('SELECT 1 FROM items WHERE name = ? AND id <> ?').get(fields.name, req.params.id);
      if (clash) return res.status(409).json({ error: 'another item is already called "' + fields.name + '"' });
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE items SET ${names.map(f => `${f} = ?`).join(', ')} WHERE id = ?
      `).run(...names.map(f => fields[f]), req.params.id);

      // Stock is stored in order units. When the size of an order unit changes, the physical stock can be kept
      // the same (360 patties stay 360 patties) by converting on-hand and the dated batches.
      const oldSize = current.items_per_order_unit;
      const newSize = fields.items_per_order_unit;
      if (req.body.convertStock && newSize !== undefined && newSize !== oldSize && oldSize > 0) {
        const factor = oldSize / newSize;
        const onHand = getOnHand(db, current.id);
        const converted = Math.round(onHand * factor * 1e6) / 1e6;
        for (const b of db.prepare('SELECT id, qty_remaining FROM batches WHERE item_id = ? AND qty_remaining > 0').all(current.id)) {
          setBatchQty(db, b.id, b.qty_remaining * factor);
        }
        if (converted !== onHand) {
          applyEvent(db, {
            itemId: current.id, type: 'count_correction', qtyDelta: converted - onHand,
            occurredAt: todayLocal(),
            note: `Items per order unit changed ${oldSize} -> ${newSize}: stock kept at ${Math.round(onHand * oldSize * 1000) / 1000} ${current.supplier_unit || current.unit_label}`,
          });
        }
        reconcileBatches(db, current.id);
      }
    })();
    res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id));
  });

  return router;
}

module.exports = { createItemsRouter };
