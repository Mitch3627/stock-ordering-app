const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');

test('getDb creates all expected tables', () => {
  const db = getDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name"
  ).all().map(r => r.name);
  assert.deepStrictEqual(tables, [
    'batch_consumptions', 'batches', 'confirmed_order_lines', 'count_draft', 'count_lines', 'counts', 'deliveries', 'delivery_lines', 'expiry_writeoffs',
    'inventory_events', 'inventory_ledger', 'items', 'meta', 'order_confirmations', 'sales_forecast', 'sessions', 'settings',
    'skipped_deliveries', 'users', 'waste_entries'
  ]);
  db.close();
});

test('getDb allows inserting and reading an item', () => {
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO items (name, category, unit_label, items_per_order_unit)
              VALUES (?, ?, ?, ?)`).run('Fries', 'Freezer', 'Box', 1);
  const row = db.prepare('SELECT * FROM items WHERE name = ?').get('Fries');
  assert.strictEqual(row.name, 'Fries');
  assert.strictEqual(row.category, 'Freezer');
  db.close();
});

test('getDb adds actual_sales and decayed columns to sales_forecast', () => {
  const db = getDb(':memory:');
  const columns = db.prepare("PRAGMA table_info(sales_forecast)").all().map(c => c.name);
  assert.ok(columns.includes('actual_sales'), 'expected actual_sales column');
  assert.ok(columns.includes('decayed'), 'expected decayed column');

  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales) VALUES (?, ?)').run('2026-09-18', 4000);
  const row = db.prepare('SELECT * FROM sales_forecast WHERE date = ?').get('2026-09-18');
  assert.strictEqual(row.actual_sales, null);
  assert.strictEqual(row.decayed, 0);
  db.close();
});
