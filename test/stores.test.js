// Several stores in one app: each has its own database file, people only open the stores they work at, and an
// existing single-store database becomes the first store with its sign-ins carried over.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../db/connection');
const { openHub } = require('../lib/hub');
const { StoreRegistry } = require('../lib/stores');
const { createApp, createStoreRouter } = require('../server');
const { createSession, hashPassword, COOKIE_NAME } = require('../lib/auth');

async function withStores(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-test-'));
  // an existing one-store setup: one manager, one item, a sign-in
  const legacyPath = path.join(dir, 'inventory.db');
  const legacy = getDb(legacyPath);
  const aaronId = legacy.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Aaron', 'aaron@x.co', ?, 'manager')").run(hashPassword('longenough')).lastInsertRowid;
  const oldToken = createSession(legacy, aaronId).token;
  legacy.prepare("INSERT INTO items (name, category, unit_label, items_per_order_unit, price_per_unit) VALUES ('Beef', 'Chiller', 'Case', 10, 42)").run();
  legacy.prepare("INSERT INTO settings (key, value) VALUES ('targetCost', '3000')").run();
  legacy.close();

  const hub = openHub(path.join(dir, 'hub.db'), { legacyDbPath: legacyPath, storeName: 'Northgate' });
  const registry = new StoreRegistry(hub, { baseDir: dir, buildRouter: (db) => createStoreRouter(db, { today: () => '2026-09-24' }) });
  const server = createApp(hub, { registry, secureCookies: false }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = (token, storeId) => async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${token}${storeId ? `; bi_store=${storeId}` : ''}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  };
  try {
    await fn({ dir, hub, registry, as, oldToken, aaronId, legacyPath });
  } finally {
    server.close(); registry.close(); hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an existing database becomes the first store; its manager becomes the admin and stays signed in', async () => {
  await withStores(async ({ hub, registry, as, oldToken, legacyPath }) => {
    const me = (await as(oldToken)('GET', '/auth/me')).body;
    assert.strictEqual(me.role, 'admin');
    assert.strictEqual(me.store, 'Northgate');
    assert.strictEqual((await as(oldToken)('GET', '/items')).body.length, 1);
    // the store's own copy of people keeps names only
    const storeDb = registry.get(me.storeId).db;
    assert.strictEqual(storeDb.prepare('SELECT password_hash FROM users').get().password_hash, '');
    assert.strictEqual(storeDb.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.strictEqual(path.resolve(registry.fileOf(registry.row(me.storeId))), path.resolve(legacyPath));
    assert.ok(hub.prepare("SELECT 1 FROM audit_log WHERE action = 'Store set up'").get());
  });
});

test('a new store can start from another store\'s items and settings, with none of its stock', async () => {
  await withStores(async ({ registry, as, oldToken }) => {
    const admin = as(oldToken);
    const created = await admin('POST', '/admin/stores', { name: 'Eastgate', copyFrom: 1 });
    assert.strictEqual(created.status, 201);
    const b = registry.get(created.body.id).db;
    assert.deepStrictEqual(b.prepare('SELECT name, items_per_order_unit, price_per_unit FROM items').all(), [{ name: 'Beef', items_per_order_unit: 10, price_per_unit: 42 }]);
    assert.strictEqual(b.prepare("SELECT value FROM settings WHERE key = 'targetCost'").get().value, '3000');
    assert.strictEqual(b.prepare('SELECT COUNT(*) AS n FROM inventory_events').get().n, 0);
    assert.ok(fs.existsSync(registry.fileOf(created.body)));
    assert.strictEqual((await admin('POST', '/admin/stores', { name: 'eastgate' })).status, 400); // same name
    const empty = (await admin('POST', '/admin/stores', { name: 'Westgate' })).body;
    assert.strictEqual(registry.get(empty.id).db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  });
});

test('people only open the stores they work at, and each store\'s data stays its own', async () => {
  await withStores(async ({ hub, registry, as, oldToken }) => {
    const admin = as(oldToken);
    const birk = (await admin('POST', '/admin/stores', { name: 'Eastgate', copyFrom: 1 })).body;
    const mo = (await admin('POST', '/users', { name: 'Mo', email: 'mo@x.co', password: 'longenough', role: 'manager', stores: [birk.id] })).body;
    const cy = (await admin('POST', '/users', { name: 'Cy', email: 'cy@x.co', password: 'longenough', role: 'crew', stores: [1] })).body;
    const moToken = createSession(hub, mo.id).token;
    const moReq = as(moToken, 1); // asks for Northgate, which Mo doesn't work at

    const me = (await moReq('GET', '/auth/me')).body;
    assert.strictEqual(me.store, 'Eastgate');
    assert.deepStrictEqual(me.stores.map(s => s.name), ['Eastgate']);
    assert.strictEqual((await moReq('POST', '/stores/select', { id: 1 })).status, 400);

    // Mo corrects Eastgate's beef; Northgate's doesn't move
    const beef = (await moReq('GET', '/items')).body[0];
    assert.strictEqual((await moReq('POST', '/inventory/adjust', { itemId: beef.id, qty: 3, unit: 'order' })).status, 200);
    assert.strictEqual(registry.get(birk.id).db.prepare('SELECT COALESCE(SUM(qty_delta), 0) AS q FROM inventory_events').get().q, 3);
    assert.strictEqual(registry.get(1).db.prepare('SELECT COALESCE(SUM(qty_delta), 0) AS q FROM inventory_events').get().q, 0);
    // the change carries Mo's name in Eastgate's own copy of people
    assert.strictEqual(registry.get(birk.id).db.prepare('SELECT u.name FROM inventory_events e JOIN users u ON u.id = e.user_id').get().name, 'Mo');

    // Mo's new crew start at Eastgate; Cy (Northgate) is out of Mo's reach and out of Mo's list
    const newCrew = (await moReq('POST', '/users', { name: 'Di', email: 'di@x.co', password: 'longenough', role: 'crew' })).body;
    assert.deepStrictEqual(newCrew.stores, [birk.id]);
    assert.strictEqual((await moReq('POST', `/users/${cy.id}/remove`)).status, 403);
    assert.ok(!(await moReq('GET', '/users')).body.some(u => u.id === cy.id));
    assert.strictEqual((await moReq('PUT', `/users/${newCrew.id}`, { stores: [1] })).status, 403); // only admins move people

    // the admin switches store
    const switched = await admin('POST', '/stores/select', { id: birk.id });
    assert.strictEqual(switched.status, 200);
    assert.strictEqual((await as(oldToken, birk.id)('GET', '/auth/me')).body.store, 'Eastgate');

    // archiving Eastgate shuts Mo out; restoring lets them back
    assert.strictEqual((await admin('POST', `/admin/stores/${birk.id}/archive`)).status, 200);
    const shut = await moReq('GET', '/items');
    assert.strictEqual(shut.status, 403);
    assert.strictEqual(shut.body.code, 'no-store');
    assert.strictEqual((await admin('POST', `/admin/stores/${birk.id}/restore`)).status, 200);
    assert.strictEqual((await moReq('GET', '/items')).status, 200);
  });
});

test('admins can download a store backup, see the activity log and sign everyone else out', async () => {
  await withStores(async ({ hub, as, oldToken }) => {
    const admin = as(oldToken);
    const backup = await admin('GET', '/admin/stores/1/backup');
    assert.strictEqual(backup.status, 200);
    assert.ok(backup.body.startsWith('SQLite format 3'));
    const crew = (await admin('POST', '/users', { name: 'Cy', email: 'cy@x.co', password: 'longenough', role: 'crew', stores: [1] })).body;
    const crewToken = createSession(hub, crew.id).token;
    assert.strictEqual((await as(crewToken)('GET', '/admin/activity')).status, 403);
    assert.strictEqual((await admin('POST', '/admin/signout-all')).body.ended, 1);
    assert.strictEqual((await as(crewToken)('GET', '/auth/me')).status, 401);
    assert.strictEqual((await admin('GET', '/auth/me')).status, 200); // the admin's own sign-in stays
    const actions = (await admin('GET', '/admin/activity')).body.rows.map(r => r.action);
    assert.ok(actions.includes('Backup downloaded'));
    assert.ok(actions.includes('Everyone signed out'));
  });
});
