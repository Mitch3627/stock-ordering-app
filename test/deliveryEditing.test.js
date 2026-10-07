const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createDeliveriesRouter } = require('../routes/deliveries');
const { getOnHand } = require('../ledger/ledger');

function setup() {
  const db = getDb(':memory:');
  const beef = db.prepare(`INSERT INTO items (name, category, unit_label, track_use_by) VALUES ('Beef Patty', 'Chiller', 'Each', 1)`).run().lastInsertRowid;
  const fries = db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Fries', 'Freezer', 'Box')`).run().lastInsertRowid;
  const cups = db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Cups', 'Dry Store', 'Each')`).run().lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/deliveries', createDeliveriesRouter(db));
  const server = app.listen(0);
  return { db, server, beef, fries, cups, base: `http://127.0.0.1:${server.address().port}/api/deliveries` };
}
const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('a logged delivery records when it was created', async () => {
  const { db, server, base, fries } = setup();
  const res = await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: fries, qty: 5 }] });
  const { id } = await res.json();
  const row = db.prepare('SELECT created_at FROM deliveries WHERE id = ?').get(id);
  assert.ok(row.created_at, 'created_at should be set');
  server.close(); db.close();
});

test('editing a line with a batch adjusts that exact batch and on-hand together', async () => {
  const { db, server, base, beef } = setup();
  await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: beef, qty: 6, useByDate: '2026-09-25' }] });
  const res = await send('PUT', `${base}/1/lines/${beef}`, { qty: 4 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(getOnHand(db, beef), 4);
  assert.strictEqual(db.prepare('SELECT qty_remaining FROM batches WHERE delivery_id = 1 AND item_id = ?').get(beef).qty_remaining, 4);
  assert.strictEqual(db.prepare('SELECT qty FROM delivery_lines WHERE delivery_id = 1 AND item_id = ?').get(beef).qty, 4);
  server.close(); db.close();
});

test('editing a line with no batch just corrects the ledger', async () => {
  const { db, server, base, fries } = setup();
  await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: fries, qty: 5 }] });
  const res = await send('PUT', `${base}/1/lines/${fries}`, { qty: 9 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(getOnHand(db, fries), 9);
  server.close(); db.close();
});

test('editing rejects a negative quantity or an unknown line', async () => {
  const { db, server, base, fries, cups } = setup();
  await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: fries, qty: 5 }] });
  assert.strictEqual((await send('PUT', `${base}/1/lines/${fries}`, { qty: -1 })).status, 400);
  assert.strictEqual((await send('PUT', `${base}/1/lines/${cups}`, { qty: 2 })).status, 404);
  server.close(); db.close();
});

test('removing a line that was ordered keeps a zero record; one that was added later is deleted outright', async () => {
  const { db, server, base, beef, fries, cups } = setup();
  db.prepare("INSERT INTO order_confirmations (delivery_date) VALUES ('2026-09-21')").run();
  db.prepare('INSERT INTO confirmed_order_lines (delivery_date, item_id, qty) VALUES (?, ?, ?)').run('2026-09-21', beef, 6);
  await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: beef, qty: 6, useByDate: '2026-09-25' }, { itemId: fries, qty: 5 }] });
  await send('POST', `${base}/1/lines`, { itemId: cups, qty: 3 }); // added after the fact, no ordered_qty

  await send('DELETE', `${base}/1/lines/${beef}`);
  assert.strictEqual(getOnHand(db, beef), 0);
  assert.deepStrictEqual(db.prepare('SELECT qty, ordered_qty FROM delivery_lines WHERE delivery_id = 1 AND item_id = ?').get(beef), { qty: 0, ordered_qty: 6 });

  await send('DELETE', `${base}/1/lines/${cups}`);
  assert.strictEqual(getOnHand(db, cups), 0);
  assert.strictEqual(db.prepare('SELECT * FROM delivery_lines WHERE delivery_id = 1 AND item_id = ?').get(cups), undefined);
  server.close(); db.close();
});

test('adding a new item to an already-logged delivery increases stock and can carry a use-by date', async () => {
  const { db, server, base, fries, beef } = setup();
  await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: fries, qty: 5 }] });
  const res = await send('POST', `${base}/1/lines`, { itemId: beef, qty: 2, useByDate: '2026-09-24' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(getOnHand(db, beef), 2);
  const batch = db.prepare('SELECT * FROM batches WHERE delivery_id = 1 AND item_id = ?').get(beef);
  assert.strictEqual(batch.qty_remaining, 2);
  assert.strictEqual(batch.use_by_date, '2026-09-24');
  server.close(); db.close();
});

test('a tracked item can be added without a use-by date (dated later); adding more of an item already there tops it up', async () => {
  const { db, server, base, fries, beef } = setup();
  await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: fries, qty: 5 }] });
  assert.strictEqual((await send('POST', `${base}/1/lines`, { itemId: beef, qty: 2 })).status, 201);
  assert.strictEqual(getOnHand(db, beef), 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM batches').get().c, 0); // undated until the use-by pop-up
  assert.strictEqual((await send('POST', `${base}/1/lines`, { itemId: fries, qty: 1 })).status, 201);
  assert.deepStrictEqual(db.prepare('SELECT qty FROM delivery_lines WHERE item_id = ?').all(fries), [{ qty: 6 }]);
  assert.strictEqual(getOnHand(db, fries), 6);
  server.close(); db.close();
});

test('GET /api/deliveries includes when it was logged and each line\'s use-by date', async () => {
  const { db, server, base, beef } = setup();
  await send('POST', base, { deliveredAt: '2026-09-21', lines: [{ itemId: beef, qty: 6, useByDate: '2026-09-25' }] });
  const list = await (await fetch(base)).json();
  assert.ok(list[0].created_at);
  assert.strictEqual(list[0].lines[0].use_by_date, '2026-09-25');
  server.close(); db.close();
});
