// Records the supplier's order pack size for items whose supplier order unit differs from the app's case, using the
// order lines pulled from supplier (data/supplier-order-*.tsv: product id, order qty, inventory qty, unit, name).
//   node scripts/supplier_packs.js           - shows what would change
//   node scripts/supplier_packs.js --apply   - saves it
// Items where the two agree (within 2%, e.g. catch-weight cheese) are left alone.
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/connection');

const apply = process.argv.includes('--apply');
const dataDir = process.env.INVENTORY_DB ? path.dirname(process.env.INVENTORY_DB) : path.join(__dirname, '..', 'data');
const files = fs.readdirSync(dataDir).filter(f => /^supplier-order-.*\.tsv$/.test(f));
if (files.length === 0) {
  console.log('No supplier-order-*.tsv files found in', dataDir);
  process.exit(0);
}

const db = getDb(process.env.INVENTORY_DB);
const items = db.prepare('SELECT id, name, supplier_name, supplier_product_id, supplier_unit, items_per_order_unit, supplier_order_pack FROM items').all();
const byPid = Object.fromEntries(items.filter(i => i.supplier_product_id).map(i => [String(i.supplier_product_id), i]));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const byName = {};
for (const i of items) {
  byName[norm(i.supplier_name)] = byName[norm(i.supplier_name)] || i;
  byName[norm(i.name)] = byName[norm(i.name)] || i;
}

const packs = new Map();
for (const f of files) {
  for (const line of fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n')) {
    const [pid, orderQty, invQty, unit, ...rest] = line.replace(/\r$/, '').split('\t');
    if (!pid || !(Number(orderQty) > 0) || !(Number(invQty) > 0)) continue;
    const item = byPid[pid] || byName[norm(rest.join(' ').replace(/^"|"$/g, ''))];
    if (!item) continue;
    packs.set(item.id, { item, pack: Math.round(Number(invQty) / Number(orderQty) * 1000) / 1000, unit });
  }
}

const update = db.prepare('UPDATE items SET supplier_order_pack = ? WHERE id = ?');
let changed = 0;
db.transaction(() => {
  for (const { item, pack, unit } of packs.values()) {
    const differs = Math.abs(pack / item.items_per_order_unit - 1) > 0.02;
    const value = differs ? pack : null;
    if (value === item.supplier_order_pack) continue;
    console.log(`${item.name}: supplier order unit = ${pack} ${unit}, app case = ${item.items_per_order_unit}${differs ? '  -> pack recorded' : '  -> same, cleared'}`);
    if (apply) update.run(value, item.id);
    changed++;
  }
})();
console.log(`${packs.size} items checked, ${changed} ${apply ? 'updated' : 'would change (run with --apply to save)'}.`);
db.close();
