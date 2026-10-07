const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createPromptsRouter } = require('../routes/prompts');
const { createBatchesRouter } = require('../routes/batches');
const { applyEvent } = require('../ledger/ledger');

function setup({ withOldCount = false } = {}) {
  const db = getDb(':memory:');
  if (withOldCount) db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-17')").run();
  // simulate opening a database that already has a stray count before this feature existed
  const { migrate } = require('../db/connection');
  db.prepare("DELETE FROM meta WHERE key = 'baseline_after_count_id'").run();
  migrate(db);
  const beef = db.prepare(`INSERT INTO items (name, category, unit_label, track_use_by)
    VALUES ('Beef Patty', 'Chiller', 'Each', 1)`).run().lastInsertRowid;
  const fries = db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Fries', 'Freezer', 'Box')`).run().lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use(asManager);
  const opts = { today: () => '2026-09-22' }; // Tuesday: no weekly count noise
  app.use('/api/prompts', createPromptsRouter(db, opts));
  app.use('/api/batches', createBatchesRouter(db, opts));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { db, server, base, beef, fries };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('first count is needed until a count is logged after the feature was introduced, ignoring an old stray count', async () => {
  const { db, server, base } = setup({ withOldCount: true });
  assert.strictEqual((await (await fetch(`${base}/prompts`)).json()).firstCount.due, true);
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-20')").run();
  assert.strictEqual((await (await fetch(`${base}/prompts`)).json()).firstCount.due, false);
  server.close(); db.close();
});

test('use-by dates are only requested after the baseline count, for tracked stock without dated batches', async () => {
  const { db, server, base, beef, fries } = setup();
  applyEvent(db, { itemId: beef, type: 'count_correction', qtyDelta: 10, occurredAt: '2026-09-20' });
  applyEvent(db, { itemId: fries, type: 'count_correction', qtyDelta: 5, occurredAt: '2026-09-20' });
  assert.deepStrictEqual((await (await fetch(`${base}/prompts`)).json()).useByNeeded, []);

  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-20')").run();
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, '2026-09-20', 3, '2026-09-23', 4)`).run(beef);
  const needed = (await (await fetch(`${base}/prompts`)).json()).useByNeeded;
  assert.deepStrictEqual(needed.map(n => [n.name, n.missing]), [['Beef Patty', 6]]);
  server.close(); db.close();
});

test('POST /api/batches creates dated batches without changing on-hand', async () => {
  const { db, server, base, beef } = setup();
  applyEvent(db, { itemId: beef, type: 'count_correction', qtyDelta: 10, occurredAt: '2026-09-20' });
  const res = await post(`${base}/batches`, { itemId: beef, lines: [{ qty: 6, useByDate: '2026-09-24' }, { qty: 4, useByDate: '2026-09-26' }] });
  assert.strictEqual(res.status, 201);
  const rows = db.prepare('SELECT use_by_date, qty_remaining FROM batches ORDER BY use_by_date').all();
  assert.deepStrictEqual(rows, [{ use_by_date: '2026-09-24', qty_remaining: 6 }, { use_by_date: '2026-09-26', qty_remaining: 4 }]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM inventory_events').get().c, 1); // just the setup event
  server.close(); db.close();
});

test('POST /api/batches rejects more than the undated stock, or a bad date', async () => {
  const { db, server, base, beef } = setup();
  applyEvent(db, { itemId: beef, type: 'count_correction', qtyDelta: 5, occurredAt: '2026-09-20' });
  assert.strictEqual((await post(`${base}/batches`, { itemId: beef, lines: [{ qty: 6, useByDate: '2026-09-24' }] })).status, 400);
  assert.strictEqual((await post(`${base}/batches`, { itemId: beef, lines: [{ qty: 2, useByDate: '24/09' }] })).status, 400);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM batches').get().c, 0);
  server.close(); db.close();
});

test('POST /api/batches/undated-stock sets the undated stock up or down without touching dated batches', async () => {
  const { db, server, base, beef } = setup();
  applyEvent(db, { itemId: beef, type: 'count_correction', qtyDelta: 10, occurredAt: '2026-09-20' });
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, '2026-09-20', 3, '2026-09-25', 4)`).run(beef);
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-20')").run(); // baseline done
  // 10 on hand, 4 dated -> 6 undated. Set the undated stock to 8.
  let res = await post(`${base}/batches/undated-stock`, { itemId: beef, qty: 8 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(require('../ledger/ledger').getOnHand(db, beef), 12);
  assert.strictEqual(db.prepare('SELECT qty_remaining FROM batches').get().qty_remaining, 4);
  // ...and down to 1 (dated batch still untouched)
  res = await post(`${base}/batches/undated-stock`, { itemId: beef, qty: 1 });
  assert.strictEqual(require('../ledger/ledger').getOnHand(db, beef), 5);
  assert.strictEqual(db.prepare('SELECT qty_remaining FROM batches').get().qty_remaining, 4);
  const need = (await (await fetch(`${base}/prompts`)).json()).useByNeeded.find(n => n.itemId === beef);
  assert.strictEqual(need.missing, 1);
  server.close(); db.close();
});

test('undated-stock rejects negatives and untracked items', async () => {
  const { db, server, base, beef, fries } = setup();
  assert.strictEqual((await post(`${base}/batches/undated-stock`, { itemId: beef, qty: -1 })).status, 400);
  assert.strictEqual((await post(`${base}/batches/undated-stock`, { itemId: fries, qty: 2 })).status, 400);
  server.close(); db.close();
});
