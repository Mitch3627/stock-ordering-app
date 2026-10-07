// Stores from the command line (admins can also do this on the Admin page).
//   node scripts/manage_stores.js list
//   node scripts/manage_stores.js add "Store name" ["Store to copy items and settings from"]
//   node scripts/manage_stores.js rename "Old name" "New name"
//   node scripts/manage_stores.js archive "Store name"     (hidden from everyone; nothing is deleted)
//   node scripts/manage_stores.js restore "Store name"
// Stop the app first when adding a store, so the running copy picks it up cleanly when started again.
const { openHub, hubPaths, audit } = require('../lib/hub');
const { StoreRegistry } = require('../lib/stores');

const [, , cmd, ...args] = process.argv;
const { hubPath, legacyDbPath, baseDir } = hubPaths();
const hub = openHub(hubPath, { legacyDbPath, storeName: process.env.STORE_NAME });
const registry = new StoreRegistry(hub, { baseDir, buildRouter: () => null });
const fail = (msg) => { console.error(msg); registry.close(); hub.close(); process.exit(1); };
const byName = (name) => hub.prepare('SELECT * FROM stores WHERE name = ? COLLATE NOCASE').get(String(name || '').trim())
  || fail(`No store called "${name}"`);
const log = (storeId, action, detail) => audit(hub, null, storeId, action, `${detail} (command line)`);

if (cmd === 'list') {
  console.table(hub.prepare(`SELECT s.id, s.name, s.db_path AS file, s.created_at, s.archived_at AS archived,
      (SELECT COUNT(*) FROM user_stores WHERE store_id = s.id) AS people FROM stores s ORDER BY s.name`).all());
} else if (cmd === 'add') {
  const [name, copyFromName] = args;
  if (!name || !name.trim()) fail('usage: node scripts/manage_stores.js add "Store name" ["Copy from"]');
  if (hub.prepare('SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE').get(name.trim())) fail('There is already a store with that name');
  const from = copyFromName ? byName(copyFromName) : null;
  const created = registry.create(name, { copyFrom: from && from.id });
  log(created.id, 'Store added', from ? `${created.name} – items and settings copied from ${from.name}` : `${created.name} – empty`);
  console.log(`Added ${created.name} (${created.db_path})${from ? ` with ${from.name}'s items and settings` : ''}`);
} else if (cmd === 'rename') {
  const [oldName, newName] = args;
  const s = byName(oldName);
  if (!newName || !newName.trim()) fail('Give the new name');
  hub.prepare('UPDATE stores SET name = ? WHERE id = ?').run(newName.trim(), s.id);
  log(s.id, 'Store renamed', `${s.name} → ${newName.trim()}`);
  console.log(`${s.name} is now ${newName.trim()}`);
} else if (cmd === 'archive' || cmd === 'restore') {
  const s = byName(args[0]);
  if (cmd === 'archive') {
    if (!hub.prepare('SELECT 1 FROM stores WHERE archived_at IS NULL AND id <> ?').get(s.id)) fail('There has to be at least one open store');
    hub.prepare("UPDATE stores SET archived_at = datetime('now') WHERE id = ?").run(s.id);
    log(s.id, 'Store archived', s.name);
    console.log(`${s.name} archived – nobody sees it now; its data is kept`);
  } else {
    hub.prepare('UPDATE stores SET archived_at = NULL WHERE id = ?').run(s.id);
    log(s.id, 'Store restored', s.name);
    console.log(`${s.name} is open again`);
  }
} else {
  console.log('usage: node scripts/manage_stores.js list | add "Name" ["Copy from"] | rename "Old" "New" | archive "Name" | restore "Name"');
}
registry.close();
hub.close();
