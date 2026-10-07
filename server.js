const path = require('path');
const express = require('express');
const { getDb } = require('./db/connection');
const { createItemsRouter } = require('./routes/items');
const { createDeliveriesRouter } = require('./routes/deliveries');
const { createWasteRouter } = require('./routes/waste');
const { createBatchesRouter } = require('./routes/batches');
const { createCountsRouter } = require('./routes/counts');
const { createForecastRouter } = require('./routes/forecast');
const { createOrdersRouter } = require('./routes/orders');
const { createPromptsRouter } = require('./routes/prompts');
const { createDashboardRouter } = require('./routes/dashboard');
const { backupDatabase } = require('./lib/backup');
const { createUsageRouter } = require('./routes/usage');
const { createInventoryRouter } = require('./routes/inventory');
const { createAuthRouter } = require('./routes/auth');
const { createSettingsRouter } = require('./routes/settings');
const { createUsersRouter } = require('./routes/users');
const { createAdminRouter } = require('./routes/admin');
const { createStoresRouter, storeGate, dispatchToStore } = require('./routes/stores');
const { requireAuth } = require('./lib/auth');
const { prepareHub, openHub, hubPaths } = require('./lib/hub');
const { StoreRegistry } = require('./lib/stores');
const { todayLocal } = require('./lib/dates');

// Basic browser protections. Pages only load the app's own scripts, styles and fonts.
function securityHeaders(secure) {
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "font-src 'self'", "img-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; ');
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  };
}

// One store's API: stock, deliveries, waste, counts, orders and settings, all in that store's database.
function createStoreRouter(db, options = {}) {
  const router = express.Router();
  router.use('/items', createItemsRouter(db));
  router.use('/deliveries', createDeliveriesRouter(db, options));
  router.use('/waste', createWasteRouter(db, options));
  router.use('/batches', createBatchesRouter(db, options));
  router.use('/counts', createCountsRouter(db, options));
  router.use('/forecast', createForecastRouter(db));
  router.use('/orders', createOrdersRouter(db, options));
  router.use('/prompts', createPromptsRouter(db, options));
  router.use('/usage', createUsageRouter(db));
  router.use('/inventory', createInventoryRouter(db));
  router.use('/dashboard', createDashboardRouter(db, options));
  router.use('/settings', createSettingsRouter(db, options));
  return router;
}

// `hub` holds sign-ins and the list of stores (lib/hub.js); each store's data is in its own file, opened through
// the registry. Given a single store database instead (the tests, or a one-store setup), that file is both.
function createApp(hub, options = {}) {
  const registry = options.registry || new StoreRegistry(prepareHub(hub, { selfStore: true, storeName: options.storeName ?? process.env.STORE_NAME }), {
    baseDir: options.baseDir || process.cwd(),
    buildRouter: (db) => createStoreRouter(db, options),
  });
  const app = express();
  // Behind a reverse proxy (hosted), set TRUST_PROXY so sign-in limits see each person's address, not the proxy's.
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(securityHeaders(options.secureCookies ?? process.env.NODE_ENV === 'production'));
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(hub, options));
  app.use('/api', requireAuth(hub));
  app.use('/api/stores', createStoresRouter(hub, options));
  app.use('/api', storeGate(hub));
  app.use('/api/users', createUsersRouter(hub, registry));
  app.use('/api/admin', createAdminRouter(hub, registry));
  app.use('/api', dispatchToStore(registry));
  app.get('/', (req, res) => res.redirect('/home.html'));
  app.use(express.static(path.join(__dirname, 'public')));
  // Errors always come back as JSON with a message the page can show: 400s explain what to fix,
  // anything unexpected is logged here and reported as a server problem.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server: ' + err.message : err.message });
  });
  return app;
}

if (require.main === module) {
  // Sign-ins and the store list live in hub.db; stores live in their own files beside it. The first time, an
  // existing single-store database (INVENTORY_DB, or data/inventory.db) becomes the first store.
  const { legacyDbPath, hubPath } = hubPaths();
  const hub = openHub(hubPath, { legacyDbPath, storeName: process.env.STORE_NAME });
  const registry = new StoreRegistry(hub, {
    baseDir: path.dirname(hubPath),
    buildRouter: (db) => createStoreRouter(db),
  });
  // A brand-new setup (no existing database to carry over) starts with one empty store.
  if (!hub.prepare('SELECT 1 FROM stores').get()) registry.create(process.env.STORE_NAME || 'Northgate');
  const app = createApp(hub, { registry });
  // Once a day each store's database is copied into a backups folder beside it (the newest 14 are kept), and the
  // hub's into the backups folder beside it.
  const runBackup = async () => {
    for (const { store, db } of registry.all()) {
      await backupDatabase(db, path.join(path.dirname(registry.fileOf(store)), 'backups'), todayLocal())
        .catch(err => console.error(`Backup of ${store.name} failed:`, err.message));
    }
    await backupDatabase(hub, path.join(path.dirname(hubPath), 'backups'), todayLocal(), 14, 'hub')
      .catch(err => console.error('Backup of sign-ins failed:', err.message));
  };
  runBackup();
  setInterval(runBackup, 60 * 60 * 1000); // hourly check; writes at most one copy per day
  const port = process.env.PORT || 3000;
  // Only this PC can reach it unless HOST says otherwise (HOST=0.0.0.0 lets tablets on the same network in).
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`Stock & Ordering running at http://localhost:${port}${host === '127.0.0.1' ? '' : ` (listening on ${host})`}`);
  });
}

module.exports = { createApp, createStoreRouter };
