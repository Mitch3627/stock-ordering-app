const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createDeliveriesRouter } = require('../routes/deliveries');
const { getOnHand } = require('../ledger/ledger');

function startServer() {
  const db = getDb(':memory:');
  const perishable = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, shelf_life_days)
    VALUES ('Fruit Pots', 'Packaging', 'Box', 1, 2.5)`).run().lastInsertRowid;
  const shelfStable = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit)
    VALUES ('Fries', 'Freezer', 'Box', 1)`).run().lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/deliveries', createDeliveriesRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  return { db, server, base: `http://127.0.0.1:${port}`, perishable, shelfStable };
}

test('POST /api/deliveries updates the ledger for each line', async () => {
  const { server, base, db, perishable, shelfStable } = startServer();
  const res = await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deliveredAt: '2026-09-14',
      lines: [{ itemId: perishable, qty: 2 }, { itemId: shelfStable, qty: 10 }],
    }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(getOnHand(db, perishable), 2);
  assert.strictEqual(getOnHand(db, shelfStable), 10);
  server.close();
  db.close();
});

test('POST /api/deliveries creates a batch for items with shelf_life_days', async () => {
  const { server, base, db, perishable } = startServer();
  await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-14', lines: [{ itemId: perishable, qty: 2 }] }),
  });
  const batch = db.prepare('SELECT * FROM batches WHERE item_id = ?').get(perishable);
  assert.strictEqual(batch.qty_remaining, 2);
  assert.strictEqual(batch.use_by_date, '2026-09-16'); // 14 Sep + 2.5 days, floored to the date
  server.close();
  db.close();
});

test('POST /api/deliveries does not create a batch for items with no shelf_life_days', async () => {
  const { server, base, db, shelfStable } = startServer();
  await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-14', lines: [{ itemId: shelfStable, qty: 10 }] }),
  });
  const batch = db.prepare('SELECT * FROM batches WHERE item_id = ?').get(shelfStable);
  assert.strictEqual(batch, undefined);
  server.close();
  db.close();
});

test('GET /api/deliveries lists deliveries with their lines', async () => {
  const { server, base, perishable } = startServer();
  await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-14', note: 'Monday drop', lines: [{ itemId: perishable, qty: 2 }] }),
  });
  const list = await (await fetch(`${base}/api/deliveries`)).json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].note, 'Monday drop');
  assert.strictEqual(list[0].lines.length, 1);
  assert.strictEqual(list[0].lines[0].qty, 2);
  server.close();
});

test('POST /api/deliveries uses an explicit useByDate over the shelf-life default', async () => {
  const { server, base, db, perishable } = startServer();
  await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-14', lines: [{ itemId: perishable, qty: 2, useByDate: '2026-09-15' }] }),
  });
  const batch = db.prepare('SELECT * FROM batches WHERE item_id = ?').get(perishable);
  assert.strictEqual(batch.use_by_date, '2026-09-15');
  assert.strictEqual(batch.shelf_life_days, 1);
  server.close();
  db.close();
});

test('POST /api/deliveries creates a batch for an untracked item when useByDate is given', async () => {
  const { server, base, db, shelfStable } = startServer();
  await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-14', lines: [{ itemId: shelfStable, qty: 4, useByDate: '2026-09-20' }] }),
  });
  const batch = db.prepare('SELECT * FROM batches WHERE item_id = ?').get(shelfStable);
  assert.strictEqual(batch.use_by_date, '2026-09-20');
  assert.strictEqual(batch.qty_remaining, 4);
  server.close();
  db.close();
});

test('POST /api/deliveries rejects a malformed useByDate', async () => {
  const { server, base, db, perishable } = startServer();
  const res = await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-14', lines: [{ itemId: perishable, qty: 2, useByDate: '15/09' }] }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM deliveries').get().c, 0);
  server.close();
  db.close();
});

test('POST /api/deliveries accepts a use-by tracked item without its date; the stock waits undated', async () => {
  const { server, base, db, shelfStable } = startServer();
  db.prepare('UPDATE items SET track_use_by = 1 WHERE id = ?').run(shelfStable);
  const res = await fetch(`${base}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-14', lines: [{ itemId: shelfStable, qty: 4 }] }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(getOnHand(db, shelfStable), 4);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM batches').get().c, 0);
  server.close();
  db.close();
});
