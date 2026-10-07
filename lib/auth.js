const crypto = require('crypto');
const { promisify } = require('util');
const { runAs } = require('./context');

const scrypt = promisify(crypto.scrypt);

// Password hashing with Node's built-in scrypt - no extra dependency needed.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Checking a password runs off the main thread, so a login doesn't hold up everyone else's requests.
async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = await scrypt(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Only a hash of each session token is stored, so a copy of the database (a backup) holds no working logins.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Minimal cookie parsing (avoids adding the cookie-parser dependency for one field). Cookies on localhost are
// shared by every app on the PC, so one that won't decode is someone else's and is ignored.
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const name = part.slice(0, i).trim();
    let value;
    try { value = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return; }
    if (!(name in out)) out[name] = value;
  });
  return out;
}

const SESSION_DAYS = 30;
const COOKIE_NAME = 'bi_session'; // specific, so it can't clash with another app's "session" cookie
const LEGACY_COOKIE = 'session'; // sign-ins from before the rename keep working until they expire
// Session expiry is stored as an ISO time (2026-09-23T19:43:30.123Z); compare it with "now" in the same format.
const NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function sessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] || cookies[LEGACY_COOKIE] || null;
}

function createSession(db, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ${NOW_ISO}`).run(); // tidy up old sign-ins
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expiresAt);
  return { token, expiresAt };
}

function setSessionCookie(res, token, expiresAt, secure) {
  const parts = [
    `${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [COOKIE_NAME, LEGACY_COOKIE].map(name =>
    `${name}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`));
}

function getSessionUser(db, req) {
  const token = sessionToken(req);
  if (!token) return null;
  const row = db.prepare(`
    SELECT users.id, users.name, users.email, users.role FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > ${NOW_ISO} AND users.disabled_at IS NULL
  `).get(hashToken(token));
  return row || null;
}

// Signs a user out everywhere, or everywhere except the session in `keepToken` (a password change).
function endSessions(db, userId, keepToken = null) {
  if (keepToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, hashToken(keepToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// For actions only a manager (or an admin) may take: orders, settings, the item master, correcting or deleting
// records. Mounted after requireAuth, which sets req.user.
function requireManager(req, res, next) {
  if (req.user && (req.user.role === 'manager' || req.user.role === 'admin')) return next();
  res.status(403).json({ error: 'Only a manager can do that' });
}

// Stores, managers and admins, the activity log and backups.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Only an admin can do that' });
}

// Protects every route it's mounted on; the login route itself must be mounted before this.
function requireAuth(db) {
  return (req, res, next) => {
    const user = getSessionUser(db, req);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    req.user = user;
    runAs(user, next); // lets the stock ledger and other writes record who did it
  };
}

module.exports = {
  hashPassword, verifyPassword, generateToken, hashToken, parseCookies, sessionToken,
  createSession, setSessionCookie, clearSessionCookie, getSessionUser, endSessions, requireAuth, requireManager, requireAdmin,
  COOKIE_NAME,
};
