const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { getDb } = require('../db/connection');
const { createDashboardRouter } = require('../routes/dashboard');
const { applyEvent } = require('../ledger/ledger');

function setup() {
  const db = getDb(':memory:');
  const butter = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit, track_use_by)
    VALUES ('Butter', 'Chiller', 'Each', 1, 0.2, 2, 5, 1)`).run().lastInsertRowid;
  const fries = db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit)
    VALUES ('Fries', 'Freezer', 'Box', 1, 0.1, 2, 18)`).run().lastInsertRowid;
  applyEvent(db, { itemId: butter, type: 'delivery', qtyDelta: 9, occurredAt: '2026-09-15' });
  applyEvent(db, { itemId: fries, type: 'delivery', qtyDelta: -1, occurredAt: '2026-09-15' });
  const ins = db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining) VALUES (?, '2026-09-15', 5, ?, ?)`);
  ins.run(butter, '2026-09-25', 5);
  ins.run(butter, '2026-09-20', 4);
  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales, actual_sales) VALUES (?, 4000, 4200)').run('2026-09-18');
  const app = express();
  app.use('/api/dashboard', createDashboardRouter(db, { today: () => '2026-09-19' }));
  const server = app.listen(0);
  return { db, server, url: `http://127.0.0.1:${server.address().port}/api/dashboard` };
}

test('dashboard summarises use-by, inventory, sales and delivery', async () => {
  const { db, server, url } = setup();
  const d = await (await fetch(url)).json();
  assert.deepStrictEqual(d.useBy.next.map(b => [b.use_by_date, b.daysLeft]), [['2026-09-20', 1], ['2026-09-25', 6]]);
  assert.strictEqual(d.useBy.soonCount, 1);
  assert.strictEqual(d.inventory.itemsTracked, 2);
  assert.strictEqual(d.inventory.atOrBelowZero, 1);
  assert.strictEqual(d.inventory.lowest[0].name, 'Fries');
  assert.deepStrictEqual([d.sales.projected, d.sales.actual, d.sales.unloggedDays], [4000, 4200, 0]);
  assert.strictEqual(d.nextDelivery.date, '2026-09-21');
  assert.ok(d.nextDelivery.itemCount >= 1);
  assert.strictEqual(d.count.due, false);
  assert.deepStrictEqual(d.master.categories, ['Chiller', 'Freezer']);
  server.close(); db.close();
});
