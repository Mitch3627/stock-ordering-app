const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createInventoryRouter } = require('../routes/inventory');
const { createBatchesRouter } = require('../routes/batches');
const { applyEvent, applyEventWithConsumption, getOnHand } = require('../ledger/ledger');

function setup() {
  const db = getDb(':memory:');
  const beef = db.prepare(`INSERT INTO items (name, category, unit_label, supplier_unit, items_per_order_unit, track_use_by)
    VALUES ('Beef Patty', 'Chiller', 'Each', 'Each', 180, 1)`).run().lastInsertRowid;
  applyEvent(db, { itemId: beef, type: 'count_correction', qtyDelta: 8, occurredAt: '2026-09-20' });
  const ins = db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, '2026-09-20', 3, ?, ?)`);
  const b1 = ins.run(beef, '2026-09-22', 2).lastInsertRowid; // 6 of the 8 are dated
  const b2 = ins.run(beef, '2026-09-25', 4).lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use(asManager);
  const opts = { today: () => '2026-09-21' };
  app.use('/api/inventory', createInventoryRouter(db));
  app.use('/api/batches', createBatchesRouter(db, opts));
  const server = app.listen(0);
  return { db, server, beef, b1, b2, base: `http://127.0.0.1:${server.address().port}/api` };
}
const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('reducing more than the dated batches holds removes the whole amount from on-hand', () => {
  const db = getDb(':memory:');
  const id = db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Butter', 'Chiller', 'Each')`).run().lastInsertRowid;
  applyEvent(db, { itemId: id, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-20' });
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, '2026-09-20', 3, '2026-09-25', 4)`).run(id);
  applyEventWithConsumption(db, { itemId: id, type: 'waste', qtyDelta: -6, occurredAt: '2026-09-21' });
  assert.strictEqual(getOnHand(db, id), 4); // 10 - 6, not 10 - 4
  assert.strictEqual(db.prepare('SELECT qty_remaining FROM batches').get().qty_remaining, 0);
  db.close();
});

test('POST /api/inventory/adjust sets on-hand from a supplier-unit quantity', async () => {
  const { db, server, base, beef } = setup();
  // 900 Each = 5 order units (180 per order unit); currently 8
  const res = await send('POST', `${base}/inventory/adjust`, { itemId: beef, qty: 900 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(getOnHand(db, beef), 5);
  // 3 order units came off: undated (2) first is NOT assumed - the oldest dated batch shrinks first
  const rows = db.prepare('SELECT qty_remaining FROM batches ORDER BY use_by_date').all().map(r => r.qty_remaining);
  assert.strictEqual(rows.reduce((a, b) => a + b, 0) <= 5, true);
  const up = await send('POST', `${base}/inventory/adjust`, { itemId: beef, qty: 7, unit: 'order' });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(getOnHand(db, beef), 7);
  assert.strictEqual((await send('POST', `${base}/inventory/adjust`, { itemId: beef, qty: -1 })).status, 400);
  server.close(); db.close();
});

test('PUT /api/batches/:id changes the use-by date and the quantity, keeping on-hand in step', async () => {
  const { db, server, base, beef, b1 } = setup();
  let res = await send('PUT', `${base}/batches/${b1}`, { use_by_date: '2026-09-23' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.prepare('SELECT use_by_date FROM batches WHERE id = ?').get(b1).use_by_date, '2026-09-23');
  assert.strictEqual(getOnHand(db, beef), 8);
  res = await send('PUT', `${base}/batches/${b1}`, { qty_remaining: 1.5 }); // 2 -> 1.5: stock down 0.5
  assert.strictEqual(res.status, 200);
  assert.strictEqual(getOnHand(db, beef), 7.5);
  server.close(); db.close();
});

test('PUT /api/batches/:id rejects a bad date or negative quantity', async () => {
  const { db, server, base, b1 } = setup();
  assert.strictEqual((await send('PUT', `${base}/batches/${b1}`, { use_by_date: '23/09' })).status, 400);
  assert.strictEqual((await send('PUT', `${base}/batches/${b1}`, { qty_remaining: -1 })).status, 400);
  assert.strictEqual((await send('PUT', `${base}/batches/9999`, { qty_remaining: 1 })).status, 404);
  server.close(); db.close();
});

test('GET /api/batches includes the unit details needed to show quantities in supplier units', async () => {
  const { db, server, base } = setup();
  const rows = await (await fetch(`${base}/batches`)).json();
  assert.deepStrictEqual([rows[0].items_per_order_unit, rows[0].supplier_unit, rows[0].item_id !== undefined], [180, 'Each', true]);
  server.close(); db.close();
});
