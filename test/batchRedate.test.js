const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createBatchesRouter } = require('../routes/batches');
const { applyEvent, getOnHand } = require('../ledger/ledger');

// Beef Patty, 180 a case: 9 cases use by the 27th from a delivery on the 23rd.
function startServer() {
  const db = getDb(':memory:');
  const itemId = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, track_use_by)
    VALUES ('Beef Patty', 'Walk In Fridge', 'Each', 180, 1)`).run().lastInsertRowid;
  const deliveryId = db.prepare("INSERT INTO deliveries (delivered_at) VALUES ('2026-09-23')").run().lastInsertRowid;
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 9, occurredAt: '2026-09-23' });
  const batchId = db.prepare(`INSERT INTO batches (item_id, delivery_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, ?, '2026-09-23', 4, '2026-09-27', 9)`).run(itemId, deliveryId).lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/batches', createBatchesRouter(db, { today: () => '2026-09-24' }));
  const server = app.listen(0);
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { db, server, itemId, deliveryId, batchId, post };
}

test('POST /api/batches/:id/split gives part of a batch a new date and leaves stock on hand alone', async () => {
  const { db, server, itemId, deliveryId, batchId, post } = startServer();
  const res = await post(`/api/batches/${batchId}/split`, { qty: 2, useByDate: '2026-09-26' });
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.strictEqual(body.whole, false);
  const rows = db.prepare('SELECT * FROM batches WHERE item_id = ? ORDER BY use_by_date').all(itemId);
  assert.deepStrictEqual(rows.map(r => [r.use_by_date, r.qty_remaining]), [['2026-09-26', 2], ['2026-09-27', 7]]);
  assert.strictEqual(rows[0].delivery_id, deliveryId); // still shows under its delivery
  assert.strictEqual(rows[0].received_at, '2026-09-23');
  assert.strictEqual(rows[0].redated_at, '2026-09-24');
  assert.strictEqual(rows[1].redated_at, null);
  assert.strictEqual(getOnHand(db, itemId), 9);
  server.close();
});

test('POST /api/batches/:id/split with the whole batch just re-dates it', async () => {
  const { db, server, itemId, batchId, post } = startServer();
  const res = await post(`/api/batches/${batchId}/split`, { qty: 9, useByDate: '2026-09-25' });
  assert.strictEqual((await res.json()).whole, true);
  const rows = db.prepare('SELECT * FROM batches WHERE item_id = ?').all(itemId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].use_by_date, '2026-09-25');
  assert.strictEqual(rows[0].redated_at, '2026-09-24');
  assert.strictEqual(getOnHand(db, itemId), 9);
  server.close();
});

test('POST /api/batches/:id/split rejects more than the batch holds, a bad date or no quantity', async () => {
  const { db, server, itemId, batchId, post } = startServer();
  assert.strictEqual((await post(`/api/batches/${batchId}/split`, { qty: 10, useByDate: '2026-09-26' })).status, 400);
  assert.strictEqual((await post(`/api/batches/${batchId}/split`, { qty: 2, useByDate: '26/09/2026' })).status, 400);
  assert.strictEqual((await post(`/api/batches/${batchId}/split`, { qty: 0, useByDate: '2026-09-26' })).status, 400);
  assert.strictEqual((await post('/api/batches/999/split', { qty: 1, useByDate: '2026-09-26' })).status, 404);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM batches WHERE item_id = ?').get(itemId).n, 1);
  server.close();
});

test('the shelf life learned from deliveries ignores batches given a new date by hand', async () => {
  const { learnedShelfLife } = require('../routes/orders');
  const { db, server, itemId, batchId, post } = startServer();
  assert.strictEqual(learnedShelfLife(db)[itemId], 5); // received the 23rd, use by the 27th
  await post(`/api/batches/${batchId}/split`, { qty: 2, useByDate: '2026-09-24' });
  assert.strictEqual(learnedShelfLife(db)[itemId], 5);
  server.close();
});
