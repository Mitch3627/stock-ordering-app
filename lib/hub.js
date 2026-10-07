// The hub: sign-ins, the list of stores, who works where, and the admin log. One hub serves every store.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const HUB_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'hub.sql'), 'utf8');
const ROLES = ['admin', 'manager', 'crew'];
const RANK = { crew: 1, manager: 2, admin: 3 };

// Adds the hub tables to a database. `storeName` names the store whose data shares this file, if there is one
// (a single-file setup, and the tests); it's created on first use.
function prepareHub(db, { storeName, selfStore = false } = {}) {
  db.exec(HUB_SCHEMA);
  if (selfStore && !db.prepare('SELECT 1 FROM stores').get()) {
    db.prepare('INSERT INTO stores (name, db_path) VALUES (?, NULL)').run(storeName || 'Northgate');
  }
  return db;
}

// Opens the hub file. The first time, an existing single-store database (`legacyDbPath`) becomes the first
// store: its sign-ins move into the hub, and someone has to be an admin, so the longest-standing manager is.
function openHub(hubPath, { legacyDbPath, storeName } = {}) {
  fs.mkdirSync(path.dirname(hubPath), { recursive: true });
  const hub = new Database(hubPath);
  hub.pragma('foreign_keys = ON');
  hub.pragma('journal_mode = WAL');
  hub.pragma('busy_timeout = 5000');
  prepareHub(hub);
  if (!hub.prepare('SELECT 1 FROM stores').get() && legacyDbPath && fs.existsSync(legacyDbPath)) {
    adoptLegacyStore(hub, hubPath, legacyDbPath, storeName || 'Northgate');
  }
  return hub;
}

// Where the running app keeps things (the same rules as server.js), for the command-line tools.
function hubPaths() {
  const legacyDbPath = process.env.INVENTORY_DB || path.join(__dirname, '..', 'data', 'inventory.db');
  const hubPath = process.env.HUB_DB || path.join(path.dirname(legacyDbPath), 'hub.db');
  return { legacyDbPath, hubPath, baseDir: path.dirname(hubPath) };
}

function adoptLegacyStore(hub, hubPath, legacyDbPath, storeName) {
  const legacy = new Database(legacyDbPath, { readonly: true });
  const cols = legacy.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  const users = cols.length ? legacy.prepare('SELECT * FROM users').all() : [];
  const sessions = cols.length ? legacy.prepare('SELECT * FROM sessions').all() : [];
  legacy.close();
  hub.transaction(() => {
    const rel = path.relative(path.dirname(hubPath), legacyDbPath).split(path.sep).join('/');
    const storeId = hub.prepare('INSERT INTO stores (name, db_path) VALUES (?, ?)').run(storeName, rel).lastInsertRowid;
    const addUser = hub.prepare(`INSERT INTO users (id, name, email, password_hash, created_at, disabled_at, role)
      VALUES (@id, @name, @email, @password_hash, @created_at, @disabled_at, @role)`);
    for (const u of users) {
      addUser.run({ ...u, disabled_at: u.disabled_at ?? null, role: RANK[u.role] ? u.role : 'manager' });
      hub.prepare('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)').run(u.id, storeId);
    }
    const addSession = hub.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
    for (const s of sessions) addSession.run(s.token, s.user_id, s.created_at, s.expires_at);
    if (!hub.prepare("SELECT 1 FROM users WHERE role = 'admin' AND disabled_at IS NULL").get()) {
      const first = hub.prepare("SELECT id FROM users WHERE role = 'manager' AND disabled_at IS NULL ORDER BY created_at, id").get();
      if (first) hub.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id);
    }
    audit(hub, null, storeId, 'Store set up', `${storeName}: existing data and ${users.length} sign-in(s) carried over`);
  })();
}

function audit(hub, userId, storeId, action, detail = null) {
  hub.prepare('INSERT INTO audit_log (user_id, store_id, action, detail) VALUES (?, ?, ?, ?)').run(userId ?? null, storeId ?? null, action, detail);
}

const isAdmin = (user) => !!user && user.role === 'admin';
const atLeast = (user, role) => !!user && (RANK[user.role] || 0) >= RANK[role];

// The stores someone can open: admins every open store; others the ones they're assigned to (a store that shares
// the hub's own file is open to everyone who can sign in, as in a single-store setup).
function storesFor(hub, user) {
  if (isAdmin(user)) return hub.prepare('SELECT id, name FROM stores WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE').all();
  return hub.prepare(`SELECT id, name FROM stores WHERE archived_at IS NULL
    AND (db_path IS NULL OR id IN (SELECT store_id FROM user_stores WHERE user_id = ?)) ORDER BY name COLLATE NOCASE`).all(user.id);
}

function storeIdsOf(hub, userId) {
  return hub.prepare('SELECT store_id FROM user_stores WHERE user_id = ? ORDER BY store_id').all(userId).map(r => r.store_id);
}

module.exports = { prepareHub, openHub, hubPaths, audit, storesFor, storeIdsOf, isAdmin, atLeast, ROLES, RANK };
