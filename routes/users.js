const express = require('express');
const { hashPassword, requireManager, endSessions } = require('../lib/auth');
const { audit, storeIdsOf, storesFor, ROLES } = require('../lib/hub');
const { badRequest } = require('../lib/validate');

const ROLE_NAMES = { admin: 'Admin', manager: 'Manager', crew: 'Crew' };

// People and their access. Admins manage everyone and choose which stores people work at. Managers manage the crew
// at their stores and add new crew to the store they're in. There's always at least one admin, and nobody can
// change their own access or remove themselves, so no one gets locked out.
function createUsersRouter(hub, registry) {
  const router = express.Router();
  router.use(requireManager);

  const find = (id) => hub.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  const shown = (u, actor) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at, removed_at: u.disabled_at,
    stores: storeIdsOf(hub, u.id), canManage: canManage(actor, u),
  });
  const otherAdmins = (id) => hub.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?").get(id).n;
  const openStores = (u) => storesFor(hub, u).map(s => s.id);
  const sharesStore = (a, b) => openStores(b).some(id => openStores(a).includes(id));
  // Admins manage anyone but themselves; managers manage crew who work at one of their stores.
  function canManage(actor, u) {
    if (u.id === actor.id) return false;
    if (actor.role === 'admin') return true;
    return u.role === 'crew' && sharesStore(actor, u);
  }
  const mustManage = (req, u) => {
    if (u.id === req.user.id) throw badRequest("You can't do that to your own account – ask an admin");
    if (!canManage(req.user, u)) {
      const e = new Error(req.user.role === 'admin' ? 'Not allowed' : 'Only an admin can change managers, or crew at other stores');
      e.status = 403; throw e;
    }
  };
  const checkPassword = (p) => { if (typeof p !== 'string' || p.length < 8) throw badRequest('The password must be at least 8 characters'); };
  const checkStores = (ids) => {
    if (!Array.isArray(ids)) throw badRequest('Choose their stores');
    const known = hub.prepare('SELECT id FROM stores').all().map(s => s.id);
    const clean = [...new Set(ids.map(Number))];
    if (clean.some(id => !known.includes(id))) throw badRequest('Unknown store');
    return clean;
  };
  const setStores = (userId, ids) => {
    hub.prepare('DELETE FROM user_stores WHERE user_id = ?').run(userId);
    const add = hub.prepare('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)');
    ids.forEach(id => add.run(userId, id));
  };
  const storeNames = (ids) => ids.map(id => (hub.prepare('SELECT name FROM stores WHERE id = ?').get(id) || {}).name).filter(Boolean).join(', ') || 'none';
  const log = (req, action, detail) => audit(hub, req.user.id, req.store && req.store.id, action, detail);

  router.get('/', (req, res) => {
    const all = hub.prepare('SELECT * FROM users ORDER BY disabled_at IS NOT NULL, name COLLATE NOCASE').all();
    // Managers see the people at their stores; admins see everyone.
    const visible = req.user.role === 'admin' ? all : all.filter(u => u.id === req.user.id || (u.role !== 'admin' && sharesStore(req.user, u)));
    res.json(visible.map(u => shown(u, req.user)));
  });

  router.post('/', (req, res) => {
    const { name, email, password } = req.body || {};
    let { role, stores } = req.body || {};
    if (!name || !String(name).trim()) throw badRequest('Enter their name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())) throw badRequest('Enter a valid email address');
    checkPassword(password);
    if (!ROLES.includes(role)) throw badRequest('Choose their access');
    if (req.user.role !== 'admin') {
      if (role !== 'crew') { const e = new Error('Only an admin can add managers'); e.status = 403; throw e; }
      stores = [req.store.id]; // a manager's new crew start at the store they're in
    } else {
      stores = role === 'admin' ? [] : checkStores(stores || []);
    }
    if (hub.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim())) {
      return res.status(409).json({ error: 'Someone already signs in with that email' });
    }
    const id = hub.transaction(() => {
      const newId = hub.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(String(name).trim(), String(email).trim(), hashPassword(password), role).lastInsertRowid;
      setStores(newId, stores);
      return newId;
    })();
    registry.userChanged(id);
    log(req, 'Person added', `${String(name).trim()} (${ROLE_NAMES[role]}) – stores: ${role === 'admin' ? 'all' : storeNames(stores)}`);
    res.status(201).json(shown(find(id), req.user));
  });

  // Change someone's name, access or stores.
  router.put('/:id', (req, res) => {
    const user = find(req.params.id);
    if (!user) return res.status(404).json({ error: 'not found' });
    mustManage(req, user);
    const { name, role, stores } = req.body || {};
    hub.transaction(() => {
      if (role !== undefined && role !== user.role) {
        if (req.user.role !== 'admin') { const e = new Error('Only an admin can change access'); e.status = 403; throw e; }
        if (!ROLES.includes(role)) throw badRequest('Choose their access');
        if (user.role === 'admin' && otherAdmins(user.id) === 0) throw badRequest('There has to be at least one admin');
        hub.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
        log(req, 'Access changed', `${user.name}: ${ROLE_NAMES[user.role]} → ${ROLE_NAMES[role]}`);
      }
      if (stores !== undefined) {
        if (req.user.role !== 'admin') { const e = new Error('Only an admin can change which stores people work at'); e.status = 403; throw e; }
        const ids = checkStores(stores);
        setStores(user.id, ids);
        log(req, 'Stores changed', `${user.name}: ${storeNames(ids)}`);
      }
      if (name !== undefined && String(name).trim() !== user.name) {
        if (!String(name).trim()) throw badRequest('Enter their name');
        hub.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), user.id);
        log(req, 'Name changed', `${user.name} → ${String(name).trim()}`);
      }
    })();
    registry.userChanged(user.id);
    res.json(shown(find(user.id), req.user));
  });

  // A new temporary password; they're signed out everywhere and sign in again with it.
  router.post('/:id/password', (req, res) => {
    const user = find(req.params.id);
    if (!user) return res.status(404).json({ error: 'not found' });
    if (user.id === req.user.id) throw badRequest('Use "Change password" at the bottom of the sidebar for your own');
    mustManage(req, user);
    checkPassword((req.body || {}).password);
    hub.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), user.id);
    endSessions(hub, user.id);
    log(req, 'Password reset', user.name);
    res.json({ ok: true });
  });

  // Signs them out on every device (a lost phone, a shared till left signed in).
  router.post('/:id/signout', (req, res) => {
    const user = find(req.params.id);
    if (!user) return res.status(404).json({ error: 'not found' });
    mustManage(req, user);
    endSessions(hub, user.id);
    log(req, 'Signed out everywhere', user.name);
    res.json({ ok: true });
  });

  // Someone who has left: signed out and can't sign in. Their name stays on what they did.
  router.post('/:id/remove', (req, res) => {
    const user = find(req.params.id);
    if (!user) return res.status(404).json({ error: 'not found' });
    mustManage(req, user);
    if (user.role === 'admin' && otherAdmins(user.id) === 0) throw badRequest('There has to be at least one admin');
    hub.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").run(user.id);
    endSessions(hub, user.id);
    registry.userChanged(user.id);
    log(req, 'Person removed', user.name);
    res.json(shown(find(user.id), req.user));
  });

  router.post('/:id/restore', (req, res) => {
    const user = find(req.params.id);
    if (!user) return res.status(404).json({ error: 'not found' });
    mustManage(req, user);
    hub.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(user.id);
    registry.userChanged(user.id);
    log(req, 'Person restored', user.name);
    res.json(shown(find(user.id), req.user));
  });

  return router;
}

module.exports = { createUsersRouter };
