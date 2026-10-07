const express = require('express');
const { parseCookies } = require('../lib/auth');
const { storesFor, storeIdsOf } = require('../lib/hub');
const { badRequest } = require('../lib/validate');

const STORE_COOKIE = 'bi_store';

// The store this request works on: the one picked in the sidebar if the person can open it, otherwise the first
// they're assigned to (an admin's home store), otherwise the first they can open.
function currentStore(hub, req) {
  const stores = storesFor(hub, req.user);
  const wanted = Number(parseCookies(req.headers.cookie)[STORE_COOKIE]);
  const home = storeIdsOf(hub, req.user.id);
  const store = stores.find(s => s.id === wanted) || stores.find(s => home.includes(s.id)) || stores[0] || null;
  return { stores, store };
}

// Sends each request on to its store's own API. Someone with no store yet only sees a message.
function storeGate(hub) {
  return (req, res, next) => {
    const { store } = currentStore(hub, req);
    if (!store) return res.status(403).json({ error: "You haven't been given a store yet – ask an admin", code: 'no-store' });
    req.store = store;
    next();
  };
}

function dispatchToStore(registry) {
  return (req, res, next) => {
    const { router } = registry.get(req.store.id);
    registry.ensureUser(req.store.id, req.user.id); // e.g. someone added from the command line while running
    router(req, res, next);
  };
}

function createStoresRouter(hub, options = {}) {
  const secure = options.secureCookies ?? (process.env.NODE_ENV === 'production');
  const router = express.Router();

  router.get('/', (req, res) => {
    const { stores, store } = currentStore(hub, req);
    res.json({ current: store, stores });
  });

  // Switch store (remembered on this device).
  router.post('/select', (req, res) => {
    const id = Number((req.body || {}).id);
    const store = storesFor(hub, req.user).find(s => s.id === id);
    if (!store) throw badRequest("You can't open that store");
    res.setHeader('Set-Cookie', `${STORE_COOKIE}=${store.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
    res.json(store);
  });

  return router;
}

module.exports = { createStoresRouter, storeGate, dispatchToStore, currentStore, STORE_COOKIE };
