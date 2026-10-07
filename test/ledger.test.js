const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');
const { applyEvent, applyEventWithConsumption, returnStock, getOnHand, getAllOnHand } = require('../ledger/ledger');

function makeDbWithItem() {
  const db = getDb(':memory:');
  const info = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit)
              VALUES (?, ?, ?, ?)`).run('Fries', 'Freezer', 'Box', 1);
  return { db, itemId: info.lastInsertRowid };
}

test('applyEvent on a fresh item creates the ledger row', () => {
  const { db, itemId } = makeDbWithItem();
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-14', note: 'first delivery' });
  assert.strictEqual(getOnHand(db, itemId), 10);
  db.close();
});

test('applyEvent accumulates across multiple events', () => {
  const { db, itemId } = makeDbWithItem();
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-14' });
  applyEvent(db, { itemId, type: 'waste', qtyDelta: -2, occurredAt: '2026-09-15' });
  applyEvent(db, { itemId, type: 'usage_decay', qtyDelta: -3, occurredAt: '2026-09-16' });
  assert.strictEqual(getOnHand(db, itemId), 5);
  db.close();
});

test('applyEvent writes an inventory_events row for every call', () => {
  const { db, itemId } = makeDbWithItem();
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-14' });
  applyEvent(db, { itemId, type: 'waste', qtyDelta: -2, occurredAt: '2026-09-15' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM inventory_events WHERE item_id = ?').get(itemId).c;
  assert.strictEqual(count, 2);
  db.close();
});

test('getOnHand returns 0 for an item with no ledger row', () => {
  const { db, itemId } = makeDbWithItem();
  assert.strictEqual(getOnHand(db, itemId), 0);
  db.close();
});

test('applyEvent rejects an unknown event type', () => {
  const { db, itemId } = makeDbWithItem();
  assert.throws(() => applyEvent(db, { itemId, type: 'made_up', qtyDelta: 1, occurredAt: '2026-09-14' }));
  db.close();
});

test('getAllOnHand returns a map of every item with a ledger row', () => {
  const db = getDb(':memory:');
  const a = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit) VALUES ('A','Dry Store','Box',1)`).run().lastInsertRowid;
  const b = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit) VALUES ('B','Dry Store','Box',1)`).run().lastInsertRowid;
  applyEvent(db, { itemId: a, type: 'delivery', qtyDelta: 5, occurredAt: '2026-09-14' });
  applyEvent(db, { itemId: b, type: 'delivery', qtyDelta: 7, occurredAt: '2026-09-14' });
  const all = getAllOnHand(db);
  assert.strictEqual(all[a], 5);
  assert.strictEqual(all[b], 7);
  db.close();
});

test('applyEventWithConsumption behaves like applyEvent when qtyDelta is positive', () => {
  const { db, itemId } = makeDbWithItem();
  applyEventWithConsumption(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-18' });
  assert.strictEqual(getOnHand(db, itemId), 10);
  db.close();
});

test('applyEventWithConsumption falls back to a plain event when the item has no batches', () => {
  const { db, itemId } = makeDbWithItem();
  applyEventWithConsumption(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-18' });
  applyEventWithConsumption(db, { itemId, type: 'waste', qtyDelta: -3, occurredAt: '2026-09-19' });
  assert.strictEqual(getOnHand(db, itemId), 7);
  db.close();
});

test('applyEventWithConsumption consumes the soonest-expiring batch first', () => {
  const { db, itemId } = makeDbWithItem();
  applyEventWithConsumption(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-10' });
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-10', 5, '2026-09-15', 4)
  `).run(itemId);
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-10', 10, '2026-09-20', 6)
  `).run(itemId);

  applyEventWithConsumption(db, { itemId, type: 'usage_decay', qtyDelta: -7, occurredAt: '2026-09-18' });

  const soon = db.prepare("SELECT qty_remaining FROM batches WHERE use_by_date = '2026-09-15'").get();
  const later = db.prepare("SELECT qty_remaining FROM batches WHERE use_by_date = '2026-09-20'").get();
  assert.strictEqual(soon.qty_remaining, 0);
  assert.strictEqual(later.qty_remaining, 3); // 6 - (7 - 4)
  assert.strictEqual(getOnHand(db, itemId), 3); // 10 - 7
  db.close();
});

test('applyEventWithConsumption moves the batch and the ledger by exactly the same amount', () => {
  const { db, itemId } = makeDbWithItem();
  applyEventWithConsumption(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-10' });
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-10', 5, '2026-09-15', 10)
  `).run(itemId);

  // 3.333... doesn't divide evenly: it is taken to 6 decimal places, and that same figure comes off both.
  applyEventWithConsumption(db, { itemId, type: 'usage_decay', qtyDelta: -(10 / 3), occurredAt: '2026-09-18' });

  const batch = db.prepare("SELECT qty_remaining FROM batches WHERE use_by_date = '2026-09-15'").get();
  assert.strictEqual(batch.qty_remaining, 6.666667);
  assert.strictEqual(getOnHand(db, itemId), 6.666667);
  db.close();
});

test('many small uses never let dated stock drift away from on-hand, and tiny daily usage is not rounded away', () => {
  const { db, itemId } = makeDbWithItem();
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 1, occurredAt: '2026-09-10' });
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-10', 5, '2026-09-30', 1)`).run(itemId);
  for (let i = 0; i < 4; i++) applyEventWithConsumption(db, { itemId, type: 'usage_decay', qtyDelta: -0.125, occurredAt: '2026-09-11' });
  for (let i = 0; i < 10; i++) applyEventWithConsumption(db, { itemId, type: 'usage_decay', qtyDelta: -0.0127, occurredAt: '2026-09-12' });
  const batch = db.prepare('SELECT qty_remaining FROM batches').get().qty_remaining;
  assert.strictEqual(getOnHand(db, itemId), 0.373); // 1 - 0.5 - 0.127: the 0.0127s are not rounded down to 0.01
  assert.strictEqual(batch, 0.373);
  db.close();
});

test('dated stock is trimmed (oldest first) so it can never be more than the stock on hand', () => {
  const { db, itemId } = makeDbWithItem();
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: -0.6, occurredAt: '2026-09-10' }); // the ledger had drifted negative
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 1, occurredAt: '2026-09-11' });
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-11', 2, '2026-09-13', 1)`).run(itemId);
  applyEvent(db, { itemId, type: 'count_correction', qtyDelta: 0, occurredAt: '2026-09-11' });
  assert.strictEqual(db.prepare('SELECT qty_remaining FROM batches').get().qty_remaining, 0.4);
  db.close();
});

test('returnStock puts stock back into the batches an earlier event took it from', () => {
  const { db, itemId } = makeDbWithItem();
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 14, occurredAt: '2026-09-20' });
  const ins = db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, '2026-09-20', 5, ?, ?)`);
  const a = ins.run(itemId, '2026-09-24', 5).lastInsertRowid;
  const b = ins.run(itemId, '2026-09-27', 9).lastInsertRowid;
  const typo = applyEventWithConsumption(db, { itemId, type: 'usage_decay', qtyDelta: -12, occurredAt: '2026-09-21' }); // A 0, B 2
  returnStock(db, { itemId, type: 'usage_decay', qty: 10, occurredAt: '2026-09-21', fromEventIds: [typo] });
  const qty = (id) => db.prepare('SELECT qty_remaining FROM batches WHERE id = ?').get(id).qty_remaining;
  assert.deepStrictEqual([qty(a), qty(b), getOnHand(db, itemId)], [3, 9, 12]); // exactly as if only 2 had been used
  db.close();
});

test('applyEventWithConsumption consumes the oldest batch first when use-by dates tie', () => {
  const { getDb } = require('../db/connection');
  const { applyEvent, applyEventWithConsumption } = require('../ledger/ledger');
  const db = getDb(':memory:');
  const id = db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Beef', 'Chiller', 'Each')`).run().lastInsertRowid;
  const ins = db.prepare('INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, ?, 1, ?, 5)');
  ins.run(id, '2026-09-15', '2026-09-20'); // later received, inserted first
  ins.run(id, '2026-09-14', '2026-09-20');
  applyEvent(db, { itemId: id, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-15' });
  applyEventWithConsumption(db, { itemId: id, type: 'waste', qtyDelta: -3, occurredAt: '2026-09-16' });
  const rows = db.prepare('SELECT received_at, qty_remaining FROM batches ORDER BY received_at').all();
  assert.deepStrictEqual(rows.map(r => r.qty_remaining), [2, 5]);
  db.close();
});
