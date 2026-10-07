-- The shared part: who can sign in, which stores exist and who works where. Each store's stock, orders and
-- settings live in that store's own database file (db/schema.sql).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  disabled_at TEXT, -- set when someone leaves: they can no longer sign in
  -- admin: every store, and manages managers and stores; manager: runs their stores and manages crew there;
  -- crew: logs, counts and dates stock
  role TEXT NOT NULL DEFAULT 'crew' CHECK (role IN ('admin', 'manager', 'crew'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- the store's database file, relative to this file's folder; empty when the store's data shares this file
  db_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT -- hidden from everyone; its data is kept
);

-- Which stores a manager or crew member works at (admins have every store).
CREATE TABLE IF NOT EXISTS user_stores (
  user_id INTEGER NOT NULL REFERENCES users(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  PRIMARY KEY (user_id, store_id)
);

-- Sign-ins and changes to people and stores, for admins.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id INTEGER,
  store_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
