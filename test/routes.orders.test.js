const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createOrdersRouter } = require('../routes/orders');
const { createForecastRouter } = require('../routes/forecast');
const { applyEvent } = require('../ledger/ledger');

function startServer(today) {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const friesId = db.prepare(`INSERT INTO items
    (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Fries', 'Freezer', 'Box', 1, 0.1, 2, 21.5)`).run().lastInsertRowid;
  applyEvent(db, { itemId: friesId, type: 'delivery', qtyDelta: 5, occurredAt: '2026-09-13' });
  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, ?)').run('2026-09-14', 4000);

  const app = express();
  app.use('/api/orders', createOrdersRouter(db, { today: () => today }));
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}`, friesId };
}

test('GET /api/orders/plan returns a plan starting from the next Monday', async () => {
  const { server, base } = startServer('2026-09-13'); // Sunday
  const res = await fetch(`${base}/api/orders/plan`);
  const plan = await res.json();
  assert.strictEqual(plan.deliveries[0], '2026-09-14'); // Monday
  server.close();
});

test('GET /api/orders/plan includes a qty/stockAfter series per item matching the delivery count', async () => {
  const { server, base, friesId } = startServer('2026-09-13');
  const plan = await (await fetch(`${base}/api/orders/plan`)).json();
  const friesRow = plan.items.find(i => i.id === friesId);
  assert.strictEqual(friesRow.qtys.length, plan.deliveries.length);
  assert.strictEqual(friesRow.stockAfter.length, plan.deliveries.length);
  server.close();
});

test('GET /api/orders/plan includes a per-delivery cost total', async () => {
  const { server, base } = startServer('2026-09-13');
  const plan = await (await fetch(`${base}/api/orders/plan`)).json();
  assert.strictEqual(plan.costs.length, plan.deliveries.length);
  assert.ok(plan.costs.every(c => typeof c === 'number' && c >= 0));
  server.close();
});

test('GET /api/orders/plan bridges on-hand forward to the first delivery date when today is not a delivery day', async () => {
  // 2026-09-19 is a Saturday; the next delivery is Monday 2026-09-21, so there are
  // 2 bridge days (Sat and Sun) of usage that must be subtracted from
  // the raw ledger on-hand before the plan is computed.
  const db = require('../db/connection').getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const { applyEvent } = require('../ledger/ledger');
  const friesId = db.prepare(`INSERT INTO items
    (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Fries', 'Freezer', 'Box', 1, 1, 0, 21.5)`).run().lastInsertRowid;
  applyEvent(db, { itemId: friesId, type: 'delivery', qtyDelta: 100, occurredAt: '2026-09-13' });
  for (const date of ['2026-09-19', '2026-09-20', '2026-09-21']) {
    db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, ?)').run(date, 1000);
  }

  const express = require('express');
  const { createOrdersRouter } = require('../routes/orders');
  const app = express();
  app.use('/api/orders', createOrdersRouter(db, { today: () => '2026-09-19' }));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const plan = await (await fetch(`${base}/api/orders/plan`)).json();
  assert.strictEqual(plan.deliveries[0], '2026-09-21');

  // Without bridging, on-hand going into the first delivery would be 100 (raw ledger value)
  // plus the delivery's own order qty. With bridging, 2 days * usage_per_100_sales(1) *
  // (1000/100) = 20 units of usage must already be subtracted, so stockAfter for the
  // first delivery must be well below what it would be with unbridged on-hand (100 + order - dayUsage).
  const friesRow = plan.items.find(i => i.id === friesId);
  // Raw on-hand (100) bridged by 2 days of usage (10/day) = 80 remaining before delivery-day usage.
  // stockAfter[0] = bridgedOnHand + orderQty (order tops back up to target, small since buffer=0).
  assert.ok(friesRow.stockAfter[0] < 100, 'bridging must reduce on-hand below the raw ledger value');
  server.close();
  db.close();
});

test('GET /api/orders/plan is not dragged toward zero avg_daily_sales by a real-sales-only (null forecast) date', async () => {
  // A date where only actualSales was entered (no forecastedSales, e.g. via a daily
  // catch-up prompt) must not be treated as a forecasted_sales=0 row: it should be
  // excluded from the avg_daily_sales calculation entirely, not drag it toward zero.
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const eggsId = db.prepare(`INSERT INTO items
    (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, shelf_life_days)
    VALUES ('Eggs', 'Chiller', 'Box', 1, 2, 0, 3)`).run().lastInsertRowid;

  applyEvent(db, { itemId: eggsId, type: 'delivery', qtyDelta: 100, occurredAt: '2026-09-01' });

  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/orders', createOrdersRouter(db, { today: () => '2026-09-14' }));
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Real-sales-only date: no forecastedSales given, so the row must store a NULL
  // forecast (not 0). This also triggers decay, which we cancel out below with an
  // offsetting delivery so on-hand ends at a known value (0) for the plan calc.
  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-05', actualSales: 100 }] }),
  });
  // decay = usage_per_100_sales(2) * 100/100 = 2; cancel it out to land on-hand at 0.
  applyEvent(db, { itemId: eggsId, type: 'delivery', qtyDelta: 2, occurredAt: '2026-09-06' });
  applyEvent(db, { itemId: eggsId, type: 'waste', qtyDelta: -100, occurredAt: '2026-09-06' });

  // The only forecasted (non-null) row: 10,000. If the null row above were incorrectly
  // treated as 0, avg_daily_sales would be (0 + 10000) / 2 = 5000 instead of 10000.
  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-14', forecastedSales: 10000 }] }),
  });

  const plan = await (await fetch(`${base}/api/orders/plan?avgDailySales=10000`)).json();
  const eggsRow = plan.items.find(i => i.id === eggsId);

  // With on-hand at 0, cover-day sales of 10000+10000 and usage_per_100_sales=2, the
  // uncapped order need is 400. shelf_life_days=3 means the shelf-life ceiling is
  // avgDailyUsage * 3. With the buggy avg (5000) that ceiling is 300 (order gets
  // capped down to 300, a real under-order). With the fix (avg=10000) the ceiling is
  // 600, so the full 400 units are ordered.
  assert.strictEqual(eggsRow.qtys[0], 400);

  server.close();
  db.close();
});
