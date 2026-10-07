const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../db/connection');
const { backupDatabase } = require('../lib/backup');

test('backupDatabase writes one copy per day and prunes to the newest N', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const db = getDb(path.join(tmp, 'live.db'));
  db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Fries', 'Freezer', 'Box')`).run();
  const dir = path.join(tmp, 'backups');
  for (const d of ['2026-09-10', '2026-09-11', '2026-09-12']) await backupDatabase(db, dir, d, 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['inventory-2026-09-11.db', 'inventory-2026-09-12.db']);
  const before = fs.statSync(path.join(dir, 'inventory-2026-09-12.db')).mtimeMs;
  await backupDatabase(db, dir, '2026-09-12', 2); // same day: not rewritten
  assert.strictEqual(fs.statSync(path.join(dir, 'inventory-2026-09-12.db')).mtimeMs, before);
  db.close();
  const copy = getDb(path.join(dir, 'inventory-2026-09-12.db'));
  assert.strictEqual(copy.prepare('SELECT COUNT(*) c FROM items').get().c, 1);
  copy.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
