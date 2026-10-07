const fs = require('fs');
const path = require('path');
const { applyEvent, getOnHand } = require('../ledger/ledger');

function parseUnitsTsv(filePath) {
  // Real per-item unit labels (Case, Bag, Bottle, KG...) extracted from the original
  // PAR Levels spreadsheet's "Unit" column - keyed by item name, first match wins.
  const units = {};
  if (!filePath || !fs.existsSync(filePath)) return units;
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '').trim().split('\n');
  for (const line of lines.slice(1)) { // skip header row
    const [, item, unit] = line.split('\t');
    if (item && unit && !units[item]) units[item] = unit;
  }
  return units;
}

function parseItemMasterTsv(filePath, unitsByName) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  return lines.map(line => {
    const [sheet, item, ncName, ipou, usage, bufferMethod, bufferValue, maxBoxes, price] = line.split('\t');
    return {
      name: item,
      category: sheet,
      supplier_name: ncName || null,
      unit_label: (unitsByName && unitsByName[item]) || 'Order Unit',
      items_per_order_unit: parseFloat(ipou) || 1,
      usage_per_100_sales: parseFloat(usage) || 0,
      buffer_value: parseFloat(bufferValue) || 0,
      max_boxes: maxBoxes === '' || maxBoxes === undefined ? null : parseFloat(maxBoxes),
      price_per_unit: price === '' || price === undefined ? null : parseFloat(price),
    };
  });
}

const USE_BY_TRACKED = [
  'Beef Patty', 'Slider Patty', 'Salted Butter Block', 'Butter Portions',
  'Semi-Skimmed Milk Bottles', 'Fruit Pots', 'Fresh Eggs',
];

// Items from the old spreadsheet. Stock is only imported when `runningInventoryJsonPath` is given - the app's
// real starting stock comes from the first full count, not from the spreadsheet's running figures.
function seed(db, { itemMasterTsvPath, runningInventoryJsonPath, unitsTsvPath }) {
  const unitsByName = parseUnitsTsv(unitsTsvPath);
  const items = parseItemMasterTsv(itemMasterTsvPath, unitsByName);
  const ledgerData = runningInventoryJsonPath ? JSON.parse(fs.readFileSync(runningInventoryJsonPath, 'utf8')) : null;

  const upsertItem = db.prepare(`
    INSERT INTO items (name, category, supplier_name, unit_label, items_per_order_unit,
                        usage_per_100_sales, buffer_value, max_boxes, price_per_unit)
    VALUES (@name, @category, @supplier_name, @unit_label, @items_per_order_unit,
            @usage_per_100_sales, @buffer_value, @max_boxes, @price_per_unit)
    ON CONFLICT(name) DO UPDATE SET
      category = excluded.category, supplier_name = excluded.supplier_name,
      unit_label = excluded.unit_label,
      items_per_order_unit = excluded.items_per_order_unit,
      usage_per_100_sales = excluded.usage_per_100_sales,
      buffer_value = excluded.buffer_value, max_boxes = excluded.max_boxes,
      price_per_unit = excluded.price_per_unit
  `);
  const getItemByName = db.prepare('SELECT id FROM items WHERE name = ?');
  const findExisting = db.prepare('SELECT id FROM items WHERE supplier_name = ? OR name = ? ORDER BY (supplier_name = ?) DESC LIMIT 1');
  const updateItem = db.prepare(`
    UPDATE items SET category = @category, supplier_name = COALESCE(supplier_name, @supplier_name), unit_label = @unit_label,
      items_per_order_unit = @items_per_order_unit, usage_per_100_sales = @usage_per_100_sales,
      buffer_value = @buffer_value, max_boxes = @max_boxes, price_per_unit = @price_per_unit
    WHERE id = @id
  `);
  const markTracked = db.prepare('UPDATE items SET track_use_by = 1 WHERE name = ?');

  const run = db.transaction(() => {
    for (const item of items) {
      // A renamed item is still found through its official supplier name; its display name is left alone.
      const official = item.supplier_name || item.name;
      const existing = findExisting.get(official, item.name, official);
      let id;
      if (existing) {
        updateItem.run({ ...item, id: existing.id });
        id = existing.id;
      } else {
        upsertItem.run(item);
        id = getItemByName.get(item.name).id;
      }
      if (!ledgerData) continue;
      const targetOnHand = ledgerData.onHand[item.name] ?? 0;
      const currentOnHand = getOnHand(db, id);
      const delta = Math.round((targetOnHand - currentOnHand) * 100) / 100;
      if (delta !== 0) {
        applyEvent(db, {
          itemId: id, type: 'delivery', qtyDelta: delta,
          occurredAt: ledgerData.asOf, note: 'Migration baseline from spreadsheet running inventory',
        });
      }
    }
    for (const name of USE_BY_TRACKED) markTracked.run(name);
  });
  run();
}

// Chemicals arrive with no usage rate, buffer or max yet (set in the app); existing rows are never overwritten.
function seedChemicals(db, chemicalsTsvPath) {
  const insert = db.prepare(`
    INSERT INTO items (name, category, supplier_name, unit_label, items_per_order_unit, usage_per_100_sales, buffer_value)
    VALUES (?, 'Chemicals', ?, ?, 1, 0, 0)
    ON CONFLICT(name) DO NOTHING
  `);
  const exists = db.prepare('SELECT 1 FROM items WHERE supplier_name = ?');
  const lines = fs.readFileSync(chemicalsTsvPath, 'utf8').split(String.fromCharCode(10)).map(l => l.replace(String.fromCharCode(13), '')).filter(l => l.trim());
  let added = 0;
  db.transaction(() => {
    for (const line of lines) {
      const [name, unit] = line.split(String.fromCharCode(9));
      if (exists.get(name.trim())) continue; // already there, possibly renamed
      added += insert.run(name.trim(), name.trim(), (unit || 'Each').trim()).changes;
    }
  })();
  return added;
}

// The supplier counts every item in its own inventory unit (Each, KG, Bag (18)...). Record that unit per item
// so counts can be typed exactly as supplier expects them. Matches on the official supplier name first,
// then the display name; never overwrites a unit that is already set.
function seedSupplierUnits(db, unitsTsvPath) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const items = db.prepare('SELECT id, name, supplier_name FROM items').all();
  const byKey = {};
  for (const i of items) if (i.supplier_name) byKey[norm(i.supplier_name)] = byKey[norm(i.supplier_name)] || i;
  for (const i of items) byKey[norm(i.name)] = byKey[norm(i.name)] || i;

  const setUnit = db.prepare('UPDATE items SET supplier_unit = ? WHERE id = ? AND supplier_unit IS NULL');
  const lines = fs.readFileSync(unitsTsvPath, 'utf8').split(String.fromCharCode(10)).map(l => l.replace(String.fromCharCode(13), '')).filter(l => l.trim());
  const unmatched = [];
  let matched = 0;
  db.transaction(() => {
    for (const line of lines) {
      const [name, unit] = line.split(String.fromCharCode(9));
      const item = byKey[norm(name)];
      if (!item || !unit) { unmatched.push(name); continue; }
      setUnit.run(unit.trim(), item.id);
      matched++;
    }
    // Chemicals were added with their supplier unit as the unit label.
    db.prepare("UPDATE items SET supplier_unit = unit_label WHERE category = 'Chemicals' AND supplier_unit IS NULL").run();
  })();
  return { matched, unmatched };
}

// A database that's already in use (it has counts or deliveries) must never be seeded by accident: seeding
// overwrites usage rates, buffers, maxes, prices and units with the old spreadsheet's.
function inUse(db) {
  return !!(db.prepare('SELECT 1 FROM counts LIMIT 1').get() || db.prepare('SELECT 1 FROM deliveries LIMIT 1').get());
}

if (require.main === module) {
  const { getDb } = require('../db/connection');
  const db = getDb(process.env.INVENTORY_DB);
  if (inUse(db) && !process.argv.includes('--force')) {
    console.error('This database is already in use (it has counts or deliveries), so it was not seeded.\n'
      + 'Seeding would overwrite usage rates, buffers, maxes, prices and units with the old spreadsheet\'s.\n'
      + 'To do it anyway, back up data/inventory.db first and run: node scripts/seed.js --force');
    process.exit(1);
  }
  seed(db, {
    itemMasterTsvPath: path.join(__dirname, 'item_master.tsv'),
    unitsTsvPath: path.join(__dirname, 'item_units.tsv'),
  });
  seedChemicals(db, path.join(__dirname, 'chemical_items.tsv'));
  seedSupplierUnits(db, path.join(__dirname, 'supplier_units.tsv'));
  console.log('Items imported. Stock starts at zero - do a full count in the app to set it.');
}

module.exports = { seed, seedChemicals, seedSupplierUnits, parseItemMasterTsv, inUse };
