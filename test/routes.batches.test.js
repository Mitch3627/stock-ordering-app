const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { getDb } = require('../db/connection');
const { createBatchesRouter } = require('../routes/batches');

function startServer(today) {
  const db = getDb(':memory:');
  const itemId = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit)
    VALUES ('Fruit Pots', 'Packaging', 'Box', 1)`).run().lastInsertRowid;
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-12', 2.5, '2026-09-14', 1)`).run(itemId);
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-16', 2.5, '2026-09-19', 2)`).run(itemId);
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-10', 2.5, '2026-09-12', 0)`).run(itemId); // used up, should be excluded
  const app = express();
  app.use('/api/batches', createBatchesRouter(db, { today: () => today }));
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('GET /api/batches excludes batches with zero qty_remaining', async () => {
  const { server, base } = startServer('2026-09-15');
  const list = await (await fetch(`${base}/api/batches`)).json();
  assert.strictEqual(list.length, 2);
  server.close();
});

test('GET /api/batches flags a past use_by_date as expired', async () => {
  const { server, base } = startServer('2026-09-15');
  const list = await (await fetch(`${base}/api/batches`)).json();
  const expired = list.find(b => b.use_by_date === '2026-09-14');
  assert.strictEqual(expired.status, 'expired');
  server.close();
});

test('GET /api/batches flags a use_by_date one day out as use_soon', async () => {
  const { server, base } = startServer('2026-09-18');
  const list = await (await fetch(`${base}/api/batches`)).json();
  const soon = list.find(b => b.use_by_date === '2026-09-19');
  assert.strictEqual(soon.status, 'use_soon');
  server.close();
});

test('GET /api/batches flags a far-off use_by_date as ok, and sorts ascending', async () => {
  const { server, base } = startServer('2026-09-10');
  const list = await (await fetch(`${base}/api/batches`)).json();
  assert.strictEqual(list[0].use_by_date, '2026-09-14');
  assert.strictEqual(list[1].use_by_date, '2026-09-19');
  assert.strictEqual(list[1].status, 'ok');
  server.close();
});
