const express = require('express');
const { requireManager } = require('../lib/auth');
const { useByNeeded } = require('./prompts');
const { applyEvent, getOnHand } = require('../ledger/ledger');
const { round6 } = require('../lib/validate');
const { addDays, daysBetween, todayLocal } = require('../lib/dates');

function createBatchesRouter(db, { today } = {}) {
  const getToday = today || todayLocal;
  const router = express.Router();

  router.get('/', (req, res) => {
    const now = getToday();
    const useSoonThreshold = addDays(now, 1);
    const rows = db.prepare(`
      SELECT batches.*, items.name AS item_name, items.unit_label, items.supplier_unit, items.items_per_order_unit
      FROM batches
      JOIN items ON items.id = batches.item_id
      WHERE batches.qty_remaining > 0
      ORDER BY batches.use_by_date ASC, batches.received_at ASC, batches.id ASC
    `).all();

    for (const row of rows) {
      if (row.use_by_date < now) row.status = 'expired';
      else if (row.use_by_date <= useSoonThreshold) row.status = 'use_soon';
      else row.status = 'ok';
    }

    res.json(rows);
  });

  // Edit a batch: use-by date and/or the quantity still remaining (order units).
  // A quantity change is a stock change, so on-hand moves by the same amount.
  router.put('/:id', requireManager, (req, res) => {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
    if (!batch) return res.status(404).json({ error: 'not found' });
    const { use_by_date, qty_remaining } = req.body;
    if (use_by_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(use_by_date)) {
      return res.status(400).json({ error: 'use_by_date must be YYYY-MM-DD' });
    }
    if (qty_remaining !== undefined && !(qty_remaining >= 0)) {
      return res.status(400).json({ error: 'qty_remaining must be 0 or more' });
    }
    db.transaction(() => {
      if (use_by_date !== undefined) db.prepare('UPDATE batches SET use_by_date = ? WHERE id = ?').run(use_by_date, batch.id);
      if (qty_remaining !== undefined) {
        const delta = Math.round((qty_remaining - batch.qty_remaining) * 1e6) / 1e6;
        db.prepare('UPDATE batches SET qty_remaining = ? WHERE id = ?').run(qty_remaining, batch.id);
        if (delta !== 0) {
          applyEvent(db, {
            itemId: batch.item_id, type: 'count_correction', qtyDelta: delta, occurredAt: getToday(),
            note: `Batch edited: ${batch.qty_remaining} -> ${qty_remaining} order units (use-by ${batch.use_by_date})`,
          });
        }
      }
    })();
    res.json(db.prepare('SELECT * FROM batches WHERE id = ?').get(batch.id));
  });

  // Give part of a batch its own use-by date - e.g. 2 cases taken out of the freezer now use by the 26th while the
  // rest stay on the 27th. `qty` is in order units. Stock on hand doesn't change: it's the same stock with a new
  // date. Sending the whole batch just re-dates it.
  router.post('/:id/split', (req, res) => {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
    if (!batch || !(batch.qty_remaining > 0)) return res.status(404).json({ error: 'batch not found' });
    const { useByDate } = req.body;
    const qty = Number(req.body.qty);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(useByDate || '')) return res.status(400).json({ error: 'useByDate must be YYYY-MM-DD' });
    if (!(qty > 0)) return res.status(400).json({ error: 'qty must be more than 0' });
    if (qty > batch.qty_remaining + 1e-6) {
      return res.status(400).json({ error: `only ${Math.round(batch.qty_remaining * 1000) / 1000} left in that batch` });
    }
    const now = getToday();
    const whole = qty >= batch.qty_remaining - 1e-6;
    let id = batch.id;
    db.transaction(() => {
      if (whole) {
        db.prepare('UPDATE batches SET use_by_date = ?, redated_at = ? WHERE id = ?').run(useByDate, now, batch.id);
      } else {
        db.prepare('UPDATE batches SET qty_remaining = ? WHERE id = ?').run(round6(batch.qty_remaining - qty), batch.id);
        id = db.prepare(`
          INSERT INTO batches (item_id, delivery_id, received_at, shelf_life_days, use_by_date, qty_remaining, redated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(batch.item_id, batch.delivery_id, batch.received_at, Math.max(0, daysBetween(batch.received_at, useByDate)),
          useByDate, round6(qty), now).lastInsertRowid;
      }
    })();
    res.status(201).json({ id: Number(id), from: batch.id, qty: whole ? batch.qty_remaining : round6(qty), useByDate, whole });
  });

  // Correct an item's stock while adding use-by dates (e.g. a miscount spotted while dating it). Send `total`
  // (all stock on hand, dated or not) - or, the older way, `qty` for just the stock without a date yet.
  // Ledger only: dated batches are never touched.
  router.post('/undated-stock', (req, res) => {
    const { total, qty } = req.body;
    const itemId = Number(req.body.itemId);
    const item = db.prepare('SELECT id, name, track_use_by FROM items WHERE id = ?').get(itemId);
    if (!item || !item.track_use_by) return res.status(400).json({ error: 'not a use-by tracked item' });
    const wanted = total !== undefined ? total : qty;
    if (!(typeof wanted === 'number' && Number.isFinite(wanted) && wanted >= 0)) {
      return res.status(400).json({ error: (total !== undefined ? 'total' : 'qty') + ' must be 0 or more' });
    }
    const onHand = getOnHand(db, itemId);
    const dated = db.prepare('SELECT COALESCE(SUM(qty_remaining), 0) AS q FROM batches WHERE item_id = ? AND qty_remaining > 0').get(itemId).q;
    const undatedBefore = Math.max(0, Math.round((onHand - dated) * 1e6) / 1e6);
    let newTotal;
    if (total !== undefined) {
      if (total < dated - 1e-6) {
        return res.status(400).json({ error: `That's less than the ${Math.round(dated * 100) / 100} already dated - change the dated batches on the Expiry page first` });
      }
      newTotal = total;
    } else {
      newTotal = dated + qty;
    }
    const delta = Math.round((newTotal - onHand) * 1e6) / 1e6;
    if (delta !== 0) {
      applyEvent(db, {
        itemId, type: 'count_correction', qtyDelta: delta, occurredAt: getToday(),
        note: `Stock corrected while adding use-by dates (${Math.round(onHand * 1000) / 1000} -> ${Math.round(newTotal * 1000) / 1000}, of which ${Math.round(dated * 1000) / 1000} dated)`,
      });
    }
    res.json({ itemId, total: newTotal, dated, undated: Math.round((newTotal - dated) * 1e6) / 1e6, undatedBefore, adjusted: delta });
  });

  // Opening stock: attach use-by dates to stock that is already counted on hand.
  // Creates batches only; on-hand is untouched because the count already set it.
  router.post('/', (req, res) => {
    const { itemId, lines } = req.body;
    if (!itemId || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'itemId and at least one line are required' });
    }
    if (lines.some(l => !(l.qty > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(l.useByDate || ''))) {
      return res.status(400).json({ error: 'each line needs qty > 0 and a YYYY-MM-DD useByDate' });
    }
    const need = useByNeeded(db).find(n => n.itemId === itemId);
    const total = lines.reduce((s, l) => s + l.qty, 0);
    if (!need || total > need.missing + 0.001) {
      return res.status(400).json({ error: 'quantity exceeds the undated stock on hand (' + (need ? need.missing : 0) + ')' });
    }
    const today = getToday();
    const insert = db.prepare(`
      INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const l of lines) {
        const days = Math.max(0, Math.round((new Date(l.useByDate + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000));
        insert.run(itemId, today, days, l.useByDate, l.qty);
      }
    })();
    res.status(201).json({ itemId, created: lines.length });
  });

  return router;
}

module.exports = { createBatchesRouter };
