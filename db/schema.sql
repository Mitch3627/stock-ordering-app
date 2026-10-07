CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  supplier_name TEXT,
  supplier_product_id INTEGER,
  supplier_unit TEXT,
  -- supplier units in one supplier order unit, when that differs from the app's order unit (e.g. Hashbrowns: 2.5 KG)
  supplier_order_pack REAL,
  supplier_sort INTEGER, -- position in the supplier's order guide, so copied orders follow its order
  unit_label TEXT NOT NULL,
  items_per_order_unit REAL NOT NULL DEFAULT 1,
  usage_per_100_sales REAL NOT NULL DEFAULT 0,
  buffer_value REAL NOT NULL DEFAULT 0,
  max_boxes REAL,
  case_multiple REAL,
  price_per_unit REAL,
  shelf_life_days REAL,
  track_use_by INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  item_id INTEGER PRIMARY KEY REFERENCES items(id),
  on_hand_qty REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  type TEXT NOT NULL CHECK(type IN ('delivery','waste','usage_decay','count_correction')),
  qty_delta REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- what the event belongs to, e.g. source 'waste' + the waste entry's id, so it can be reversed exactly
  source TEXT,
  source_id INTEGER,
  user_id INTEGER REFERENCES users(id) -- who made the change (null for automatic ones, e.g. overnight usage)
);

-- Which dated batches each stock-out event took from, so an undo can put stock back where it came from.
-- A negative qty is stock put back.
CREATE TABLE IF NOT EXISTS batch_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES inventory_events(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  qty REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- the delivery slot (Mon / Wed / Fri) this delivery fills
  delivered_at TEXT NOT NULL,
  -- the day it actually arrived, when that differs from the slot
  arrived_at TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL,
  ordered_qty REAL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  delivery_id INTEGER REFERENCES deliveries(id),
  received_at TEXT NOT NULL,
  shelf_life_days REAL NOT NULL,
  use_by_date TEXT NOT NULL,
  qty_remaining REAL NOT NULL,
  redated_at TEXT -- set when part or all of a batch was given a new use-by date by hand
);

CREATE TABLE IF NOT EXISTS waste_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  shift TEXT NOT NULL CHECK(shift IN ('open','close')),
  reason TEXT,
  note TEXT,
  ood INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Sign-ins live in the hub (db/hub.sql). A store's own copy of this table only keeps names for "logged by",
-- without passwords (lib/stores.js keeps it in step); a single-file setup signs in from here.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  disabled_at TEXT, -- set when someone leaves: they can no longer sign in
  role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('admin', 'manager', 'crew'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- An order that has been placed with the supplier for a delivery date. Its quantities are fixed and
-- count as stock arriving on the morning of that delivery when later deliveries are planned.
CREATE TABLE IF NOT EXISTS order_confirmations (
  delivery_date TEXT PRIMARY KEY,
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by INTEGER REFERENCES users(id)
);

-- The count being entered right now, shared so two people can split a count. Values as typed, in the supplier's unit.
CREATE TABLE IF NOT EXISTS count_draft (
  item_id INTEGER PRIMARY KEY REFERENCES items(id),
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS confirmed_order_lines (
  delivery_date TEXT NOT NULL REFERENCES order_confirmations(delivery_date) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL,
  PRIMARY KEY (delivery_date, item_id)
);

CREATE TABLE IF NOT EXISTS skipped_deliveries (
  date TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS expiry_writeoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  qty REAL NOT NULL,
  claimed REAL NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS count_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id INTEGER NOT NULL REFERENCES counts(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  counted_qty REAL NOT NULL,
  unit_used TEXT NOT NULL CHECK(unit_used IN ('order','native')),
  converted_qty REAL NOT NULL,
  expected_qty REAL NOT NULL,
  variance REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_forecast (
  date TEXT PRIMARY KEY,
  forecasted_sales REAL,
  actual_sales REAL,
  decayed INTEGER NOT NULL DEFAULT 0
);

-- Store settings changed on the Settings page (delivery and order days, cost target...), as JSON values.
-- Anything not here uses the default in lib/settings.js.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
