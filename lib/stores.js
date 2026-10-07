// Each store's data lives in its own database file; this opens them as they're needed and keeps each one's copy
// of people's names (for "logged by") in step with the hub.
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/connection');

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'store';

class StoreRegistry {
  // hub: the hub database; baseDir: the folder store paths are relative to; buildRouter(db, store): the store's API.
  constructor(hub, { baseDir, buildRouter }) {
    this.hub = hub;
    this.baseDir = baseDir;
    this.buildRouter = buildRouter;
    this.open = new Map(); // store id -> { db, router }
  }

  row(id) {
    return this.hub.prepare('SELECT * FROM stores WHERE id = ?').get(Number(id));
  }

  fileOf(store) {
    return store.db_path ? path.resolve(this.baseDir, store.db_path) : null;
  }

  // The store's database and API, opened the first time it's used.
  get(id) {
    const store = this.row(id);
    if (!store) return null;
    let entry = this.open.get(store.id);
    if (!entry) {
      const db = store.db_path ? getDb(this.fileOf(store)) : this.hub;
      if (db !== this.hub) {
        this.syncAllUsers(db);
        db.prepare('DELETE FROM sessions').run(); // sign-ins are only kept in the hub
      }
      entry = { db, router: null };
      this.open.set(store.id, entry);
      entry.router = this.buildRouter(db, store);
    }
    return { store, db: entry.db, router: entry.router };
  }

  all() {
    return this.hub.prepare('SELECT * FROM stores ORDER BY id').all().map(s => this.get(s.id));
  }

  // A store's copy of the people table: names only, no passwords.
  syncUser(db, u) {
    db.prepare(`INSERT INTO users (id, name, email, password_hash, created_at, disabled_at, role)
      VALUES (@id, @name, @email, '', @created_at, @disabled_at, @role)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, password_hash = '',
        disabled_at = excluded.disabled_at, role = excluded.role`).run(u);
  }

  syncAllUsers(db) {
    const users = this.hub.prepare('SELECT id, name, email, created_at, disabled_at, role FROM users').all();
    db.transaction(() => users.forEach(u => this.syncUser(db, u)))();
  }

  // Makes sure the person is in the store's copy before they log anything there.
  ensureUser(storeId, userId) {
    const { db } = this.get(storeId);
    if (db === this.hub || db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return;
    const u = this.hub.prepare('SELECT id, name, email, created_at, disabled_at, role FROM users WHERE id = ?').get(userId);
    if (u) this.syncUser(db, u);
  }

  // After someone is added or changed in the hub.
  userChanged(userId) {
    const u = this.hub.prepare('SELECT id, name, email, created_at, disabled_at, role FROM users WHERE id = ?').get(userId);
    if (!u) return;
    for (const { db } of this.open.values()) if (db !== this.hub) this.syncUser(db, u);
  }

  // A new store with its own database file. `copyFrom` (a store id) starts it with that store's items, case
  // sizes, prices and settings - but none of its stock, deliveries, counts or orders.
  create(name, { copyFrom } = {}) {
    const clean = String(name || '').trim();
    let folder = slug(clean);
    for (let n = 2; fs.existsSync(path.join(this.baseDir, 'stores', folder)); n++) folder = `${slug(clean)}-${n}`;
    const rel = `stores/${folder}/inventory.db`;
    const source = copyFrom ? this.get(copyFrom) : null;
    const id = this.hub.prepare('INSERT INTO stores (name, db_path) VALUES (?, ?)').run(clean, rel).lastInsertRowid;
    const { db } = this.get(id);
    if (source) {
      const cols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name)
        .filter(c => source.db.prepare('PRAGMA table_info(items)').all().some(s => s.name === c));
      const items = source.db.prepare(`SELECT ${cols.join(', ')} FROM items`).all();
      const settings = source.db.prepare('SELECT key, value FROM settings').all();
      db.transaction(() => {
        const insert = db.prepare(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`);
        items.forEach(i => insert.run(i));
        const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        settings.forEach(s => setting.run(s.key, s.value));
      })();
    }
    return this.row(id);
  }

  close() {
    for (const { db } of this.open.values()) if (db !== this.hub && db.open) db.close();
    this.open.clear();
  }
}

module.exports = { StoreRegistry, slug };
