// The waste log and delivery history load the last 60 days unless older entries are asked for.
const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');
const { createApp } = require('../server');
const { createSession, COOKIE_NAME } = require('../lib/auth');

test('waste ?from and deliveries ?since leave out older entries; without them everything comes back', async () => {
  const db = getDb(':memory:');
  const uid = db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('T', 't@x', 'x:y')").run().lastInsertRowid;
  const { token } = createSession(db, uid);
  const itemId = db.prepare("INSERT INTO items (name, category, unit_label, supplier_unit, items_per_order_unit) VALUES ('Fries', 'Freezer', 'Case', 'KG', 1)").run().lastInsertRowid;
  const server = createApp(db, { today: () => '2026-09-23', secureCookies: false }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => (await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${token}` }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  try {
    for (const date of ['2026-06-01', '2026-09-20']) {
      await call('POST', '/waste', { itemId, qty: 1, unit: 'order', occurredAt: date, shift: 'close', reason: 'Dropped', allowRepeat: true });
      await call('POST', '/deliveries', { deliveredAt: date, lines: [{ itemId, qty: 2 }] });
    }
    assert.deepStrictEqual((await call('GET', '/waste?from=2026-07-25')).map(w => w.occurred_at), ['2026-09-20']);
    assert.strictEqual((await call('GET', '/waste')).length, 2);
    const recent = await call('GET', '/deliveries?since=2026-07-25');
    assert.deepStrictEqual(recent.map(d => d.delivered_at), ['2026-09-20']);
    assert.strictEqual(recent[0].lines.length, 1);
    assert.strictEqual((await call('GET', '/deliveries')).length, 2);
  } finally {
    server.close();
    db.close();
  }
});
