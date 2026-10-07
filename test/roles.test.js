// Access levels: crew log and count; managers also change orders, settings, the item master, users and records.
const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');
const { createApp } = require('../server');
const { createSession, COOKIE_NAME } = require('../lib/auth');

let asToken;
async function withPeople(fn) {
  const db = getDb(':memory:');
  const add = (name, role) => db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, 'x:y', ?)").run(name, name.toLowerCase() + '@x.co', role).lastInsertRowid;
  const ids = { manager: add('Mia', 'manager'), crew: add('Cal', 'crew') };
  const tokens = { manager: createSession(db, ids.manager).token, crew: createSession(db, ids.crew).token };
  const server = createApp(db, { today: () => '2026-09-23', secureCookies: false }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = (who) => async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${tokens[who]}` }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const itemId = db.prepare("INSERT INTO items (name, category, unit_label, supplier_unit, items_per_order_unit, track_use_by) VALUES ('Beef', 'Chiller', 'Case', 'Each', 10, 1)").run().lastInsertRowid;
  asToken = (token) => async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${token}` }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ db, ids, manager: as('manager'), crew: as('crew'), itemId }); } finally { server.close(); db.close(); }
}

test('crew can log waste and deliveries, fill in the count sheet, date stock and see the plan', async () => {
  await withPeople(async ({ crew, itemId }) => {
    assert.strictEqual((await crew('GET', '/auth/me')).body.role, 'crew');
    assert.strictEqual((await crew('POST', '/deliveries', { deliveredAt: '2026-09-23', lines: [{ itemId, qty: 2, useByDate: '2026-09-27' }] })).status, 201);
    assert.strictEqual((await crew('POST', '/waste', { itemId, qty: 1, unit: 'native', occurredAt: '2026-09-23', shift: 'open', reason: 'Dropped' })).status, 201);
    assert.strictEqual((await crew('PUT', '/counts/draft/items', { entries: { [itemId]: '15' } })).status, 200);
    const batch = (await crew('GET', '/batches')).body[0];
    assert.strictEqual((await crew('POST', `/batches/${batch.id}/split`, { qty: 0.5, useByDate: '2026-09-25' })).status, 201);
    assert.strictEqual((await crew('GET', '/orders/plan')).status, 200);
  });
});

test('crew can\'t change orders, sales, settings, items, users or saved records', async () => {
  await withPeople(async ({ manager, crew, itemId }) => {
    const delivery = (await manager('POST', '/deliveries', { deliveredAt: '2026-09-21', lines: [{ itemId, qty: 1, useByDate: '2026-09-26' }] })).body;
    const waste = (await manager('POST', '/waste', { itemId, qty: 1, unit: 'native', occurredAt: '2026-09-22', shift: 'open', reason: 'Dropped' })).body;
    const batch = (await manager('GET', '/batches')).body[0];
    const refused = [
      ['PUT', '/orders/confirm', { date: '2026-09-25', lines: [] }],
      ['DELETE', '/orders/confirm/2026-09-25'],
      ['PUT', '/forecast', { entries: [{ date: '2026-09-22', actualSales: 4000 }] }],
      ['PUT', '/settings', { targetCost: 1 }],
      ['PUT', `/items/${itemId}`, { buffer_value: 9 }],
      ['POST', '/items', { name: 'X', category: 'Chiller', unit_label: 'Case', items_per_order_unit: 1 }],
      ['POST', '/counts', { countedAt: '2026-09-23', lines: [{ itemId, countedQty: 1, unit: 'order' }] }],
      ['DELETE', '/counts/draft'],
      ['PUT', `/waste/${waste.id}`, { qty: 2, unit: 'native', occurredAt: '2026-09-22', shift: 'open' }],
      ['DELETE', `/waste/${waste.id}`],
      ['DELETE', `/deliveries/${delivery.id}`],
      ['PUT', `/deliveries/${delivery.id}/lines/${itemId}`, { qty: 3 }],
      ['PUT', `/batches/${batch.id}`, { use_by_date: '2026-09-30' }],
      ['POST', '/inventory/adjust', { itemId, qty: 5, unit: 'order' }],
      ['POST', '/prompts/skip-delivery', { date: '2026-09-21' }],
      ['GET', '/users'],
    ];
    for (const [method, url, body] of refused) {
      const res = await crew(method, url, body);
      assert.strictEqual(res.status, 403, `${method} ${url}`);
      assert.match(res.body.error, /manager/);
    }
    assert.strictEqual((await manager('PUT', '/settings', { targetCost: 3000 })).status, 200);
  });
});

test('managers look after crew only; admins manage managers, access and admins - but never the last admin', async () => {
  await withPeople(async ({ db, ids, manager, crew }) => {
    const added = await manager('POST', '/users', { name: 'Dee', email: 'dee@x.co', password: 'longenough', role: 'crew' });
    assert.strictEqual(added.status, 201);
    assert.strictEqual((await manager('POST', '/users', { name: 'Dup', email: 'DEE@x.co', password: 'longenough', role: 'crew' })).status, 409);
    assert.strictEqual((await manager('POST', '/users', { name: 'Short', email: 's@x.co', password: 'short', role: 'crew' })).status, 400);
    // a manager can't add or promote managers, but can reset crew passwords, sign crew out and remove crew
    assert.strictEqual((await manager('POST', '/users', { name: 'Max', email: 'max@x.co', password: 'longenough', role: 'manager' })).status, 403);
    assert.strictEqual((await manager('PUT', `/users/${ids.crew}`, { role: 'manager' })).status, 403);
    assert.strictEqual((await manager('POST', `/users/${added.body.id}/password`, { password: 'anotherlongone' })).status, 200);
    assert.strictEqual((await manager('POST', `/users/${added.body.id}/signout`)).status, 200);
    assert.strictEqual((await manager('POST', `/users/${added.body.id}/remove`)).status, 200);
    assert.strictEqual((await manager('POST', `/users/${added.body.id}/restore`)).status, 200);
    assert.strictEqual((await manager('GET', '/admin/stores')).status, 403);

    // an admin manages managers too
    const adminId = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Ava', 'ava@x.co', 'x:y', 'admin')").run().lastInsertRowid;
    const { createSession } = require('../lib/auth');
    const admin = asToken(createSession(db, adminId).token);
    assert.strictEqual((await admin('PUT', `/users/${ids.crew}`, { role: 'manager' })).body.role, 'manager');
    assert.strictEqual((await admin('POST', `/users/${ids.manager}/remove`)).status, 200);
    assert.strictEqual((await manager('GET', '/auth/me')).status, 401);
    assert.strictEqual((await admin('POST', `/users/${ids.manager}/restore`)).status, 200);
    // the last admin can't be demoted or removed, and nobody changes their own access
    assert.strictEqual((await admin('PUT', `/users/${adminId}`, { role: 'manager' })).status, 400);
    const second = (await admin('POST', '/users', { name: 'Bo', email: 'bo@x.co', password: 'longenough', role: 'admin' })).body;
    assert.strictEqual(second.role, 'admin');
    assert.strictEqual((await admin('PUT', `/users/${second.id}`, { role: 'manager' })).status, 200);
    assert.strictEqual((await admin('POST', `/users/${adminId}/remove`)).status, 400);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").get().n, 1);
    // everything is in the admin log
    const actions = (await admin('GET', '/admin/activity')).body.rows.map(r => r.action);
    for (const a of ['Person added', 'Access changed', 'Password reset', 'Person removed', 'Person restored']) assert.ok(actions.includes(a), a);
  });
});
