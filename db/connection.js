const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Adds a column to an existing database that was created before the column existed.
// (Columns added this way can't carry a datetime('now') default - inserts set those explicitly.)
function addColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrate(db) {
  // Counts logged before this point (e.g. a stray test entry) never count as the baseline.
  db.exec("INSERT OR IGNORE INTO meta (key, value) SELECT 'baseline_after_count_id', COALESCE(MAX(id), 0) FROM counts");
  addColumn(db, 'deliveries', 'created_at', 'TEXT');
  addColumn(db, 'deliveries', 'arrived_at', 'TEXT');
  addColumn(db, 'waste_entries', 'ood', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'waste_entries', 'created_at', 'TEXT');
  addColumn(db, 'waste_entries', 'deleted_at', 'TEXT');
  addColumn(db, 'inventory_events', 'source', 'TEXT');
  addColumn(db, 'inventory_events', 'source_id', 'INTEGER');
  addColumn(db, 'items', 'supplier_order_pack', 'REAL');
  addColumn(db, 'items', 'supplier_sort', 'INTEGER');
  addColumn(db, 'batches', 'redated_at', 'TEXT');
  addColumn(db, 'users', 'disabled_at', 'TEXT');
  // Access level: managers can change orders, settings, the item master and correct records; crew log and count.
  // Everyone signed in before roles existed is a manager.
  addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'manager'");
  // who did what
  addColumn(db, 'inventory_events', 'user_id', 'INTEGER');
  addColumn(db, 'deliveries', 'created_by', 'INTEGER');
  addColumn(db, 'waste_entries', 'created_by', 'INTEGER');
  addColumn(db, 'counts', 'created_by', 'INTEGER');
  addColumn(db, 'counts', 'created_at', 'TEXT');
  addColumn(db, 'order_confirmations', 'confirmed_by', 'INTEGER');
  // Session tokens are stored hashed (lib/auth.js); hash any saved before that so those sign-ins keep working.
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'sessions_hashed'").get()) {
    const { hashToken } = require('../lib/auth');
    db.transaction(() => {
      for (const s of db.prepare('SELECT rowid, token FROM sessions').all()) {
        db.prepare('UPDATE sessions SET token = ? WHERE rowid = ?').run(hashToken(s.token), s.rowid);
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('sessions_hashed', '1')").run();
    })();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_item_date ON inventory_events (item_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_events_source ON inventory_events (source, source_id);
    CREATE INDEX IF NOT EXISTS idx_consumptions_event ON batch_consumptions (event_id);
    CREATE INDEX IF NOT EXISTS idx_batches_item ON batches (item_id, use_by_date);
    CREATE INDEX IF NOT EXISTS idx_delivery_lines_delivery ON delivery_lines (delivery_id, item_id);
    CREATE INDEX IF NOT EXISTS idx_count_lines_count ON count_lines (count_id);
    CREATE INDEX IF NOT EXISTS idx_waste_date ON waste_entries (occurred_at);
  `);
  addColumn(db, 'delivery_lines', 'ordered_qty', 'REAL');
  addColumn(db, 'items', 'supplier_unit', 'TEXT');
  addColumn(db, 'items', 'supplier_product_id', 'INTEGER');
  addColumn(db, 'items', 'track_use_by', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'sales_forecast', 'actual_sales', 'REAL');
  addColumn(db, 'sales_forecast', 'decayed', 'INTEGER NOT NULL DEFAULT 0');
  // Older databases were created with forecasted_sales NOT NULL; real sales can arrive for a day
  // that never had a forecast, so rebuild the table with the column nullable.
  const forecastCol = db.prepare('PRAGMA table_info(sales_forecast)').all().find(c => c.name === 'forecasted_sales');
  if (forecastCol && forecastCol.notnull) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE sales_forecast_new (
          date TEXT PRIMARY KEY,
          forecasted_sales REAL,
          actual_sales REAL,
          decayed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO sales_forecast_new (date, forecasted_sales, actual_sales, decayed)
          SELECT date, forecasted_sales, actual_sales, decayed FROM sales_forecast;
        DROP TABLE sales_forecast;
        ALTER TABLE sales_forecast_new RENAME TO sales_forecast;
      `);
    })();
  }
}

function getDb(dbPath) {
  const target = dbPath || path.join(__dirname, '..', 'data', 'inventory.db');
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new Database(target);
  db.pragma('foreign_keys = ON');
  // Several people (and the hourly backup) can use it at once: readers don't block a writer, and a write waits up
  // to 5 seconds for another to finish instead of failing.
  if (target !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

module.exports = { getDb, migrate };
