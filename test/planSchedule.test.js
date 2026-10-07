const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { getDb } = require('../db/connection');
const { createOrdersRouter, planSchedule } = require('../routes/orders');
const { applyEvent } = require('../ledger/ledger');

const dates = (db, today, n = 4) => planSchedule(db, today, n).map(d => d.date);

test('the plan starts at the next delivery day, not the next Monday', () => {
  const db = getDb(':memory:');
  assert.deepStrictEqual(dates(db, '2026-09-21'), ['2026-09-21', '2026-09-23', '2026-09-25', '2026-09-28']); // Mon
  assert.deepStrictEqual(dates(db, '2026-09-22'), ['2026-09-23', '2026-09-25', '2026-09-28', '2026-09-30']); // Tue
  assert.deepStrictEqual(dates(db, '2026-09-24'), ['2026-09-25', '2026-09-28', '2026-09-30', '2026-10-02']); // Thu
  assert.deepStrictEqual(dates(db, '2026-09-26'), ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05']); // Sat
  db.close();
});

test("today's delivery is left out once it has been logged (its stock is already on hand) or marked not arrived", () => {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO deliveries (delivered_at) VALUES ('2026-09-23')").run();
  assert.strictEqual(dates(db, '2026-09-23')[0], '2026-09-25'); // Wednesday's delivery already received
  db.prepare("INSERT INTO skipped_deliveries (date) VALUES ('2026-09-25')").run();
  assert.strictEqual(dates(db, '2026-09-25')[0], '2026-09-28'); // Friday's marked as not arrived
  db.close();
});

test('the plan endpoint accounts for the deliveries still to come this week', async () => {
  const db = getDb(':memory:');
  const id = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Fries', 'Freezer', 'Box', 1, 0.1, 2, 18)`).run().lastInsertRowid;
  applyEvent(db, { itemId: id, type: 'count_correction', qtyDelta: 30, occurredAt: '2026-09-20' });
  const app = express();
  app.use('/api/orders', createOrdersRouter(db, { today: () => '2026-09-22' })); // Tuesday
  const server = app.listen(0);
  const plan = await (await fetch(`http://127.0.0.1:${server.address().port}/api/orders/plan`)).json();
  assert.strictEqual(plan.deliveries[0], '2026-09-23');
  server.close(); db.close();
});
