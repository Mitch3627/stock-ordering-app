const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { getDb } = require('../db/connection');
const { createOrdersRouter } = require('../routes/orders');
const { applyEvent } = require('../ledger/ledger');

test('plan orders extra to cover tracked stock that will expire unused', async () => {
  const db = getDb(':memory:');
  const id = db.prepare(`INSERT INTO items
    (name, category, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value, price_per_unit, track_use_by)
    VALUES ('Butter', 'Chiller', 'Each', 1, 0.1, 2, 5, 1)`).run().lastInsertRowid;
  applyEvent(db, { itemId: id, type: 'delivery', qtyDelta: 30, occurredAt: '2026-09-12' });
  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, ?)').run('2026-09-14', 4000);
  const app = express();
  app.use('/api/orders', createOrdersRouter(db, { today: () => '2026-09-13' }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = async () => (await (await fetch(`${base}/api/orders/plan`)).json()).items.find(i => i.id === id).qtys[0];

  const without = await first();
  // all 30 would expire before Monday's delivery lands (use-by Sunday, lost Monday morning
  // -> counted in delivery 0's window), so the plan must order more than when it's not expiring
  db.prepare(`INSERT INTO batches (item_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, '2026-09-12', 1, '2026-09-13', 30)`).run(id);
  const withExpiry = await first();
  assert.ok(withExpiry > without, `expected ${withExpiry} > ${without}`);
  server.close(); db.close();
});
