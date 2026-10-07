const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createOrdersRouter } = require('../routes/orders');
const { createDeliveriesRouter } = require('../routes/deliveries');
const { createPromptsRouter } = require('../routes/prompts');

function setup(today) {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run();
  const buns = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Buns', 'Chiller', 'Each', 1, 1, 0, 2)`).run().lastInsertRowid;
  const cups = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Cups', 'Dry Store', 'Each', 1, 0, 0, 5)`).run().lastInsertRowid;
  for (const d of ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) {
    db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, 1000)').run(d);
  }
  const app = express();
  app.use(express.json());
  app.use(asManager);
  const opts = { today: () => today };
  app.use('/api/orders', createOrdersRouter(db, opts));
  app.use('/api/deliveries', createDeliveriesRouter(db));
  app.use('/api/prompts', createPromptsRouter(db, opts));
  const server = app.listen(0);
  return { db, server, buns, cups, base: `http://127.0.0.1:${server.address().port}/api` };
}
const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const confirmDirect = (db, date, lines) => {
  db.prepare('INSERT INTO order_confirmations (delivery_date) VALUES (?)').run(date);
  for (const [itemId, qty] of lines) db.prepare('INSERT INTO confirmed_order_lines (delivery_date, item_id, qty) VALUES (?, ?, ?)').run(date, itemId, qty);
};

test("a confirmed order whose day has passed without being logged still counts as stock on its way", async () => {
  const { db, server, base, buns } = setup('2026-09-22'); // Tuesday; Monday's delivery never logged
  const without = (await (await fetch(`${base}/orders/plan`)).json()).items.find(i => i.id === buns).qtys[0];
  confirmDirect(db, '2026-09-21', [[buns, 40]]);
  const withPending = (await (await fetch(`${base}/orders/plan`)).json()).items.find(i => i.id === buns).qtys[0];
  assert.ok(withPending < without, `expected ${withPending} < ${without}`);
  server.close(); db.close();
});

test("on the morning of a delivery the confirmed order still counts when planning the next one", async () => {
  const { db, server, base, buns } = setup('2026-09-21'); // Monday, delivery not in yet
  await send('PUT', `${base}/orders/confirm`, { date: '2026-09-21', lines: [{ itemId: buns, qty: 40 }] });
  const plan = await (await fetch(`${base}/orders/plan`)).json();
  assert.strictEqual(plan.deliveries[0], '2026-09-21');
  const row = plan.items.find(i => i.id === buns);
  assert.strictEqual(row.qtys[0], 40);
  assert.strictEqual(row.stockAfter[0], 40);            // projected on hand once Monday's delivery arrives
  assert.ok(row.qtys[1] < 20, 'Wednesday should be planned on top of Monday\'s 40, not from empty');
  server.close(); db.close();
});

test('marking a delivery as not arrived drops its expected stock', async () => {
  const { db, server, base, buns } = setup('2026-09-22');
  confirmDirect(db, '2026-09-21', [[buns, 40]]);
  await send('POST', `${base}/prompts/skip-delivery`, { date: '2026-09-21' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM order_confirmations').get().c, 0);
  server.close(); db.close();
});

test('receiving a delivery records what was ordered and flags anything short or missing', async () => {
  const { db, server, base, buns, cups } = setup('2026-09-21');
  await send('PUT', `${base}/orders/confirm`, { date: '2026-09-21', lines: [{ itemId: buns, qty: 40 }, { itemId: cups, qty: 3 }] });
  // 32 buns arrive instead of 40, and no cups
  await send('POST', `${base}/deliveries`, { deliveredAt: '2026-09-21', lines: [{ itemId: buns, qty: 32 }] });
  const lines = db.prepare('SELECT item_id, qty, ordered_qty FROM delivery_lines ORDER BY item_id').all();
  assert.deepStrictEqual(lines, [
    { item_id: buns, qty: 32, ordered_qty: 40 },
    { item_id: cups, qty: 0, ordered_qty: 3 },
  ]);
  const onHand = (id) => db.prepare('SELECT on_hand_qty q FROM inventory_ledger WHERE item_id = ?').get(id);
  assert.strictEqual(onHand(buns).q, 32);
  assert.strictEqual(onHand(cups), undefined); // nothing arrived, nothing added to stock
  server.close(); db.close();
});

test('the Incoming column keeps showing an order until it is received, even after its day', async () => {
  const { db, server, base, buns } = setup('2026-09-22');
  confirmDirect(db, '2026-09-21', [[buns, 40]]);
  const inc = await (await fetch(`${base}/orders/incoming`)).json();
  assert.deepStrictEqual(inc[buns], { date: '2026-09-21', qty: 40 });
  server.close(); db.close();
});
