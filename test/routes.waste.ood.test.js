const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createWasteRouter } = require('../routes/waste');
const { applyEvent, getOnHand } = require('../ledger/ledger');

function startServer() {
  const db = getDb(':memory:');
  const bacon = db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Bacon', 'Chiller', 'Box')`).run().lastInsertRowid;
  applyEvent(db, { itemId: bacon, type: 'delivery', qtyDelta: 10, occurredAt: '2026-09-14' });
  const beef = db.prepare(`INSERT INTO items (name, category, unit_label, track_use_by)
    VALUES ('Beef Patty', 'Chiller', 'Each', 1)`).run().lastInsertRowid;
  applyEvent(db, { itemId: beef, type: 'delivery', qtyDelta: 8, occurredAt: '2026-09-14' });
  const ins = db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, '2026-09-14', 5, ?, ?)`);
  ins.run(beef, '2026-09-20', 3); // expired by 2026-09-22
  ins.run(beef, '2026-09-30', 5);
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/waste', createWasteRouter(db, { today: () => '2026-09-22' }));
  const server = app.listen(0);
  return { db, server, base: `http://127.0.0.1:${server.address().port}/api/waste`, bacon, beef };
}

const post = (base, body) => fetch(base, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ occurredAt: '2026-09-22', shift: 'open', ...body }),
});

test('expired stock stays in inventory and is listed until it is logged as out-of-date waste', async () => {
  const { db, server, base, beef } = startServer();
  const list = await (await fetch(`${base}/expired-stock`)).json();
  assert.deepStrictEqual(list.map(r => [r.item_name, r.qty, r.oldest_use_by]), [['Beef Patty', 3, '2026-09-20']]);
  assert.strictEqual(getOnHand(db, beef), 8); // nothing removed it
  server.close(); db.close();
});

test('out-of-date waste removes the expired batch first and clears it from the list', async () => {
  const { db, server, base, beef } = startServer();
  const res = await post(base, { itemId: beef, qty: 3, ood: true });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(getOnHand(db, beef), 5);
  assert.deepStrictEqual(db.prepare('SELECT use_by_date, qty_remaining FROM batches ORDER BY use_by_date').all(),
    [{ use_by_date: '2026-09-20', qty_remaining: 0 }, { use_by_date: '2026-09-30', qty_remaining: 5 }]);
  assert.strictEqual(db.prepare('SELECT ood FROM waste_entries').get().ood, 1);
  assert.deepStrictEqual(await (await fetch(`${base}/expired-stock`)).json(), []);
  server.close(); db.close();
});

test('OOD waste on an item without batches deducts normally', async () => {
  const { db, server, base, bacon } = startServer();
  await post(base, { itemId: bacon, qty: 2, ood: true });
  assert.strictEqual(getOnHand(db, bacon), 8);
  server.close(); db.close();
});

test('a batch is not expired on its use-by date itself', async () => {
  const { db, server, base } = startServer();
  db.prepare("UPDATE batches SET use_by_date = '2026-09-22' WHERE use_by_date = '2026-09-20'").run();
  assert.deepStrictEqual(await (await fetch(`${base}/expired-stock`)).json(), []);
  server.close(); db.close();
});
