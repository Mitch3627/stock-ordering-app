const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { getDb } = require('../db/connection');
const { createUsageRouter } = require('../routes/usage');

function setup() {
  const db = getDb(':memory:');
  const gloves = db.prepare(`INSERT INTO items (name, category, unit_label, usage_per_100_sales)
    VALUES ('Gloves', 'Chemicals', 'Case', 0)`).run().lastInsertRowid;
  const onlyOpen = db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Sacks', 'Chemicals', 'Case')`).run().lastInsertRowid;
  const c1 = db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-09-06')").run().lastInsertRowid;
  const c2 = db.prepare("INSERT INTO counts (counted_at) VALUES ('2026-10-04')").run().lastInsertRowid;
  const line = db.prepare(`INSERT INTO count_lines (count_id, item_id, counted_qty, unit_used, converted_qty, expected_qty, variance) VALUES (?, ?, ?, 'order', ?, 0, 0)`);
  line.run(c1, gloves, 10, 10); line.run(c2, gloves, 6, 6); line.run(c1, onlyOpen, 3, 3);
  const d = db.prepare("INSERT INTO deliveries (delivered_at) VALUES (?)");
  const dl = db.prepare('INSERT INTO delivery_lines (delivery_id, item_id, qty) VALUES (?, ?, ?)');
  dl.run(d.run('2026-09-06').lastInsertRowid, gloves, 99); // on the opening count day: already in that count
  dl.run(d.run('2026-09-20').lastInsertRowid, gloves, 4);
  dl.run(d.run('2026-10-04').lastInsertRowid, gloves, 2); // on the closing day: included
  const s = db.prepare('INSERT INTO sales_forecast (date, forecasted_sales, actual_sales) VALUES (?, NULL, ?)');
  for (let day = 7; day <= 30; day++) s.run(`2026-09-${String(day).padStart(2, '0')}`, 1000);
  for (let day = 1; day <= 4; day++) s.run(`2026-10-0${day}`, 1000);
  const app = express();
  app.use('/api/usage', createUsageRouter(db));
  const server = app.listen(0);
  return { db, server, gloves, c1, c2, url: `http://127.0.0.1:${server.address().port}/api/usage` };
}

test('usage = opening + delivered in the period - closing, rate per £100 of real sales', async () => {
  const { db, server, url, gloves, c1, c2 } = setup();
  const r = await (await fetch(`${url}?from=${c1}&to=${c2}`)).json();
  assert.strictEqual(r.sales, 28000);
  assert.strictEqual(r.days, 28);
  assert.strictEqual(r.salesDays, 28);
  const row = r.items.find(i => i.itemId === gloves);
  assert.deepStrictEqual([row.opening, row.delivered, row.closing, row.used], [10, 6, 6, 10]);
  assert.ok(Math.abs(row.suggested - 10 / 280) < 1e-9);
  assert.strictEqual(r.items.length, 1); // item missing from the closing count is left out
  server.close(); db.close();
});

test('GET /api/usage/counts lists counts newest first', async () => {
  const { db, server, url } = setup();
  const list = await (await fetch(`${url}/counts`)).json();
  assert.deepStrictEqual(list.map(c => c.counted_at), ['2026-10-04', '2026-09-06']);
  server.close(); db.close();
});

test('usage report needs two different counts in order', async () => {
  const { db, server, url, c1, c2 } = setup();
  assert.strictEqual((await fetch(`${url}?from=${c2}&to=${c1}`)).status, 400);
  server.close(); db.close();
});
