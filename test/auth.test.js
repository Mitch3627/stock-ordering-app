const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { getDb } = require('../db/connection');
const { createAuthRouter } = require('../routes/auth');
const { hashPassword, requireAuth } = require('../lib/auth');

function setup() {
  const db = getDb(':memory:');
  db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run('Aaron Mitchell', 'aaron@example.com', hashPassword('correcthorse'));
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(db, { secureCookies: false }));
  app.get('/api/protected', requireAuth(db), (req, res) => res.json({ hello: req.user.name }));
  const server = app.listen(0);
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

test('correct login sets a cookie and never returns the password hash', async () => {
  const { server, base, db } = setup();
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aaron@example.com', password: 'correcthorse' }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(Object.keys(body).sort(), ['email', 'id', 'name', 'role']);
  assert.ok(cookieFrom(res).startsWith('bi_session='));
  server.close(); db.close();
});

test('email is case-insensitive; wrong password or unknown email is rejected', async () => {
  const { server, base, db } = setup();
  const ok = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'Aaron@Example.com', password: 'correcthorse' }),
  });
  assert.strictEqual(ok.status, 200);
  const bad1 = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aaron@example.com', password: 'wrong' }),
  });
  assert.strictEqual(bad1.status, 401);
  const bad2 = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }),
  });
  assert.strictEqual(bad2.status, 401);
  server.close(); db.close();
});

test('a protected route needs a valid session; the login route itself does not', async () => {
  const { server, base } = setup();
  const noAuth = await fetch(`${base}/api/protected`);
  assert.strictEqual(noAuth.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aaron@example.com', password: 'correcthorse' }),
  });
  const cookie = cookieFrom(login);
  const withAuth = await fetch(`${base}/api/protected`, { headers: { Cookie: cookie } });
  assert.strictEqual(withAuth.status, 200);
  assert.deepStrictEqual(await withAuth.json(), { hello: 'Aaron Mitchell' });
  server.close();
});

test('logout invalidates the session', async () => {
  const { server, base } = setup();
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aaron@example.com', password: 'correcthorse' }),
  });
  const cookie = cookieFrom(login);
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const after = await fetch(`${base}/api/protected`, { headers: { Cookie: cookie } });
  assert.strictEqual(after.status, 401);
  server.close();
});

test('an expired session is rejected', async () => {
  const { server, base, db } = setup();
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aaron@example.com', password: 'correcthorse' }),
  });
  const cookie = cookieFrom(login);
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01'").run();
  const after = await fetch(`${base}/api/protected`, { headers: { Cookie: cookie } });
  assert.strictEqual(after.status, 401);
  server.close(); db.close();
});

test('changing a password requires the current one and a minimum length', async () => {
  const { server, base } = setup();
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aaron@example.com', password: 'correcthorse' }),
  });
  const cookie = cookieFrom(login);
  const bad = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'newlongpassword' }),
  });
  assert.strictEqual(bad.status, 400);
  const ok = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPassword: 'correcthorse', newPassword: 'newlongpassword' }),
  });
  assert.strictEqual(ok.status, 200);
  const reLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aaron@example.com', password: 'newlongpassword' }),
  });
  assert.strictEqual(reLogin.status, 200);
  server.close();
});

const { hashToken, createSession } = require('../lib/auth');
const { migrate } = require('../db/connection');
const signIn = (base, password = 'correcthorse', email = 'aaron@example.com') => fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
});

test('only a hash of the session token is stored, so a backup holds no working sign-ins', async () => {
  const { server, base, db } = setup();
  const cookie = cookieFrom(await signIn(base));
  const token = cookie.split('=')[1];
  const stored = db.prepare('SELECT token FROM sessions').all().map(r => r.token);
  assert.deepStrictEqual(stored, [hashToken(token)]);
  server.close(); db.close();
});

test("another app's malformed cookie doesn't lock anyone out, and older 'session' cookies still work", async () => {
  const { server, base, db } = setup();
  const cookie = cookieFrom(await signIn(base));
  const res = await fetch(`${base}/api/protected`, { headers: { Cookie: `other=%E0%A4%A; ${cookie}` } });
  assert.strictEqual(res.status, 200);
  const { token } = createSession(db, 1); // signed in before the cookie was renamed
  const legacy = await fetch(`${base}/api/protected`, { headers: { Cookie: `session=${token}` } });
  assert.strictEqual(legacy.status, 200);
  server.close(); db.close();
});

test('a session that expired earlier today is rejected (not at midnight UTC)', async () => {
  const { server, base, db } = setup();
  const cookie = cookieFrom(await signIn(base));
  db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 60000).toISOString());
  assert.strictEqual((await fetch(`${base}/api/protected`, { headers: { Cookie: cookie } })).status, 401);
  server.close(); db.close();
});

test('changing a password signs out the other devices but not this one', async () => {
  const { server, base, db } = setup();
  const here = cookieFrom(await signIn(base));
  const other = cookieFrom(await signIn(base));
  const res = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: here },
    body: JSON.stringify({ currentPassword: 'correcthorse', newPassword: 'anotherlongone' }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await fetch(`${base}/api/protected`, { headers: { Cookie: here } })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/protected`, { headers: { Cookie: other } })).status, 401);
  server.close(); db.close();
});

test('too many failed sign-ins lock that email out for a while', async () => {
  const { server, base, db } = setup();
  for (let i = 0; i < 10; i++) assert.strictEqual((await signIn(base, 'wrong')).status, 401);
  assert.strictEqual((await signIn(base)).status, 429); // even the right password waits
  server.close(); db.close();
});

test('a removed user can no longer sign in or use an old session', async () => {
  const { server, base, db } = setup();
  const cookie = cookieFrom(await signIn(base));
  db.prepare("UPDATE users SET disabled_at = datetime('now')").run();
  assert.strictEqual((await fetch(`${base}/api/protected`, { headers: { Cookie: cookie } })).status, 401);
  assert.strictEqual((await signIn(base)).status, 401);
  server.close(); db.close();
});

test('upgrading hashes session tokens saved before hashing, so those sign-ins keep working', () => {
  const db = getDb(':memory:');
  db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('A', 'a@x', 'x:y')").run();
  db.prepare("DELETE FROM meta WHERE key = 'sessions_hashed'").run();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('rawtoken', 1, '2099-01-01T00:00:00.000Z')").run();
  migrate(db);
  assert.strictEqual(db.prepare('SELECT token FROM sessions').get().token, hashToken('rawtoken'));
  migrate(db); // only once
  assert.strictEqual(db.prepare('SELECT token FROM sessions').get().token, hashToken('rawtoken'));
  db.close();
});
