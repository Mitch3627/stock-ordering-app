const express = require('express');
const {
  hashPassword, verifyPassword, hashToken, createSession, setSessionCookie, clearSessionCookie, getSessionUser,
  sessionToken, endSessions,
} = require('../lib/auth');
const { audit, prepareHub } = require('../lib/hub');
const { currentStore } = require('./stores');

// Failed sign-ins allowed per email address and per device (IP) in a window, before a short lock-out.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

// Sign-in for every store: `db` is the hub (lib/hub.js).
function createAuthRouter(db, options = {}) {
  const secureCookies = options.secureCookies ?? (process.env.NODE_ENV === 'production');
  prepareHub(db);
  const router = express.Router();

  const failures = new Map(); // key -> { count, since }
  const lockedFor = (key) => {
    const f = failures.get(key);
    if (!f) return 0;
    if (Date.now() - f.since > WINDOW_MS) { failures.delete(key); return 0; }
    return f.count >= MAX_FAILURES ? WINDOW_MS - (Date.now() - f.since) : 0;
  };
  const fail = (key) => {
    const f = failures.get(key);
    if (!f || Date.now() - f.since > WINDOW_MS) failures.set(key, { count: 1, since: Date.now() });
    else f.count++;
  };

  // Public: what the sign-in page shows before anyone is signed in.
  // The store's name when there's only one; with several, the sign-in page doesn't name one.
  router.get('/config', (req, res) => {
    const open = db.prepare('SELECT name FROM stores WHERE archived_at IS NULL').all();
    res.json({ storeName: open.length === 1 ? open[0].name : null });
  });

  router.post('/login', async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
      const keys = ['ip:' + req.ip, 'email:' + String(email).trim().toLowerCase()];
      const wait = Math.max(...keys.map(lockedFor));
      if (wait > 0) {
        return res.status(429).json({ error: `Too many attempts - try again in ${Math.ceil(wait / 60000)} minutes` });
      }
      const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND disabled_at IS NULL').get(String(email).trim());
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        keys.forEach(fail);
        return res.status(401).json({ error: 'incorrect email or password' });
      }
      keys.forEach(k => failures.delete(k));
      audit(db, user.id, null, 'Signed in', null);
      const { token, expiresAt } = createSession(db, user.id);
      setSessionCookie(res, token, expiresAt, secureCookies);
      res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const user = getSessionUser(db, req);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    req.user = user;
    const { store, stores } = currentStore(db, req);
    res.json({ ...user, store: store ? store.name : null, storeId: store ? store.id : null, stores });
  });

  // Lets a signed-in person change their own password. Their other sign-ins (other devices) are ended.
  router.post('/change-password', async (req, res, next) => {
    try {
      const user = getSessionUser(db, req);
      if (!user) return res.status(401).json({ error: 'not authenticated' });
      const { currentPassword, newPassword } = req.body || {};
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
      if (!(await verifyPassword(currentPassword || '', row.password_hash))) {
        return res.status(400).json({ error: 'current password is incorrect' });
      }
      if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'new password must be at least 8 characters' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
      endSessions(db, user.id, sessionToken(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
