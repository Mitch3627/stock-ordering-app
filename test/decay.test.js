const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');
const { getOnHand } = require('../ledger/ledger');
const { applyDailyDecay } = require('../ledger/decay');

function makeDb() {
  const db = getDb(':memory:');
  const friesId = db.prepare(`
    INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, active)
    VALUES ('Fries', 'Freezer', 'Box', 1, 1, 1)
  `).run().lastInsertRowid;
  return { db, friesId };
}

test('applyDailyDecay reduces an item with no batches directly on the ledger', () => {
  const { db, friesId } = makeDb();
  const { applyEvent } = require('../ledger/ledger');
  applyEvent(db, { itemId: friesId, type: 'delivery', qtyDelta: 20, occurredAt: '2026-09-17' });

  applyDailyDecay(db, { date: '2026-09-18', actualSales: 1000 }); // decay = 1 * (1000/100) = 10

  assert.strictEqual(getOnHand(db, friesId), 10);
  db.close();
});

test('applyDailyDecay skips inactive items', () => {
  const { db, friesId } = makeDb();
  db.prepare('UPDATE items SET active = 0 WHERE id = ?').run(friesId);
  const { applyEvent } = require('../ledger/ledger');
  applyEvent(db, { itemId: friesId, type: 'delivery', qtyDelta: 20, occurredAt: '2026-09-17' });

  applyDailyDecay(db, { date: '2026-09-18', actualSales: 1000 });

  assert.strictEqual(getOnHand(db, friesId), 20); // unchanged
  db.close();
});

test('applyDailyDecay consumes the soonest-expiring batch for a shelf-life item', () => {
  const db = getDb(':memory:');
  const eggsId = db.prepare(`
    INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, active, shelf_life_days)
    VALUES ('Fresh Eggs', 'Chiller', 'Box', 1, 1, 1, 7)
  `).run().lastInsertRowid;
  const { applyEvent } = require('../ledger/ledger');
  applyEvent(db, { itemId: eggsId, type: 'delivery', qtyDelta: 5, occurredAt: '2026-09-11' });
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-11', 7, '2026-09-18', 5)
  `).run(eggsId);

  applyDailyDecay(db, { date: '2026-09-18', actualSales: 200 }); // decay = 1 * (200/100) = 2

  const batch = db.prepare('SELECT qty_remaining FROM batches WHERE item_id = ?').get(eggsId);
  assert.strictEqual(batch.qty_remaining, 3);
  assert.strictEqual(getOnHand(db, eggsId), 3);
  db.close();
});
