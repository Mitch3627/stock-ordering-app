// Store settings: delivery and order days, cost target and default sales, used by the plan and reminders.
const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');
const { createApp } = require('../server');
const { createSession, COOKIE_NAME } = require('../lib/auth');
const { makeSchedule } = require('../lib/settings');

async function withApp(today, fn) {
  const db = getDb(':memory:');
  const uid = db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('T', 't@x', 'x:y')").run().lastInsertRowid;
  const { token } = createSession(db, uid);
  const server = createApp(db, { today: () => today, secureCookies: false }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${token}` }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  db.prepare("INSERT INTO items (name, category, unit_label, supplier_unit, items_per_order_unit, usage_per_100_sales, price_per_unit) VALUES ('Fries', 'Freezer', 'Case', 'KG', 1, 1, 10)").run();
  try { await fn({ db, call }); } finally { server.close(); db.close(); }
}

const weekdayOf = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(d + 'T00:00:00Z').getUTCDay()];

test('a schedule works out how long each delivery lasts and how far ahead it is ordered', () => {
  const standard = makeSchedule([{ day: 1, orderDay: 5 }, { day: 3, orderDay: 1 }, { day: 5, orderDay: 3 }]);
  assert.deepStrictEqual(standard.cover, { 1: 2, 3: 2, 5: 3 });
  assert.deepStrictEqual(standard.lead, { 1: 3, 3: 2, 5: 2 });
  const weekly = makeSchedule([{ day: 4, orderDay: 2 }]); // Thursday only, ordered Tuesday
  assert.deepStrictEqual(weekly.cover, { 4: 7 });
  assert.deepStrictEqual(weekly.lead, { 4: 2 });
});

test('with no settings saved the store runs Mon / Wed / Fri, ordered two days before (Monday\'s on Friday)', async () => {
  await withApp('2026-09-23', async ({ call }) => {
    const s = (await call('GET', '/settings')).body;
    assert.deepStrictEqual(s.deliverySchedule, [{ day: 1, orderDay: 5 }, { day: 3, orderDay: 1 }, { day: 5, orderDay: 3 }]);
    assert.strictEqual(s.targetCost, 3500);
    assert.strictEqual(s.fallbackSales, 4500);
    assert.deepStrictEqual(s.categories, ['Freezer']);
    const plan = (await call('GET', '/orders/plan')).body;
    // today (Wednesday) hasn't had its delivery logged yet, so it comes first
    assert.deepStrictEqual(plan.deliveries.slice(0, 3).map(weekdayOf), ['Wed', 'Fri', 'Mon']);
    assert.deepStrictEqual(plan.orderBy.slice(0, 3), ['2026-09-21', '2026-09-23', '2026-09-25']);
  });
});

test('changing the days changes the plan, the order-by days, the cost target and the delivery slots', async () => {
  await withApp('2026-09-23', async ({ call }) => {
    const saved = await call('PUT', '/settings', {
      deliverySchedule: [{ day: 2, orderDay: 6 }, { day: 4, orderDay: 2 }, { day: 6, orderDay: 4 }], // Tue/Thu/Sat
      targetCost: 2800, fallbackSales: 3900,
    });
    assert.strictEqual(saved.status, 200);
    const plan = (await call('GET', '/orders/plan')).body;
    assert.deepStrictEqual(plan.deliveries.slice(0, 4), ['2026-09-24', '2026-09-26', '2026-09-29', '2026-10-01']);
    assert.deepStrictEqual(plan.orderBy.slice(0, 4), ['2026-09-22', '2026-09-24', '2026-09-26', '2026-09-29']);
    assert.deepStrictEqual(plan.cover.slice(0, 2).map(c => [c.from, c.to]), [['2026-09-24', '2026-09-25'], ['2026-09-26', '2026-09-28']]);
    assert.strictEqual(plan.targetCost, 2800);
    assert.strictEqual(plan.cover[0].sales, 2 * 3900); // no forecast entered: the default daily sales
    const slots = (await call('GET', '/deliveries/slots')).body.slots.map(s => weekdayOf(s.date));
    assert.ok(slots.length > 0 && slots.every(d => ['Tue', 'Thu', 'Sat'].includes(d)));
    // orders can be confirmed for the new days only
    assert.strictEqual((await call('PUT', '/orders/confirm', { date: '2026-09-26', lines: [] })).status, 200);
    const monday = await call('PUT', '/orders/confirm', { date: '2026-09-28', lines: [] });
    assert.strictEqual(monday.status, 400);
    assert.match(monday.body.error, /Tuesday, Thursday, Saturday/);
  });
});

test('settings refuse an order day equal to its delivery day, no days, repeated days and bad amounts', async () => {
  await withApp('2026-09-23', async ({ call }) => {
    for (const bad of [
      { deliverySchedule: [{ day: 1, orderDay: 1 }] },
      { deliverySchedule: [] },
      { deliverySchedule: [{ day: 1, orderDay: 5 }, { day: 1, orderDay: 4 }] },
      { targetCost: 0 },
      { fallbackSales: 'lots' },
    ]) assert.strictEqual((await call('PUT', '/settings', bad)).status, 400, JSON.stringify(bad));
  });
});

test('a day with a confirmed order can\'t be taken off the schedule until that order is unconfirmed', async () => {
  await withApp('2026-09-23', async ({ call }) => {
    assert.strictEqual((await call('PUT', '/orders/confirm', { date: '2026-09-28', lines: [] })).status, 200); // Monday
    const res = await call('PUT', '/settings', { deliverySchedule: [{ day: 3, orderDay: 1 }, { day: 5, orderDay: 3 }] });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Mon 28 Sep/);
    await call('DELETE', '/orders/confirm/2026-09-28');
    assert.strictEqual((await call('PUT', '/settings', { deliverySchedule: [{ day: 3, orderDay: 1 }, { day: 5, orderDay: 3 }] })).status, 200);
  });
});
