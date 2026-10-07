const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../db/connection');
const { createApp } = require('../server');

test('createApp serves the items API and static frontend', async () => {
  const db = getDb(':memory:');
  const { hashPassword } = require('../lib/auth');
  db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run('Test', 't@example.com', hashPassword('password123'));
  const app = createApp(db, { today: () => '2026-09-13' });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const noAuth = await fetch(`${base}/api/items`);
  assert.strictEqual(noAuth.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 't@example.com', password: 'password123' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const apiRes = await fetch(`${base}/api/items`, { headers: { Cookie: cookie } });
  assert.strictEqual(apiRes.status, 200);
  assert.deepStrictEqual(await apiRes.json(), []);

  const pageRes = await fetch(`${base}/`);
  assert.strictEqual(pageRes.status, 200);
  assert.match(await pageRes.text(), /<html/i);

  server.close();
  db.close();
});

test('pages come with basic security headers', async () => {
  const db = getDb(':memory:');
  const server = createApp(db).listen(0);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/login.html`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
  server.close(); db.close();
});
