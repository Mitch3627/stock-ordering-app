// Several people at once: a shared count sheet, and a record of who made each change.
const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');
const { createApp } = require('../server');
const { createSession, COOKIE_NAME } = require('../lib/auth');

async function withTwoPeople(fn) {
  const db = getDb(':memory:');
  const addUser = (name) => db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, 'x:y')").run(name, name + '@x').lastInsertRowid;
  const people = { aaron: addUser('Aaron'), sam: addUser('Sam') };
  const tokens = Object.fromEntries(Object.entries(people).map(([k, id]) => [k, createSession(db, id).token]));
  const server = createApp(db, { today: () => '2026-09-27', secureCookies: false }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = (who) => async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const item = (name) => db.prepare(`INSERT INTO items (name, category, unit_label, supplier_unit, items_per_order_unit)
    VALUES (?, 'Freezer', 'Case', 'Each', 10)`).run(name).lastInsertRowid;
  try {
    await fn({ db, people, aaron: as('aaron'), sam: as('sam'), item });
  } finally {
    server.close();
    db.close();
  }
}

test('two people can split a count: each sees the other\'s figures, and saving the count clears the sheet', async () => {
  await withTwoPeople(async ({ aaron, sam, item }) => {
    const fries = item('Fries');
    const buns = item('Buns');
    assert.strictEqual((await aaron('PUT', '/counts/draft/items', { entries: { [fries]: '120' } })).status, 200);
    await sam('PUT', '/counts/draft/items', { entries: { [buns]: '40' } });
    await sam('PUT', '/counts/draft', { countedAt: '2026-09-27' });
    const seen = (await aaron('GET', '/counts/draft')).body;
    assert.deepStrictEqual(seen.entries, { [fries]: '120', [buns]: '40' });
    assert.deepStrictEqual(seen.people.sort(), ['Aaron', 'Sam']);
    assert.strictEqual(seen.countedAt, '2026-09-27');
    assert.strictEqual(seen.startedOn, '2026-09-27');
    // a cleared box removes just that item
    await sam('PUT', '/counts/draft/items', { entries: { [buns]: '' } });
    assert.deepStrictEqual((await aaron('GET', '/counts/draft')).body.entries, { [fries]: '120' });
    const saved = await aaron('POST', '/counts', { countedAt: '2026-09-27', lines: [{ itemId: fries, countedQty: 120, unit: 'native' }] });
    assert.strictEqual(saved.status, 201);
    const after = (await sam('GET', '/counts/draft')).body;
    assert.deepStrictEqual(after.entries, {});
    assert.strictEqual(after.countedAt, null);
  });
});

test('the count sheet rejects figures that aren\'t numbers', async () => {
  await withTwoPeople(async ({ aaron, item }) => {
    const fries = item('Fries');
    assert.strictEqual((await aaron('PUT', '/counts/draft/items', { entries: { [fries]: 'ten' } })).status, 400);
    assert.strictEqual((await aaron('PUT', '/counts/draft/items', { entries: { 999: '1' } })).status, 400);
  });
});

test('stock changes, waste, counts, deliveries and confirmed orders record who made them', async () => {
  await withTwoPeople(async ({ db, people, aaron, sam, item }) => {
    const fries = item('Fries');
    await aaron('POST', '/counts', { countedAt: '2026-09-20', lines: [{ itemId: fries, countedQty: 5, unit: 'order' }] });
    await sam('POST', '/waste', { itemId: fries, qty: 1, unit: 'order', occurredAt: '2026-09-27', shift: 'close', reason: 'Dropped' });
    await aaron('PUT', '/orders/confirm', { date: '2026-09-28', lines: [{ itemId: fries, qty: 2 }] });
    await sam('POST', '/deliveries', { deliveredAt: '2026-09-25', lines: [{ itemId: fries, qty: 2 }] });
    assert.strictEqual(db.prepare('SELECT created_by FROM counts').get().created_by, people.aaron);
    assert.strictEqual(db.prepare('SELECT created_by FROM waste_entries').get().created_by, people.sam);
    assert.strictEqual(db.prepare('SELECT confirmed_by FROM order_confirmations').get().confirmed_by, people.aaron);
    assert.strictEqual(db.prepare('SELECT created_by FROM deliveries').get().created_by, people.sam);
    const byType = Object.fromEntries(db.prepare('SELECT type, user_id FROM inventory_events').all().map(e => [e.type, e.user_id]));
    assert.deepStrictEqual(byType, { count_correction: people.aaron, waste: people.sam, delivery: people.sam });
  });
});
