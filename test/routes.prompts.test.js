const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createPromptsRouter } = require('../routes/prompts');
const { applyEvent } = require('../ledger/ledger');

function startServer(today) {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const beef = db.prepare(`INSERT INTO items
    (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit, track_use_by)
    VALUES ('Beef Patty', 'Chiller', 'Box', 1, 0.5, 2, 30, 1)`).run().lastInsertRowid;
  applyEvent(db, { itemId: beef, type: 'delivery', qtyDelta: 1, occurredAt: '2026-09-01' });
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/prompts', createPromptsRouter(db, { today: () => today }));
  const server = app.listen(0);
  return { db, server, beef, base: `http://127.0.0.1:${server.address().port}/api/prompts` };
}

const get = async (base) => (await fetch(base)).json();

test('with no real sales logged since the count, only yesterday is asked for', async () => {
  const { server, base, db } = startServer('2026-09-17'); // Thursday
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-15')").run();
  assert.deepStrictEqual((await get(base)).salesDays, ['2026-09-16']);
  server.close(); db.close();
});

test('every day since the last logged real sales is asked for, up to yesterday', async () => {
  const { server, base, db } = startServer('2026-09-17');
  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales, actual_sales) VALUES (?, 4000, 4100)').run('2026-09-13');
  assert.deepStrictEqual((await get(base)).salesDays, ['2026-09-14', '2026-09-15', '2026-09-16']);
  server.close(); db.close();
});

test('sales days are capped at 14', async () => {
  const { server, base, db } = startServer('2026-09-17');
  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales, actual_sales) VALUES (?, 4000, 4100)').run('2026-06-01');
  const days = (await get(base)).salesDays;
  assert.strictEqual(days.length, 14);
  assert.strictEqual(days[13], '2026-09-16');
  server.close(); db.close();
});

test('nothing due when sales are up to date, no delivery day is outstanding and it is not a count day', async () => {
  const { server, base, db } = startServer('2026-09-17'); // Thursday; Wed 16th delivery logged
  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales, actual_sales) VALUES (?, 4000, 4100)').run('2026-09-16');
  db.prepare('INSERT INTO deliveries (delivered_at) VALUES (?)').run('2026-09-16');
  db.prepare('INSERT INTO deliveries (delivered_at) VALUES (?)').run('2026-09-14');
  const p = await get(base);
  assert.deepStrictEqual(p.salesDays, []);
  assert.deepStrictEqual(p.deliveries, []);
  assert.strictEqual(p.weeklyCount.due, false);
  server.close(); db.close();
});

test('an unlogged scheduled delivery is offered with plan-suggested lines and tracking flag', async () => {
  const { server, base, db, beef } = startServer('2026-09-17'); // Wed 16th and Mon 14th unlogged
  const p = await get(base);
  assert.deepStrictEqual(p.deliveries.map(d => d.date), ['2026-09-14', '2026-09-16']);
  const line = p.deliveries[0].lines.find(l => l.itemId === beef);
  assert.ok(line.qty > 0);
  assert.strictEqual(line.trackUseBy, true);
  server.close(); db.close();
});

test('a skipped delivery is not asked about again', async () => {
  const { server, base, db } = startServer('2026-09-17');
  const res = await fetch(`${base}/skip-delivery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-09-14' }),
  });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual((await get(base)).deliveries.map(d => d.date), ['2026-09-16']);
  server.close(); db.close();
});

// A count that covers the one item these tests use.
function logCount(db, date, itemId) {
  const id = db.prepare('INSERT INTO counts (counted_at) VALUES (?)').run(date).lastInsertRowid;
  db.prepare(`INSERT INTO count_lines (count_id, item_id, counted_qty, unit_used, converted_qty, expected_qty, variance)
    VALUES (?, ?, 1, 'order', 1, 1, 0)`).run(id, itemId);
}

test('weekly count is due on Sunday and Monday until a count is logged since Sunday', async () => {
  const sun = startServer('2026-09-20'); // Sunday
  logCount(sun.db, '2026-09-13', sun.beef); // baseline already done
  assert.strictEqual((await get(sun.base)).weeklyCount.due, true);
  logCount(sun.db, '2026-09-20', sun.beef);
  assert.strictEqual((await get(sun.base)).weeklyCount.due, false);
  sun.server.close(); sun.db.close();

  const mon = startServer('2026-09-21'); // Monday, only last Sunday's-week count logged before Sunday
  logCount(mon.db, '2026-09-13', mon.beef);
  assert.strictEqual((await get(mon.base)).weeklyCount.due, true);
  logCount(mon.db, '2026-09-20', mon.beef);
  assert.strictEqual((await get(mon.base)).weeklyCount.due, false);
  mon.server.close(); mon.db.close();

  const wed = startServer('2026-09-23');
  assert.strictEqual((await get(wed.base)).weeklyCount.due, false);
  wed.server.close(); wed.db.close();
});
