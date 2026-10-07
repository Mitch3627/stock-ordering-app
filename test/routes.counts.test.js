const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createCountsRouter } = require('../routes/counts');
const { applyEvent, getOnHand } = require('../ledger/ledger');

function startServer() {
  const db = getDb(':memory:');
  const itemId = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit)
    VALUES ('Shredded Cheese', 'Chiller', 'Box', 10)`).run().lastInsertRowid;
  applyEvent(db, { itemId, type: 'delivery', qtyDelta: 3, occurredAt: '2026-09-10' }); // expected 3 boxes
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/counts', createCountsRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  return { db, server, base: `http://127.0.0.1:${port}`, itemId };
}

test('POST /api/counts/preview computes variance without changing the ledger', async () => {
  const { server, base, db, itemId } = startServer();
  const res = await fetch(`${base}/api/counts/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: [{ itemId, countedQty: 25, unit: 'native' }] }), // 25 bags = 2.5 boxes
  });
  const preview = await res.json();
  assert.strictEqual(preview[0].convertedQty, 2.5);
  assert.strictEqual(preview[0].expectedQty, 3);
  assert.strictEqual(preview[0].variance, -0.5);
  assert.strictEqual(getOnHand(db, itemId), 3); // unchanged
  server.close();
  db.close();
});

test('POST /api/counts commits and snaps the ledger to the counted value', async () => {
  const { server, base, db, itemId } = startServer();
  await fetch(`${base}/api/counts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countedAt: '2026-09-14', lines: [{ itemId, countedQty: 25, unit: 'native' }] }),
  });
  assert.strictEqual(getOnHand(db, itemId), 2.5);
  const countRow = db.prepare('SELECT * FROM counts').get();
  assert.strictEqual(countRow.counted_at, '2026-09-14');
  const lineRow = db.prepare('SELECT * FROM count_lines WHERE count_id = ?').get(countRow.id);
  assert.strictEqual(lineRow.variance, -0.5);
  server.close();
  db.close();
});

test('POST /api/counts consumes the soonest-expiring batch when the counted variance is negative', async () => {
  const { server, base, db, itemId } = startServer();
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-10', 5, '2026-09-15', 1)
  `).run(itemId);
  db.prepare(`
    INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-10', 10, '2026-09-20', 2)
  `).run(itemId);

  // Counted 5 bags = 0.5 boxes; expected (from delivery + both batches worth of on-hand,
  // i.e. the ledger's 3 boxes) is 3, so variance = 0.5 - 3 = -2.5.
  await fetch(`${base}/api/counts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countedAt: '2026-09-14', lines: [{ itemId, countedQty: 5, unit: 'native' }] }),
  });

  const soon = db.prepare("SELECT qty_remaining FROM batches WHERE use_by_date = '2026-09-15'").get();
  const later = db.prepare("SELECT qty_remaining FROM batches WHERE use_by_date = '2026-09-20'").get();
  assert.strictEqual(soon.qty_remaining, 0); // 1 - 1, soonest batch drained first
  assert.strictEqual(later.qty_remaining, 0.5); // 2 - (2.5 - 1)
  assert.strictEqual(getOnHand(db, itemId), 0.5);
  server.close();
  db.close();
});
