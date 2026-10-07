const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createWasteRouter } = require('../routes/waste');
const { applyEvent, getOnHand } = require('../ledger/ledger');

function startServer() {
  const db = getDb(':memory:');
  const itemId = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit)
    VALUES ('Bacon', 'Chiller', 'Box', 1)`).run().lastInsertRowid;
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-14' });
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/waste', createWasteRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  return { db, server, base: `http://127.0.0.1:${port}`, itemId };
}

test('POST /api/waste subtracts from the ledger', async () => {
  const { server, base, db, itemId } = startServer();
  const res = await fetch(`${base}/api/waste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, qty: 1.5, occurredAt: '2026-09-15', shift: 'close', reason: 'out of date' }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(getOnHand(db, itemId), 8.5);
  server.close();
  db.close();
});

test('POST /api/waste rejects an invalid shift', async () => {
  const { server, base, itemId } = startServer();
  const res = await fetch(`${base}/api/waste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, qty: 1, occurredAt: '2026-09-15', shift: 'afternoon' }),
  });
  assert.strictEqual(res.status, 400);
  server.close();
});

test('GET /api/waste filters by date range', async () => {
  const { server, base, itemId } = startServer();
  await fetch(`${base}/api/waste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, qty: 1, occurredAt: '2026-09-10', shift: 'open' }),
  });
  await fetch(`${base}/api/waste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, qty: 2, occurredAt: '2026-09-15', shift: 'close' }),
  });
  const res = await fetch(`${base}/api/waste?from=2026-09-14&to=2026-09-20`);
  const list = await res.json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].qty, 2);
  server.close();
});

test('POST /api/waste consumes the soonest-expiring batch when the item has one', async () => {
  const { server, base, db, itemId } = startServer();
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-14', 5, '2026-09-19', 4)
  `).run(itemId);
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-14', 10, '2026-09-24', 6)
  `).run(itemId);

  await fetch(`${base}/api/waste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, qty: 2, occurredAt: '2026-09-16', shift: 'close', reason: 'dropped' }),
  });

  const soon = db.prepare("SELECT qty_remaining FROM batches WHERE use_by_date = '2026-09-19'").get();
  assert.strictEqual(soon.qty_remaining, 2); // 4 - 2, taken from the soonest batch first
  server.close();
  db.close();
});
