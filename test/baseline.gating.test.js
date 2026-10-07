const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createPromptsRouter } = require('../routes/prompts');
const { createForecastRouter } = require('../routes/forecast');
const { getOnHand, applyEvent } = require('../ledger/ledger');

function setup(today = '2026-09-22') {
  const db = getDb(':memory:');
  const fries = db.prepare(`INSERT INTO items (name, category, unit_label, usage_per_100_sales)
    VALUES ('Fries', 'Freezer', 'Box', 1)`).run().lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/prompts', createPromptsRouter(db, { today: () => today }));
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  return { db, server, fries, base: `http://127.0.0.1:${server.address().port}/api` };
}
const put = (base, entries) => fetch(`${base}/forecast`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }),
});

test('before the first count, only the first-count prompt is due', async () => {
  const { db, server, base } = setup();
  const p = await (await fetch(`${base}/prompts`)).json();
  assert.strictEqual(p.firstCount.due, true);
  assert.deepStrictEqual([p.salesDays, p.deliveries, p.useByNeeded], [[], [], []]);
  server.close(); db.close();
});

test('real sales entered before the first count are saved but do not deduct stock', async () => {
  const { db, server, base, fries } = setup();
  const res = await put(base, [{ date: '2026-09-19', actualSales: 5000 }]);
  const body = await res.json();
  assert.strictEqual(getOnHand(db, fries), 0);
  assert.deepStrictEqual(body.decayedDates, []);
  assert.deepStrictEqual(body.skippedDecayDates, ['2026-09-19']);
  const row = db.prepare('SELECT actual_sales, decayed FROM sales_forecast WHERE date = ?').get('2026-09-19');
  assert.deepStrictEqual([row.actual_sales, row.decayed], [5000, 1]);
  server.close(); db.close();
});

test('after the first count, days up to the count date are skipped and later days deduct', async () => {
  const { db, server, base, fries } = setup('2026-09-23');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-21')").run();
  applyEvent(db, { itemId: fries, type: 'count_correction', qtyDelta: 100, occurredAt: '2026-09-21' });
  await put(base, [{ date: '2026-09-21', actualSales: 5000 }]); // in the count already
  assert.strictEqual(getOnHand(db, fries), 100);
  await put(base, [{ date: '2026-09-22', actualSales: 5000 }]); // after the count: 1 * 5000/100 = 50
  assert.strictEqual(getOnHand(db, fries), 50);
  const p = await (await fetch(`${base}/prompts`)).json();
  assert.deepStrictEqual(p.salesDays, []); // 21st and 22nd logged, yesterday is the 22nd
  server.close(); db.close();
});

test('after the first count, real sales are only asked for from the day after the count', async () => {
  const { db, server, base } = setup('2026-09-25');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-21')").run();
  const p = await (await fetch(`${base}/prompts`)).json();
  assert.deepStrictEqual(p.salesDays, ['2026-09-22', '2026-09-23', '2026-09-24']);
  server.close(); db.close();
});
