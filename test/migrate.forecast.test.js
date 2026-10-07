const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { getDb } = require('../db/connection');

test('getDb relaxes an old NOT NULL forecasted_sales and keeps existing rows', () => {
  const file = path.join(os.tmpdir(), `migrate-${Date.now()}.db`);
  const old = new Database(file);
  old.exec(`CREATE TABLE sales_forecast (date TEXT PRIMARY KEY, forecasted_sales REAL NOT NULL, actual_sales REAL, decayed INTEGER NOT NULL DEFAULT 0);
    INSERT INTO sales_forecast VALUES ('2026-09-10', 4000, 4100, 1);`);
  old.close();

  const db = getDb(file);
  db.prepare('INSERT INTO sales_forecast (date, forecasted_sales, actual_sales) VALUES (?, NULL, ?)').run('2026-09-11', 3900);
  const rows = db.prepare('SELECT * FROM sales_forecast ORDER BY date').all();
  assert.deepStrictEqual(rows.map(r => [r.date, r.forecasted_sales, r.actual_sales, r.decayed]),
    [['2026-09-10', 4000, 4100, 1], ['2026-09-11', null, 3900, 0]]);
  db.close();
  fs.unlinkSync(file);
});
