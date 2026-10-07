// Regression tests for the problems found in the 23 Sep 2026 review (docs/reviews/2026-09-23-full-review.md).
// Each runs against the whole app, the way the pages use it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { getDb } = require('../db/connection');
const { createApp } = require('../server');
const { createSession, COOKIE_NAME } = require('../lib/auth');
const { getOnHand, applyEvent } = require('../ledger/ledger');
const { computeDeliveryPlan } = require('../lib/orderEngine');

async function withApp(today, fn) {
  const db = getDb(':memory:');
  const uid = db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('T', 't@x', 'x:y')").run().lastInsertRowid;
  const { token } = createSession(db, uid);
  const server = createApp(db, { today: () => today, secureCookies: false }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const item = (name, extra = {}) => db.prepare(`INSERT INTO items
    (name, category, unit_label, supplier_unit, usage_per_100_sales, buffer_value, track_use_by, items_per_order_unit, price_per_unit, max_boxes, supplier_order_pack)
    VALUES (?, ?, 'Case', ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, extra.category || 'Freezer', extra.supplierUnit || 'Each', extra.usage ?? 0, extra.buffer ?? 0,
    extra.tracked ? 1 : 0, extra.perCase ?? 1, extra.price ?? 1, extra.max ?? null, extra.pack ?? null).lastInsertRowid;
  const count = (date, lines) => call('POST', '/counts', { countedAt: date, lines: lines.map(([itemId, qty]) => ({ itemId, countedQty: qty, unit: 'order' })) });
  try {
    await fn({ db, call, item, count });
  } finally {
    server.close();
    db.close();
  }
}
const batchQtys = (db, itemId) => db.prepare('SELECT qty_remaining FROM batches WHERE item_id = ? ORDER BY use_by_date').all(itemId).map(b => b.qty_remaining);

test('1.1 a mistyped real-sales figure can be corrected, and stock follows', async () => {
  await withApp('2026-09-23', async ({ db, call, item, count }) => {
    const fries = item('Fries', { usage: 1 });
    await count('2026-09-20', [[fries, 100]]);
    await call('PUT', '/forecast', { entries: [{ date: '2026-09-21', actualSales: 4500 }] });
    await call('PUT', '/forecast', { entries: [{ date: '2026-09-22', actualSales: 45000 }] }); // typo for 4,500
    assert.strictEqual(getOnHand(db, fries), -395);
    const fix = await call('PUT', '/forecast', { entries: [{ date: '2026-09-22', actualSales: 4500 }] });
    assert.strictEqual(fix.status, 200);
    assert.strictEqual(getOnHand(db, fries), 10);
    // clearing a figure puts that day's usage back and asks for the day again
    await call('PUT', '/forecast', { entries: [{ date: '2026-09-22', clearActual: true }] });
    assert.strictEqual(getOnHand(db, fries), 55);
    assert.strictEqual(db.prepare("SELECT actual_sales FROM sales_forecast WHERE date = '2026-09-22'").get().actual_sales, null);
    // a day already covered by the count is recorded but never changes stock
    await call('PUT', '/forecast', { entries: [{ date: '2026-09-20', actualSales: 5000 }] });
    await call('PUT', '/forecast', { entries: [{ date: '2026-09-20', actualSales: 6000 }] });
    assert.strictEqual(getOnHand(db, fries), 55);
  });
});

test('1.1 correcting sales down puts use-by stock back into the batches it came from', async () => {
  await withApp('2026-09-23', async ({ db, call, item, count }) => {
    const beef = item('Beef Patty', { usage: 0.1, tracked: true });
    await count('2026-09-20', [[beef, 14]]);
    await call('POST', '/batches', { itemId: beef, lines: [{ qty: 5, useByDate: '2026-09-24' }, { qty: 9, useByDate: '2026-09-27' }] });
    await call('PUT', '/forecast', { entries: [{ date: '2026-09-21', actualSales: 12000 }] }); // 12 used: 5 + 7
    assert.deepStrictEqual(batchQtys(db, beef), [0, 2]);
    await call('PUT', '/forecast', { entries: [{ date: '2026-09-21', actualSales: 2000 }] }); // really 2 used
    assert.deepStrictEqual(batchQtys(db, beef), [3, 9]);
    assert.strictEqual(getOnHand(db, beef), 12);
  });
});

test('1.2 a count saved late is compared with stock on its own date, so later deliveries survive', async () => {
  await withApp('2026-09-23', async ({ db, call, item, count }) => {
    const fries = item('Fries');
    await count('2026-09-20', [[fries, 100]]);
    await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: fries, qty: 50 }] });
    const preview = await call('POST', '/counts/preview', { countedAt: '2026-09-21', lines: [{ itemId: fries, countedQty: 90, unit: 'order' }] });
    assert.deepStrictEqual([preview.body[0].expectedQty, preview.body[0].variance, preview.body[0].laterChange], [100, -10, 50]);
    await count('2026-09-21', [[fries, 90]]);
    assert.strictEqual(getOnHand(db, fries), 140);
  });
});

test('1.3 the same item twice on a delivery (two use-by dates) is one line with two batches', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const beef = item('Beef Patty', { tracked: true });
    const res = await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [
      { itemId: beef, qty: 5, useByDate: '2026-09-24' }, { itemId: beef, qty: 9, useByDate: '2026-09-27' }] });
    const [delivery] = (await call('GET', '/deliveries')).body;
    assert.strictEqual(delivery.lines.length, 1);
    assert.strictEqual(delivery.lines[0].qty, 14);
    assert.deepStrictEqual(delivery.lines[0].batches.map(b => [b.use_by_date, b.qty_remaining]), [['2026-09-24', 5], ['2026-09-27', 9]]);
    // "only 8 of the 27th's came": correcting the line takes it off the latest-dated part
    await call('PUT', `/deliveries/${res.body.id}/lines/${beef}`, { qty: 13 });
    assert.deepStrictEqual(batchQtys(db, beef), [5, 8]);
    assert.strictEqual(getOnHand(db, beef), 13);
    assert.strictEqual(db.prepare('SELECT qty FROM delivery_lines').get().qty, 13);
  });
});

test('1.4 a late delivery is logged against its slot, with its arrival day, and is never counted twice', async () => {
  await withApp('2026-09-29', async ({ db, call, item, count }) => {
    const fries = item('Fries', { usage: 0.1 });
    await count('2026-09-27', [[fries, 10]]);
    await call('PUT', '/orders/confirm', { date: '2026-09-30', lines: [] }); // keeps Wednesday out of the way
    db.prepare("INSERT INTO order_confirmations (delivery_date) VALUES ('2026-09-28')").run();
    db.prepare("INSERT INTO confirmed_order_lines (delivery_date, item_id, qty) VALUES ('2026-09-28', ?, 20)").run(fries);
    const slots = (await call('GET', '/deliveries/slots')).body;
    assert.strictEqual(slots.suggested, '2026-09-28'); // Monday's slot is the one still waiting
    const res = await call('POST', '/deliveries', { deliveredAt: '2026-09-28', arrivedAt: '2026-09-29', lines: [{ itemId: fries, qty: 20 }] });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM order_confirmations WHERE delivery_date = ?').get('2026-09-28').c, 0);
    assert.strictEqual(db.prepare("SELECT occurred_at FROM inventory_events WHERE type = 'delivery'").get().occurred_at, '2026-09-29');
    const plan = (await call('GET', '/orders/plan')).body;
    assert.strictEqual(plan.items.find(i => i.id === fries).stockAfter[0], 25.5); // 30 on hand less a day's usage - not 45.5
    assert.ok(!(await call('GET', '/prompts')).body.deliveries.some(d => d.date === '2026-09-28')); // Monday isn't asked about again
  });
});

test('3.2 logging the same delivery slot twice is refused unless it is meant to be added to', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const fries = item('Fries');
    await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: fries, qty: 5 }] });
    const again = await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: fries, qty: 5 }] });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(getOnHand(db, fries), 5);
    const merged = await call('POST', '/deliveries', { deliveredAt: '2026-09-23', addToExisting: true, lines: [{ itemId: fries, qty: 2 }] });
    assert.strictEqual(merged.status, 201);
    assert.strictEqual(getOnHand(db, fries), 7);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM deliveries').get().c, 1);
  });
});

test('1.7 removing a partly used delivery line leaves no phantom dated stock', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const beef = item('Beef Patty', { tracked: true });
    const a = await call('POST', '/deliveries', { deliveredAt: '2026-09-21', lines: [{ itemId: beef, qty: 10, useByDate: '2026-09-25' }] });
    await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: beef, qty: 5, useByDate: '2026-09-30' }] });
    await call('POST', '/waste', { itemId: beef, qty: 7, occurredAt: '2026-09-23', shift: 'close' });
    await call('DELETE', `/deliveries/${a.body.id}/lines/${beef}`);
    assert.strictEqual(getOnHand(db, beef), -2);
    assert.deepStrictEqual(batchQtys(db, beef).reduce((s, q) => s + q, 0), 0);
  });
});

test('1.15 a delivery can be corrected down after some of it has been used', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const beef = item('Beef Patty', { tracked: true });
    await call('POST', '/deliveries', { deliveredAt: '2026-09-21', lines: [{ itemId: beef, qty: 4, useByDate: '2026-09-24' }] });
    const b = await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: beef, qty: 10, useByDate: '2026-09-30' }] });
    await call('POST', '/waste', { itemId: beef, qty: 11, occurredAt: '2026-09-23', shift: 'close' }); // 4 + 7 of the new ones
    let res = await call('PUT', `/deliveries/${b.body.id}/lines/${beef}`, { qty: 8 }); // only 8 came
    assert.strictEqual(res.status, 200);
    assert.strictEqual(getOnHand(db, beef), 1);
    assert.deepStrictEqual(batchQtys(db, beef), [0, 1]);
    res = await call('PUT', `/deliveries/${b.body.id}/lines/${beef}`, { qty: 5 }); // more than its batch still holds
    assert.strictEqual(res.status, 200); // used to fail: "would make the batch negative"
    assert.strictEqual(getOnHand(db, beef), -2);
    assert.deepStrictEqual(batchQtys(db, beef), [0, 0]);
  });
});

test('1.13 the delivery route sets the logged time itself (it does not rely on a column default)', async () => {
  const file = path.join(os.tmpdir(), `old-shape-api-${process.pid}-${Date.now()}.db`);
  const old = new Database(file);
  old.exec('CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, delivered_at TEXT NOT NULL, note TEXT)');
  old.close();
  const db = getDb(file);
  const express = require('express');
const { asManager } = require('./helpers');
  const { createDeliveriesRouter } = require('../routes/deliveries');
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/deliveries', createDeliveriesRouter(db));
  const server = app.listen(0);
  const itemId = db.prepare("INSERT INTO items (name, category, unit_label) VALUES ('Fries', 'Freezer', 'Case')").run().lastInsertRowid;
  await fetch(`http://127.0.0.1:${server.address().port}/api/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveredAt: '2026-09-23', lines: [{ itemId, qty: 1 }] }),
  });
  assert.ok(db.prepare('SELECT created_at FROM deliveries').get().created_at);
  server.close();
  db.close();
  fs.unlinkSync(file);
});

test('1.9 projected stock is exact after cost smoothing moves an order earlier', async () => {
  await withApp('2026-09-21', async ({ db, call, item, count }) => {
    const cups = item('Cups', { category: 'Dry Store', usage: 0.5, price: 200 });
    const beef = item('Beef', { category: 'Chiller', usage: 1, price: 200 });
    await count('2026-09-20', [[cups, 0], [beef, 0]]);
    for (const [d, s] of [['2026-09-21', 100], ['2026-09-22', 100], ['2026-09-23', 1000], ['2026-09-24', 1000]]) {
      db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, ?)').run(d, s);
    }
    const plan = (await call('GET', '/orders/plan')).body;
    const row = plan.items.find(i => i.id === cups);
    const moved = plan.moves.find(m => m.itemId === cups && m.fromIndex === 1);
    assert.ok(moved, 'expected cups to be moved from Wednesday to Monday');
    // re-simulated: what arrived Monday is still there on Wednesday morning (less two quiet days' usage)
    assert.strictEqual(row.qtys[1], 0);
    assert.ok(row.stockAfter[1] > 0, `Wednesday shows ${row.stockAfter[1]} projected`);
  });
});

test('1.10 floating-point noise never rounds an order up a whole case', () => {
  const items = [{ id: 1, usage_per_100_sales: 0, buffer_value: 17.1, shelf_life_days: null, max_boxes: null, case_multiple: null }];
  const plan = computeDeliveryPlan({ items, onHand: { 1: 15.1 }, deliveries: [{ date: '2026-09-21', coverDays: [] }], salesForDay: () => 0 });
  assert.strictEqual(plan[1].qtys[0], 2);
});

test('1.14 use-by items are not ordered beyond what can be used before they go out of date', async () => {
  await withApp('2026-09-20', async ({ db, call, item, count }) => {
    const beef = item('Beef Patty', { usage: 1, buffer: 30, max: 100, tracked: true }); // 10 a day at £1,000
    await count('2026-09-20', [[beef, 0]]);
    for (let d = 21; d <= 30; d++) db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, 1000)').run(`2026-09-${d}`);
    const before = (await call('GET', '/orders/plan')).body.items.find(i => i.id === beef).qtys[0];
    assert.strictEqual(before, 50); // 2 days of usage + the (too big) buffer of 30
    // deliveries so far have come with 3 usable days (delivered on the 14th, use by the 16th)
    const d = db.prepare("INSERT INTO deliveries (delivered_at) VALUES ('2026-09-14')").run().lastInsertRowid;
    db.prepare(`INSERT INTO batches (item_id, delivery_id, received_at, shelf_life_days, use_by_date, qty_remaining)
      VALUES (?, ?, '2026-09-14', 2, '2026-09-16', 0)`).run(beef, d);
    const plan = (await call('GET', '/orders/plan')).body.items.find(i => i.id === beef);
    assert.strictEqual(plan.qtys[0], 30); // 3 usable days x 10
    assert.ok(plan.explain[0].limits.some(l => l.kind === 'shelf'));
  });
});

test('2.1 items the supplier sells in bigger packs are ordered in whole packs', () => {
  const items = [{ id: 1, usage_per_100_sales: 1, buffer_value: 0, items_per_order_unit: 1, supplier_order_pack: 2.5, max_boxes: null, case_multiple: null }];
  const plan = computeDeliveryPlan({ items, onHand: { 1: 0 }, deliveries: [{ date: '2026-09-21', coverDays: ['2026-09-21'] }], salesForDay: () => 2300 });
  assert.strictEqual(plan[1].qtys[0], 25); // 23 KG needed -> 10 packs of 2.5 KG
  const catchWeight = [{ ...items[0], items_per_order_unit: 9.72, supplier_order_pack: 9.74 }];
  const cw = computeDeliveryPlan({ items: catchWeight, onHand: { 1: 0 }, deliveries: [{ date: '2026-09-21', coverDays: ['2026-09-21'] }], salesForDay: () => 200 });
  assert.strictEqual(cw[1].qtys[0], 2); // a 0.2% catch-weight difference is not a pack size
});

test('3.3 every planned quantity comes with the working behind it', async () => {
  await withApp('2026-09-19', async ({ call, item, count }) => {
    const fries = item('Fries', { usage: 1, buffer: 2, max: 30 });
    await count('2026-09-18', [[fries, 12]]);
    const plan = (await call('GET', '/orders/plan')).body;
    const row = plan.items.find(i => i.id === fries);
    assert.deepStrictEqual(row.start, { now: 12, pending: 0, usage: 90, expiry: 0, shelfLife: null }); // Sat + Sun at £4,500
    assert.strictEqual(plan.bridge.days, 2);
    const step = row.explain[0];
    assert.deepStrictEqual([step.before, step.usage, step.buffer, step.need, step.order], [0, 90, 2, 92, 30]);
    assert.deepStrictEqual(step.limits, [{ kind: 'max', max: 30, cap: 30 }]);
  });
});

test('1.16 the plan does not take off a day of usage that tonight\'s count already reflects', async () => {
  await withApp('2026-09-20', async ({ call, item, count }) => {
    const fries = item('Fries', { usage: 1 });
    await count('2026-09-20', [[fries, 100]]); // Sunday night count; Monday's delivery is next
    const plan = (await call('GET', '/orders/plan')).body;
    assert.strictEqual(plan.bridge.days, 0);
    assert.strictEqual(plan.items.find(i => i.id === fries).explain[0].before, 100);
  });
});

test('1.5 the use-by pop-up sets the total in stock, so typing the real total never adds the dated part again', async () => {
  await withApp('2026-09-23', async ({ db, call, item, count }) => {
    const beef = item('Beef Patty', { tracked: true });
    await count('2026-09-20', [[beef, 15]]);
    await call('POST', '/batches', { itemId: beef, lines: [{ qty: 6.87, useByDate: '2026-09-24' }] });
    const res = await call('POST', '/batches/undated-stock', { itemId: beef, total: 15 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(getOnHand(db, beef), 15);
    assert.strictEqual(res.body.undated, 8.13);
    assert.strictEqual((await call('POST', '/batches/undated-stock', { itemId: beef, total: 5 })).status, 400); // below the dated 6.87
  });
});

test('1.6 waste can be typed in supplier units; a repeat within seconds is refused', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const nuggets = item('Nuggets', { perCase: 400 });
    applyEvent(db, { itemId: nuggets, type: 'delivery', qtyDelta: 6, occurredAt: '2026-09-21' });
    const res = await call('POST', '/waste', { itemId: nuggets, qty: 6, unit: 'native', occurredAt: '2026-09-23', shift: 'close', reason: 'Dropped' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(getOnHand(db, nuggets), 5.985); // 6 nuggets, not 6 cases
    const again = await call('POST', '/waste', { itemId: nuggets, qty: 6, unit: 'native', occurredAt: '2026-09-23', shift: 'close', reason: 'Dropped' });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(getOnHand(db, nuggets), 5.985);
  });
});

test('3.1 a waste entry can be corrected or deleted, and its stock goes back where it came from', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const beef = item('Beef Patty', { tracked: true });
    await call('POST', '/deliveries', { deliveredAt: '2026-09-21', lines: [{ itemId: beef, qty: 5, useByDate: '2026-09-24' }, { itemId: beef, qty: 9, useByDate: '2026-09-27' }] });
    const w = await call('POST', '/waste', { itemId: beef, qty: 7, occurredAt: '2026-09-23', shift: 'open' });
    assert.deepStrictEqual(batchQtys(db, beef), [0, 7]);
    const edit = await call('PUT', `/waste/${w.body.id}`, { qty: 2 });
    assert.strictEqual(edit.status, 200);
    assert.deepStrictEqual(batchQtys(db, beef), [3, 9]);
    assert.strictEqual(getOnHand(db, beef), 12);
    await call('DELETE', `/waste/${w.body.id}`);
    assert.deepStrictEqual(batchQtys(db, beef), [5, 9]);
    assert.strictEqual(getOnHand(db, beef), 14);
    assert.deepStrictEqual((await call('GET', '/waste')).body, []);
  });
});

test('waste or deliveries logged, corrected or deleted for a day the latest count covers never move stock twice', async () => {
  await withApp('2026-09-23', async ({ db, call, item, count }) => {
    const fries = item('Fries');
    const early = await call('POST', '/waste', { itemId: fries, qty: 1, occurredAt: '2026-09-19', shift: 'close' }); // before any count
    await count('2026-09-20', [[fries, 50]]); // Sunday night: 50 on the shelf, the waste already gone
    const late = await call('POST', '/waste', { itemId: fries, qty: 2, occurredAt: '2026-09-20', shift: 'close' }); // logged Monday
    assert.deepStrictEqual([late.status, late.body.stockChanged], [201, false]);
    await call('PUT', `/waste/${early.body.id}`, { qty: 3 });
    await call('DELETE', `/waste/${early.body.id}`);
    const d = await call('POST', '/deliveries', { deliveredAt: '2026-09-18', lines: [{ itemId: fries, qty: 10 }] }); // Friday's, logged late
    assert.deepStrictEqual([d.status, d.body.stockChanged], [201, false]);
    assert.strictEqual(getOnHand(db, fries), 50); // the count is the truth for everything up to Sunday
    await call('POST', '/waste', { itemId: fries, qty: 5, occurredAt: '2026-09-21', shift: 'open' }); // after the count: counts
    assert.strictEqual(getOnHand(db, fries), 45);
  });
});

test('3.1 a whole delivery logged by mistake can be deleted, and its confirmed order is expected again', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const fries = item('Fries');
    await call('PUT', '/orders/confirm', { date: '2026-09-23', lines: [{ itemId: fries, qty: 4 }] });
    const d = await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: fries, qty: 4 }] });
    const del = await call('DELETE', `/deliveries/${d.body.id}`);
    assert.deepStrictEqual([del.status, del.body.restoredOrder], [200, true]);
    assert.strictEqual(getOnHand(db, fries), 0);
    assert.deepStrictEqual(db.prepare('SELECT delivery_date, qty FROM confirmed_order_lines').all(), [{ delivery_date: '2026-09-23', qty: 4 }]);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM deliveries').get().c, 0);
  });
});

test('1.11 suggested usage rates leave out logged waste (the stock ledger takes waste off separately)', async () => {
  await withApp('2026-10-05', async ({ db, call, item, count }) => {
    const fries = item('Fries');
    await count('2026-09-27', [[fries, 10]]);
    await call('POST', '/waste', { itemId: fries, qty: 2, occurredAt: '2026-09-30', shift: 'close' });
    await count('2026-10-04', [[fries, 2]]);
    for (let d = 28; d <= 30; d++) db.prepare('INSERT INTO sales_forecast (date, actual_sales) VALUES (?, 1000)').run(`2026-09-${d}`);
    for (let d = 1; d <= 4; d++) db.prepare('INSERT INTO sales_forecast (date, actual_sales) VALUES (?, 1000)').run(`2026-10-0${d}`);
    const counts = (await call('GET', '/usage/counts')).body;
    const report = (await call('GET', `/usage?from=${counts[1].id}&to=${counts[0].id}`)).body;
    const row = report.items.find(i => i.itemId === fries);
    assert.deepStrictEqual([row.used, row.wasted, row.salesUsed], [8, 2, 6]);
    assert.ok(Math.abs(row.suggested - 6 / 70) < 1e-9);
  });
});

test('1.12 changing the size of an order unit can keep the physical stock the same', async () => {
  await withApp('2026-09-23', async ({ db, call, item }) => {
    const beef = item('Beef Patty', { perCase: 180, tracked: true });
    await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: beef, qty: 2, useByDate: '2026-09-28' }] }); // 360 patties
    const res = await call('PUT', `/items/${beef}`, { items_per_order_unit: 90, convertStock: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(getOnHand(db, beef), 4); // still 360 patties
    assert.deepStrictEqual(batchQtys(db, beef), [4]);
  });
});

test('1.17 bad input gets a clear 400, not a server error', async () => {
  await withApp('2026-09-23', async ({ call, item }) => {
    const fries = item('Fries');
    const cases = [
      await call('POST', '/deliveries', { deliveredAt: '23/09/2026', lines: [{ itemId: fries, qty: 1 }] }),
      await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: fries, qty: -3 }] }),
      await call('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId: 999, qty: 1 }] }),
      await call('PUT', '/forecast', { entries: [{ date: '2026-09-22', actualSales: -5 }] }),
      await call('PUT', '/forecast', {}),
      await call('POST', '/counts', { lines: [{ itemId: fries, countedQty: 1, unit: 'order' }] }),
      await call('POST', '/counts', { countedAt: '2026-09-23', lines: [{ itemId: 999, countedQty: 1, unit: 'order' }] }),
      await call('PUT', '/orders/confirm', { date: '2026-09-25', lines: [{ itemId: fries, qty: 1 }, { itemId: fries, qty: 2 }] }),
      await call('POST', '/items', { name: 'X', category: 'Freezer', unit_label: 'Case', items_per_order_unit: 0 }),
    ];
    for (const r of cases) {
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
    }
  });
});

test('1.18 a quick spot check of a few items does not count as the weekly count', async () => {
  await withApp('2026-09-20', async ({ call, item, count }) => {
    const ids = ['A', 'B', 'C', 'D'].map(n => item(n));
    await count('2026-09-13', ids.map(id => [id, 1]));
    await count('2026-09-20', [[ids[0], 1]]);
    assert.strictEqual((await call('GET', '/prompts')).body.weeklyCount.due, true);
    await count('2026-09-20', [[ids[1], 1]]);
    assert.strictEqual((await call('GET', '/prompts')).body.weeklyCount.due, false); // two separate part-counts add up
  });
});

test('3.9 the home page ranks low stock by days of cover and flags what will run out before it arrives', async () => {
  await withApp('2026-09-19', async ({ call, item, count }) => {
    const napkins = item('Napkins', { usage: 0.01 }); // 0.5 case lasts ages
    const beef = item('Beef', { usage: 1 });          // 45 cases a day at £4,500
    await count('2026-09-18', [[napkins, 0.5], [beef, 20]]);
    const d = (await call('GET', '/dashboard')).body;
    assert.strictEqual(d.inventory.lowest[0].name, 'Beef');
    assert.strictEqual(d.inventory.lowest[0].runsOut, true); // under half a day left, next delivery Monday
  });
});
