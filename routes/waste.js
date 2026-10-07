const express = require('express');
const { requireManager } = require('../lib/auth');
const { applyEventWithConsumption, returnStock } = require('../ledger/ledger');
const { expiredStock } = require('../lib/expiredStock');
const { latestCountDate } = require('../lib/baseline');
const { badRequest, isDate, requireQty, round6 } = require('../lib/validate');
const { todayLocal } = require('../lib/dates');
const { currentUserId } = require('../lib/context');

const REPEAT_WINDOW_SECONDS = 20;

function createWasteRouter(db, options = {}) {
  const getToday = options.today || todayLocal;
  const router = express.Router();

  // Checks a waste entry and converts its quantity to order units. Quantities are typed either in the item's
  // The supplier unit ("native", e.g. patties) or in order units (cases); order units if not said.
  function readEntry(body, current = {}) {
    const itemId = body.itemId ?? current.item_id;
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(itemId));
    if (!item) throw badRequest('Pick an item');
    const shift = body.shift ?? current.shift;
    if (!['open', 'close'].includes(shift)) throw badRequest('shift must be "open" or "close"');
    const occurredAt = body.occurredAt ?? current.occurred_at;
    if (!isDate(occurredAt)) throw badRequest('occurredAt must be a date (YYYY-MM-DD)');
    const unit = body.unit || 'order';
    if (!['order', 'native'].includes(unit)) throw badRequest('unit must be "order" or "native"');
    const typed = requireQty(body.qty ?? current.qty, 'The quantity');
    const perOrder = item.items_per_order_unit > 0 ? item.items_per_order_unit : 1;
    const qty = round6(unit === 'native' && body.qty != null ? typed / perOrder : typed);
    return {
      item, qty, occurredAt, shift,
      reason: (body.reason !== undefined ? body.reason : current.reason) || null,
      note: (body.note !== undefined ? body.note : current.note) || null,
      ood: (body.ood !== undefined ? !!body.ood : !!current.ood) ? 1 : 0,
    };
  }

  const eventsOf = (id) => db.prepare("SELECT id FROM inventory_events WHERE source = 'waste' AND source_id = ?").all(id).map(r => r.id);
  const getEntry = db.prepare('SELECT * FROM waste_entries WHERE id = ? AND deleted_at IS NULL');
  // Waste on or before the latest count is already reflected in that count's figures, so correcting or deleting
  // it afterwards fixes the record without moving stock a second time.
  const coveredByCount = (date) => {
    const counted = latestCountDate(db);
    return !!counted && date <= counted;
  };

  // Out-of-date waste is the only thing that removes expired stock. It deducts like any waste,
  // oldest batch first, so the expired batch is the one that shrinks.
  router.post('/', (req, res) => {
    const e = readEntry(req.body);
    const repeat = db.prepare(`
      SELECT id FROM waste_entries
      WHERE item_id = ? AND ABS(qty - ?) < 1e-6 AND occurred_at = ? AND shift = ? AND ood = ? AND deleted_at IS NULL
        AND created_at >= datetime('now', ?)
    `).get(e.item.id, e.qty, e.occurredAt, e.shift, e.ood, `-${REPEAT_WINDOW_SECONDS} seconds`);
    if (repeat && !req.body.allowRepeat) {
      return res.status(409).json({ error: 'The same waste was logged a moment ago - it looks like a double click', existingId: repeat.id });
    }
    let id;
    const stockChanged = !coveredByCount(e.occurredAt);
    db.transaction(() => {
      id = Number(db.prepare(`
        INSERT INTO waste_entries (item_id, qty, occurred_at, shift, reason, note, ood, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(e.item.id, e.qty, e.occurredAt, e.shift, e.reason, e.note, e.ood, currentUserId()).lastInsertRowid);
      if (stockChanged) {
        applyEventWithConsumption(db, {
          itemId: e.item.id, type: 'waste', qtyDelta: -e.qty, occurredAt: e.occurredAt, note: e.reason || e.note || null,
          source: 'waste', sourceId: id,
        });
      }
    })();
    res.status(201).json({ id, itemId: e.item.id, qty: e.qty, occurredAt: e.occurredAt, shift: e.shift, reason: e.reason, note: e.note, stockChanged });
  });

  // Correct a waste entry: the old amount goes back (into the batches it came out of) and the new one comes off.
  router.put('/:id', requireManager, (req, res) => {
    const current = getEntry.get(Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'not found' });
    if (req.body.itemId != null && Number(req.body.itemId) !== current.item_id) {
      throw badRequest('To change the item, delete this entry and log a new one');
    }
    const e = readEntry(req.body, current);
    const oldCovered = coveredByCount(current.occurred_at);
    const newCovered = coveredByCount(e.occurredAt);
    db.transaction(() => {
      if (!oldCovered) {
        returnStock(db, {
          itemId: current.item_id, type: 'waste', qty: current.qty, occurredAt: current.occurred_at,
          note: `Waste entry corrected (was ${current.qty})`, source: 'waste', sourceId: current.id, fromEventIds: eventsOf(current.id),
        });
      }
      if (!newCovered) {
        applyEventWithConsumption(db, {
          itemId: current.item_id, type: 'waste', qtyDelta: -e.qty, occurredAt: e.occurredAt, note: e.reason || e.note || null,
          source: 'waste', sourceId: current.id,
        });
      }
      db.prepare('UPDATE waste_entries SET qty = ?, occurred_at = ?, shift = ?, reason = ?, note = ?, ood = ? WHERE id = ?')
        .run(e.qty, e.occurredAt, e.shift, e.reason, e.note, e.ood, current.id);
    })();
    res.json({ ...db.prepare('SELECT * FROM waste_entries WHERE id = ?').get(current.id), stockChanged: !(oldCovered && newCovered) });
  });

  // Delete a waste entry logged by mistake: its stock goes back where it came from. The entry is kept, marked deleted.
  router.delete('/:id', requireManager, (req, res) => {
    const current = getEntry.get(Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'not found' });
    const stockChanged = !coveredByCount(current.occurred_at);
    db.transaction(() => {
      if (stockChanged) {
        returnStock(db, {
          itemId: current.item_id, type: 'waste', qty: current.qty, occurredAt: current.occurred_at,
          note: `Waste entry deleted (${current.qty}${current.reason ? ', ' + current.reason : ''})`,
          source: 'waste', sourceId: current.id, fromEventIds: eventsOf(current.id),
        });
      }
      db.prepare("UPDATE waste_entries SET deleted_at = datetime('now') WHERE id = ?").run(current.id);
    })();
    res.json({ deleted: current.id, stockChanged });
  });

  // Expired stock still sitting in inventory, waiting to be logged as out-of-date waste.
  router.get('/expired-stock', (req, res) => {
    res.json(expiredStock(db, getToday()));
  });

  router.get('/', (req, res) => {
    const { from, to } = req.query;
    const select = `
      SELECT w.*, items.name AS item_name, items.unit_label, items.supplier_unit, items.items_per_order_unit, users.name AS created_by_name
      FROM waste_entries w JOIN items ON items.id = w.item_id LEFT JOIN users ON users.id = w.created_by
      WHERE w.deleted_at IS NULL`;
    const rows = db.prepare(`${select} AND w.occurred_at >= ? AND w.occurred_at <= ? ORDER BY w.occurred_at DESC, w.id DESC`)
      .all(isDate(from) ? from : '0000-00-00', isDate(to) ? to : '9999-12-31');
    res.json(rows);
  });

  return router;
}

module.exports = { createWasteRouter };
