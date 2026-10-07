const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { computeDeliveryPlan } = require('../lib/orderEngine');
const { smoothDeliveryCosts } = require('../lib/costSmoothing');
const { createOrdersRouter } = require('../routes/orders');
const { createDeliveriesRouter } = require('../routes/deliveries');
const { applyEvent } = require('../ledger/ledger');

const deliveries = [
  { date: '2026-09-23', coverDays: ['2026-09-23', '2026-09-24'] },
  { date: '2026-09-25', coverDays: ['2026-09-25', '2026-09-26', '2026-09-27'] },
];
const item = { id: 1, name: 'Buns', items_per_order_unit: 1, usage_per_100_sales: 1, buffer_value: 0, max_boxes: null, case_multiple: null, shelf_life_days: null, avg_daily_sales: 1000 };

test('a confirmed delivery uses the confirmed quantity, and the next delivery is planned on top of it', () => {
  const free = computeDeliveryPlan({ items: [item], onHand: { 1: 0 }, deliveries, salesForDay: () => 1000 });
  assert.deepStrictEqual(free[1].qtys, [20, 30]); // usage 10/day: 2 days then 3 days

  const fixed = computeDeliveryPlan({
    items: [item], onHand: { 1: 0 }, deliveries, salesForDay: () => 1000,
    fixedOrders: { '2026-09-23': { 1: 35 } },
  });
  assert.strictEqual(fixed[1].qtys[0], 35);            // confirmed, not the planned 20
  assert.strictEqual(fixed[1].stockAfter[0], 35);      // projected on hand the morning it arrives
  assert.strictEqual(fixed[1].qtys[1], 15);            // 35 - 20 usage = 15 left, so only 15 more needed for the 30
});

test('a confirmed delivery with no line for an item orders none of it', () => {
  const plan = computeDeliveryPlan({
    items: [item], onHand: { 1: 0 }, deliveries, salesForDay: () => 1000,
    fixedOrders: { '2026-09-23': {} },
  });
  assert.strictEqual(plan[1].qtys[0], 0);
});

test('cost smoothing never moves quantities into or out of a locked delivery', () => {
  const items = [{ id: 1, category: 'Dry Store', price_per_unit: 10, shelf_life_days: null, max_boxes: null }];
  const plan = { 1: { qtys: [0, 100], stockAfter: [0, 100], buffers: [0, 0] } };
  const free = smoothDeliveryCosts({ plan, items, deliveries, targetCost: 500, flexibleCategories: ['Dry Store'] });
  assert.ok(free.moves.length > 0 || free.plan[1].qtys[1] <= 100);
  const locked = smoothDeliveryCosts({ plan, items, deliveries, targetCost: 500, flexibleCategories: ['Dry Store'], lockedIndexes: [1] });
  assert.deepStrictEqual(locked.plan[1].qtys, [0, 100]);
  assert.deepStrictEqual(locked.moves, []);
});

function setup(today = '2026-09-22') {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run();
  const buns = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Buns', 'Chiller', 'Each', 1, 1, 0, 2)`).run().lastInsertRowid;
  const cups = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Cups', 'Dry Store', 'Each', 1, 0, 0, 5)`).run().lastInsertRowid;
  applyEvent(db, { itemId: buns, type: 'count_correction', qtyDelta: 5, occurredAt: '2026-09-21' });
  for (const d of ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) {
    db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, 1000)').run(d);
  }
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/orders', createOrdersRouter(db, { today: () => today }));
  app.use('/api/deliveries', createDeliveriesRouter(db));
  const server = app.listen(0);
  return { db, server, buns, cups, base: `http://127.0.0.1:${server.address().port}/api` };
}
const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const planOf = async (base) => (await fetch(`${base}/orders/plan`)).json();

test('confirming an order locks its quantities into the plan and unconfirming releases them', async () => {
  const { db, server, base, buns, cups } = setup();
  const before = await planOf(base);
  assert.strictEqual(before.deliveries[0], '2026-09-23');
  const bunsBefore = before.items.find(i => i.id === buns).qtys;

  const res = await send('PUT', `${base}/orders/confirm`, { date: '2026-09-23', lines: [{ itemId: buns, qty: 40 }, { itemId: cups, qty: 3 }] });
  assert.strictEqual(res.status, 200);
  const after = await planOf(base);
  assert.deepStrictEqual(after.confirmedDates, ['2026-09-23']);
  assert.strictEqual(after.items.find(i => i.id === buns).qtys[0], 40);
  assert.strictEqual(after.items.find(i => i.id === cups).qtys[0], 3); // an item the plan wouldn't have ordered
  assert.notStrictEqual(after.items.find(i => i.id === buns).qtys[1], bunsBefore[1]); // next delivery re-planned on top

  assert.strictEqual((await send('DELETE', `${base}/orders/confirm/2026-09-23`)).status, 200);
  const released = await planOf(base);
  assert.deepStrictEqual(released.confirmedDates, []);
  assert.deepStrictEqual(released.items.find(i => i.id === buns).qtys, bunsBefore);
  server.close(); db.close();
});

test('confirming rejects a non-delivery day, a past date and bad quantities', async () => {
  const { db, server, base, buns } = setup();
  const put = (body) => send('PUT', `${base}/orders/confirm`, body);
  assert.strictEqual((await put({ date: '2026-09-24', lines: [{ itemId: buns, qty: 1 }] })).status, 400); // Thursday
  assert.strictEqual((await put({ date: '2026-09-21', lines: [{ itemId: buns, qty: 1 }] })).status, 400); // past
  assert.strictEqual((await put({ date: '2026-09-23', lines: [{ itemId: buns, qty: -1 }] })).status, 400);
  assert.strictEqual((await put({ date: '2026-09-23', lines: [{ itemId: 9999, qty: 1 }] })).status, 400);
  server.close(); db.close();
});

test('logging the delivery removes its confirmation', async () => {
  const { db, server, base, buns } = setup();
  await send('PUT', `${base}/orders/confirm`, { date: '2026-09-23', lines: [{ itemId: buns, qty: 40 }] });
  await send('POST', `${base}/deliveries`, { deliveredAt: '2026-09-23', lines: [{ itemId: buns, qty: 38 }] });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM order_confirmations').get().c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM confirmed_order_lines').get().c, 0);
  server.close(); db.close();
});

test('GET /api/orders/incoming lists confirmed, not-yet-received quantities per item', async () => {
  const { db, server, base, buns } = setup();
  await send('PUT', `${base}/orders/confirm`, { date: '2026-09-23', lines: [{ itemId: buns, qty: 40 }] });
  const inc = await (await fetch(`${base}/orders/incoming`)).json();
  assert.deepStrictEqual(inc[buns], { date: '2026-09-23', qty: 40 });
  server.close(); db.close();
});

test('the plan exposes each item price so a draft order can be costed on the page', async () => {
  const { db, server, base, buns } = setup();
  const plan = await planOf(base);
  assert.strictEqual(plan.items.find(i => i.id === buns).price, 2);
  server.close(); db.close();
});
