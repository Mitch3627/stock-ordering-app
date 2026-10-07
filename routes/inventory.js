const express = require('express');
const { requireManager } = require('../lib/auth');
const { applyEvent, applyEventWithConsumption, getOnHand } = require('../ledger/ledger');
const { todayLocal } = require('../lib/dates');

// Manual correction of an item's on-hand quantity. The ledger stays the single source of truth:
// this writes a count_correction event rather than overwriting the number.
function createInventoryRouter(db) {
  const router = express.Router();

  router.post('/adjust', requireManager, (req, res) => {
    const { itemId, qty, unit } = req.body;
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'not found' });
    if (!(qty >= 0)) return res.status(400).json({ error: 'qty must be 0 or more' });

    // Quantities are typed in the supplier's unit by default; "order" means order units directly.
    const perOrder = item.items_per_order_unit > 0 ? item.items_per_order_unit : 1;
    const target = unit === 'order' ? qty : qty / perOrder;
    const current = getOnHand(db, itemId);
    const delta = Math.round((target - current) * 1e6) / 1e6;
    if (delta !== 0) {
      const event = {
        itemId, type: 'count_correction', qtyDelta: delta,
        occurredAt: todayLocal(),
        note: `Manual edit: on hand ${Math.round(current * 1000) / 1000} -> ${Math.round(target * 1000) / 1000} order units`,
      };
      // Reductions come off the oldest batch first, like any other stock leaving.
      if (delta < 0) applyEventWithConsumption(db, event); else applyEvent(db, event);
    }
    res.json({ itemId, onHand: getOnHand(db, itemId) });
  });

  return router;
}

module.exports = { createInventoryRouter };
