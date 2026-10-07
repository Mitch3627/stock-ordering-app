// People and their access from the command line (admins can also do all of this on the Users page).
//   node scripts/manage_users.js add "Full Name" "email" "password" [admin|manager|crew] ["Store, Other Store"]
//   node scripts/manage_users.js set-role "email" admin|manager|crew
//   node scripts/manage_users.js set-stores "email" "Store, Other Store"     (admins have every store anyway)
//   node scripts/manage_users.js reset-password "email" "newpassword"
//   node scripts/manage_users.js sign-out "email"                            (ends their sign-ins everywhere)
//   node scripts/manage_users.js remove "email"      (a leaver: signs them out and blocks sign-in)
//   node scripts/manage_users.js restore "email"
//   node scripts/manage_users.js list
// Works on the same hub.db as the app (set HUB_DB or INVENTORY_DB if it isn't in the default place).
const { openHub, hubPaths, audit, storeIdsOf, ROLES } = require('../lib/hub');
const { hashPassword, endSessions } = require('../lib/auth');

const [, , cmd, ...args] = process.argv;
const { hubPath, legacyDbPath } = hubPaths();
const hub = openHub(hubPath, { legacyDbPath, storeName: process.env.STORE_NAME });
const findUser = (email) => hub.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
const log = (action, detail) => audit(hub, null, null, action, `${detail} (command line)`);
const USAGE = [
  'usage:',
  '  node scripts/manage_users.js add "Name" "email" "password" [admin|manager|crew] ["Store, Other Store"]',
  '  node scripts/manage_users.js set-role "email" admin|manager|crew',
  '  node scripts/manage_users.js set-stores "email" "Store, Other Store"',
  '  node scripts/manage_users.js reset-password "email" "newpassword"',
  '  node scripts/manage_users.js sign-out "email"',
  '  node scripts/manage_users.js remove "email"',
  '  node scripts/manage_users.js restore "email"',
  '  node scripts/manage_users.js list',
].join('\n');
const fail = (msg) => { console.error(msg); hub.close(); process.exit(1); };
const otherAdmins = (id) => hub.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?").get(id).n;

// "Northgate, Eastgate" -> store ids; every name must match a store.
function storeIds(list) {
  const names = String(list || '').split(',').map(s => s.trim()).filter(Boolean);
  return names.map(n => {
    const s = hub.prepare('SELECT id FROM stores WHERE name = ? COLLATE NOCASE').get(n);
    if (!s) fail(`No store called "${n}" (see: node scripts/manage_stores.js list)`);
    return s.id;
  });
}
function setStores(userId, ids) {
  hub.prepare('DELETE FROM user_stores WHERE user_id = ?').run(userId);
  ids.forEach(id => hub.prepare('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)').run(userId, id));
}
const user = (email) => findUser(email) || fail('No user found with that email');

if (cmd === 'add') {
  const [name, email, password, role = 'crew', stores] = args;
  if (!name || !email || !password) fail(USAGE);
  if (password.length < 8) fail('password must be at least 8 characters');
  if (!ROLES.includes(role)) fail('role must be admin, manager or crew');
  if (findUser(email)) fail('Someone already signs in with that email');
  const ids = role === 'admin' ? [] : storeIds(stores);
  if (role !== 'admin' && !ids.length) fail('Give the stores they work at, e.g. "Northgate"');
  const id = hub.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, hashPassword(password), role).lastInsertRowid;
  setStores(id, ids);
  log('Person added', `${name} (${role})`);
  console.log(`Added ${name} (${email}) as ${role}`);
} else if (cmd === 'set-role') {
  const [email, role] = args;
  if (!ROLES.includes(role)) fail(USAGE);
  const u = user(email);
  if (u.role === 'admin' && role !== 'admin' && otherAdmins(u.id) === 0) fail('There has to be at least one admin');
  hub.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  log('Access changed', `${u.name}: ${u.role} → ${role}`);
  console.log(`${email} is now ${role}`);
} else if (cmd === 'set-stores') {
  const [email, stores] = args;
  const u = user(email);
  setStores(u.id, storeIds(stores));
  log('Stores changed', `${u.name}: ${stores}`);
  console.log(`${email} now works at: ${stores}`);
} else if (cmd === 'reset-password') {
  const [email, password] = args;
  if (!email || !password) fail(USAGE);
  if (password.length < 8) fail('password must be at least 8 characters');
  const u = user(email);
  hub.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
  endSessions(hub, u.id); // signed out everywhere: they sign in again with the new password
  log('Password reset', u.name);
  console.log('Password updated for ' + email + ' (signed out on every device)');
} else if (cmd === 'sign-out') {
  const u = user(args[0]);
  endSessions(hub, u.id);
  log('Signed out everywhere', u.name);
  console.log(`${args[0]} is signed out on every device`);
} else if (cmd === 'remove' || cmd === 'restore') {
  const u = user(args[0]);
  if (cmd === 'remove') {
    if (u.role === 'admin' && otherAdmins(u.id) === 0) fail('There has to be at least one admin');
    // Kept (not deleted) so the record of what they did stays readable.
    hub.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").run(u.id);
    endSessions(hub, u.id);
    log('Person removed', u.name);
    console.log('Removed ' + args[0] + ': signed out and can no longer sign in');
  } else {
    hub.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(u.id);
    log('Person restored', u.name);
    console.log('Restored ' + args[0] + ' - they can sign in again');
  }
} else if (cmd === 'list') {
  const names = new Map(hub.prepare('SELECT id, name FROM stores').all().map(s => [s.id, s.name]));
  console.table(hub.prepare('SELECT id, name, email, role, created_at, disabled_at AS removed FROM users ORDER BY name').all()
    .map(u => ({ ...u, stores: u.role === 'admin' ? 'all' : storeIdsOf(hub, u.id).map(id => names.get(id)).join(', ') })));
} else {
  console.log(USAGE);
}
hub.close();
