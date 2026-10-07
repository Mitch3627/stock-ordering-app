const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const { getDb } = require('../db/connection');
const { createForecastRouter } = require('../routes/forecast');
const { applyEvent, getOnHand } = require('../ledger/ledger');

function startServer() {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('PUT /api/forecast upserts entries, GET returns them in range', async () => {
  const { server, base } = startServer();
  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [
      { date: '2026-09-14', forecastedSales: 3500 },
      { date: '2026-09-15', forecastedSales: 4200 },
    ] }),
  });
  const list = await (await fetch(`${base}/api/forecast?from=2026-09-14&to=2026-09-14`)).json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].forecasted_sales, 3500);
  server.close();
});

test('PUT /api/forecast overwrites an existing date', async () => {
  const { server, base } = startServer();
  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-14', forecastedSales: 3500 }] }),
  });
  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-14', forecastedSales: 4000 }] }),
  });
  const list = await (await fetch(`${base}/api/forecast?from=2026-09-14&to=2026-09-14`)).json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].forecasted_sales, 4000);
  server.close();
});

test('PUT /api/forecast with actualSales applies decay exactly once', async () => {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const friesId = db.prepare(`
    INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, active)
    VALUES ('Fries', 'Freezer', 'Box', 1, 1, 1)
  `).run().lastInsertRowid;
  applyEvent(db, { itemId: friesId, type: 'delivery', qtyDelta: 20, occurredAt: '2026-09-17' });

  const res = await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-18', actualSales: 1000 }] }),
  });
  const body = await res.json();
  assert.deepStrictEqual(body.decayedDates, ['2026-09-18']);
  assert.strictEqual(getOnHand(db, friesId), 10); // 20 - (1 * 1000/100)

  const row = db.prepare('SELECT decayed FROM sales_forecast WHERE date = ?').get('2026-09-18');
  assert.strictEqual(row.decayed, 1);

  server.close();
  db.close();
});

test('PUT /api/forecast does not re-apply decay on a second call for the same date', async () => {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const friesId = db.prepare(`
    INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, active)
    VALUES ('Fries', 'Freezer', 'Box', 1, 1, 1)
  `).run().lastInsertRowid;
  applyEvent(db, { itemId: friesId, type: 'delivery', qtyDelta: 20, occurredAt: '2026-09-17' });

  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-18', actualSales: 1000 }] }),
  });
  const res2 = await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-18', actualSales: 1000 }] }),
  });
  const body2 = await res2.json();
  assert.deepStrictEqual(body2.decayedDates, []); // already decayed, no second application
  assert.strictEqual(getOnHand(db, friesId), 10); // unchanged from the first application

  server.close();
  db.close();
});

test('PUT /api/forecast corrects stock when an applied real-sales figure is changed', async () => {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const friesId = db.prepare(`
    INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, active)
    VALUES ('Fries', 'Freezer', 'Box', 1, 1, 1)
  `).run().lastInsertRowid;
  applyEvent(db, { itemId: friesId, type: 'delivery', qtyDelta: 20, occurredAt: '2026-09-17' });

  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-18', actualSales: 1000 }] }),
  });
  const res2 = await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-18', actualSales: 1200 }] }),
  });
  const body2 = await res2.json();
  assert.deepStrictEqual(body2.decayedDates, []);
  assert.deepStrictEqual(body2.correctedDates, [{ date: '2026-09-18', from: 1000, to: 1200, stockChanged: true }]);
  assert.strictEqual(getOnHand(db, friesId), 8); // 20 - 12, as if 1200 had been entered in the first place

  server.close();
  db.close();
});

test('PUT /api/forecast setting only forecastedSales never triggers decay', async () => {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-20', forecastedSales: 4000 }] }),
  });
  const body = await res.json();
  assert.deepStrictEqual(body.decayedDates, []);

  server.close();
  db.close();
});

test('PUT /api/forecast setting actualSales later does not clobber an existing forecastedSales', async () => {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-01-01')").run(); // baseline count taken long ago
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/forecast', createForecastRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-18', forecastedSales: 4000 }] }),
  });
  await fetch(`${base}/api/forecast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ date: '2026-09-18', actualSales: 3900 }] }),
  });

  const row = db.prepare('SELECT * FROM sales_forecast WHERE date = ?').get('2026-09-18');
  assert.strictEqual(row.forecasted_sales, 4000); // preserved, not overwritten with NULL
  assert.strictEqual(row.actual_sales, 3900);

  server.close();
  db.close();
});
