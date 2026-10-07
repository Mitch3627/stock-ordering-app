const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { requireAdmin, sessionToken, hashToken } = require('../lib/auth');
const { audit } = require('../lib/hub');
const { todayLocal } = require('../lib/dates');
const { badRequest } = require('../lib/validate');

// Admins only: stores, the activity log, backups and signing everyone out.
function createAdminRouter(hub, registry) {
  const router = express.Router();
  router.use(requireAdmin);
  const log = (req, action, detail, storeId) => audit(hub, req.user.id, storeId ?? (req.store && req.store.id), action, detail);
  const store = (id) => {
    const s = registry.row(id);
    if (!s) { const e = new Error('not found'); e.status = 404; throw e; }
    return s;
  };

  // ---- stores ----
  router.get('/stores', (req, res) => {
    res.json(hub.prepare(`SELECT s.id, s.name, s.created_at, s.archived_at,
        (SELECT COUNT(*) FROM user_stores us JOIN users u ON u.id = us.user_id WHERE us.store_id = s.id AND u.disabled_at IS NULL) AS people
      FROM stores s ORDER BY s.archived_at IS NOT NULL, s.name COLLATE NOCASE`).all());
  });

  // A new store, empty or starting from another store's items, case sizes, prices and settings.
  router.post('/stores', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    const copyFrom = (req.body || {}).copyFrom ? Number(req.body.copyFrom) : null;
    if (!name) throw badRequest('Enter the store name');
    if (hub.prepare('SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE').get(name)) throw badRequest('There is already a store with that name');
    if (copyFrom) store(copyFrom);
    const created = registry.create(name, { copyFrom });
    log(req, 'Store added', copyFrom ? `${name} – items and settings copied from ${store(copyFrom).name}` : `${name} – empty`, created.id);
    res.status(201).json(created);
  });

  router.put('/stores/:id', (req, res) => {
    const s = store(req.params.id);
    const name = String((req.body || {}).name || '').trim();
    if (!name) throw badRequest('Enter the store name');
    if (hub.prepare('SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, s.id)) throw badRequest('There is already a store with that name');
    hub.prepare('UPDATE stores SET name = ? WHERE id = ?').run(name, s.id);
    log(req, 'Store renamed', `${s.name} → ${name}`, s.id);
    res.json(store(s.id));
  });

  // Closed or sold stores are hidden from everyone; nothing is deleted and they can be brought back.
  router.post('/stores/:id/archive', (req, res) => {
    const s = store(req.params.id);
    if (!hub.prepare('SELECT 1 FROM stores WHERE archived_at IS NULL AND id <> ?').get(s.id)) throw badRequest('There has to be at least one open store');
    hub.prepare("UPDATE stores SET archived_at = datetime('now') WHERE id = ?").run(s.id);
    log(req, 'Store archived', s.name, s.id);
    res.json(store(s.id));
  });

  router.post('/stores/:id/restore', (req, res) => {
    const s = store(req.params.id);
    hub.prepare('UPDATE stores SET archived_at = NULL WHERE id = ?').run(s.id);
    log(req, 'Store restored', s.name, s.id);
    res.json(store(s.id));
  });

  // A copy of a store's database as it is right now, to keep somewhere safe.
  router.get('/stores/:id/backup', async (req, res, next) => {
    try {
      const s = store(req.params.id);
      const { db } = registry.get(s.id);
      const file = path.join(os.tmpdir(), `stock-backup-${process.pid}-${Date.now()}.db`);
      await db.backup(file);
      log(req, 'Backup downloaded', s.name, s.id);
      res.download(file, `${s.name.replace(/[^\w-]+/g, '-')}-${todayLocal()}.db`, () => fs.unlink(file, () => {}));
    } catch (err) {
      next(err);
    }
  });

  // ---- activity ----
  // Admin changes and sign-ins from the hub, plus what was logged in the chosen store, newest first.
  router.get('/activity', (req, res) => {
    const s = store(req.query.store || req.store.id);
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const sinceSql = since.slice(0, 19).replace('T', ' ');
    const names = new Map(hub.prepare('SELECT id, name FROM users').all().map(u => [u.id, u.name]));
    const who = (id) => (id ? names.get(id) || 'Someone' : '—');
    const rows = hub.prepare('SELECT at, user_id, action, detail FROM audit_log WHERE at >= ? AND (store_id = ? OR store_id IS NULL) ORDER BY at DESC LIMIT 500')
      .all(since, s.id).map(r => ({ at: r.at, who: who(r.user_id), action: r.action, detail: r.detail }));

    const { db } = registry.get(s.id);
    const iso = (t) => (t ? (t.includes('T') ? t : t.replace(' ', 'T') + 'Z') : null);
    const add = (at, userId, action, detail) => { if (at) rows.push({ at: iso(at), who: who(userId), action, detail }); };
    for (const d of db.prepare(`SELECT d.created_at, d.created_by, d.delivered_at, COUNT(l.id) AS n FROM deliveries d
        LEFT JOIN delivery_lines l ON l.delivery_id = d.id WHERE d.created_at >= ? GROUP BY d.id`).all(sinceSql)) {
      add(d.created_at, d.created_by, 'Delivery logged', `${day(d.delivered_at)} – ${d.n} line(s)`);
    }
    for (const w of db.prepare(`SELECT w.created_at, w.created_by, w.qty, w.reason, w.ood, w.deleted_at, i.name FROM waste_entries w
        JOIN items i ON i.id = w.item_id WHERE w.created_at >= ?`).all(sinceSql)) {
      add(w.created_at, w.created_by, w.ood ? 'Out-of-date waste logged' : 'Waste logged',
        `${fmtQty(w.qty)} × ${w.name}${w.reason ? ' – ' + w.reason : ''}${w.deleted_at ? ' (since deleted)' : ''}`);
    }
    for (const c of db.prepare('SELECT o.confirmed_at, o.confirmed_by, o.delivery_date FROM order_confirmations o WHERE o.confirmed_at >= ?').all(sinceSql)) {
      add(c.confirmed_at, c.confirmed_by, 'Order confirmed', `for the ${day(c.delivery_date)} delivery`);
    }
    for (const c of db.prepare(`SELECT c.created_at, c.created_by, c.counted_at, COUNT(l.id) AS n FROM counts c
        LEFT JOIN count_lines l ON l.count_id = c.id WHERE c.created_at >= ? GROUP BY c.id`).all(sinceSql)) {
      add(c.created_at, c.created_by, 'Count saved', `${day(c.counted_at)} – ${c.n} item(s)`);
    }
    for (const e of db.prepare(`SELECT e.created_at, e.user_id, e.note, i.name FROM inventory_events e JOIN items i ON i.id = e.item_id
        WHERE e.type = 'count_correction' AND e.note LIKE 'Manual edit:%' AND e.created_at >= ?`).all(sinceSql)) {
      add(e.created_at, e.user_id, 'Stock corrected', `${e.name}: ${e.note || ''}`);
    }
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    res.json({ store: { id: s.id, name: s.name }, days, rows: rows.slice(0, 500) });
  });

  // ---- sign everyone out ----
  router.post('/signout-all', (req, res) => {
    const mine = hashToken(sessionToken(req) || '');
    const n = hub.prepare('DELETE FROM sessions WHERE token <> ?').run(mine).changes;
    log(req, 'Everyone signed out', `${n} sign-in(s) ended`);
    res.json({ ended: n });
  });

  return router;
}

const fmtQty = (n) => String(Math.round(Number(n) * 1000) / 1000);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-09-25" -> "Fri 25 Sep"
const day = (iso) => {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? String(iso) : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

module.exports = { createAdminRouter };
