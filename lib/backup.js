const fs = require('fs');
const path = require('path');

// Copies the live database to <dir>/<prefix>-YYYY-MM-DD.db (once per day) and keeps the newest `keep` copies.
async function backupDatabase(db, dir, today, keep = 14, prefix = 'inventory') {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${prefix}-${today}.db`);
  if (!fs.existsSync(target)) await db.backup(target);
  const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.db$`);
  const files = fs.readdirSync(dir).filter(f => pattern.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, old));
  return target;
}

module.exports = { backupDatabase };
