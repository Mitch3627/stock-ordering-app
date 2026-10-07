const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { getDb } = require('../db/connection');
const { getOnHand } = require('../ledger/ledger');
const { seed } = require('../scripts/seed');

test('seed imports items from the TSV and on-hand from the JSON', () => {
  const db = getDb(':memory:');
  seed(db, {
    itemMasterTsvPath: path.join(__dirname, 'fixtures', 'item_master.sample.tsv'),
    runningInventoryJsonPath: path.join(__dirname, 'fixtures', 'running_inventory.sample.json'),
  });

  const fries = db.prepare('SELECT * FROM items WHERE name = ?').get('Fries');
  assert.strictEqual(fries.category, 'Freezer');
  assert.strictEqual(fries.supplier_name, 'Medium Fry Cartons');
  assert.strictEqual(fries.usage_per_100_sales, 0.15);
  assert.strictEqual(fries.buffer_value, 9);
  assert.strictEqual(fries.max_boxes, 20);
  assert.strictEqual(fries.price_per_unit, 21.5);
  assert.strictEqual(getOnHand(db, fries.id), 12);

  const salt = db.prepare('SELECT * FROM items WHERE name = ?').get('Fine Table Salt');
  assert.strictEqual(getOnHand(db, salt.id), 0);

  db.close();
});

test('seed uses the real unit label from the units TSV when provided, and falls back otherwise', () => {
  const db = getDb(':memory:');
  seed(db, {
    itemMasterTsvPath: path.join(__dirname, 'fixtures', 'item_master.sample.tsv'),
    runningInventoryJsonPath: path.join(__dirname, 'fixtures', 'running_inventory.sample.json'),
    unitsTsvPath: path.join(__dirname, 'fixtures', 'item_units.sample.tsv'),
  });
  const fries = db.prepare('SELECT * FROM items WHERE name = ?').get('Fries');
  assert.strictEqual(fries.unit_label, 'Case');
  const salt = db.prepare('SELECT * FROM items WHERE name = ?').get('Fine Table Salt');
  assert.strictEqual(salt.unit_label, 'Order Unit'); // not present in the units fixture - falls back
  db.close();
});

test('seed is idempotent - running it twice does not double the ledger', () => {
  const db = getDb(':memory:');
  const paths = {
    itemMasterTsvPath: path.join(__dirname, 'fixtures', 'item_master.sample.tsv'),
    runningInventoryJsonPath: path.join(__dirname, 'fixtures', 'running_inventory.sample.json'),
  };
  seed(db, paths);
  seed(db, paths);
  const fries = db.prepare('SELECT * FROM items WHERE name = ?').get('Fries');
  assert.strictEqual(getOnHand(db, fries.id), 12);
  db.close();
});

test('seedChemicals adds chemical items without touching existing ones', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { seedChemicals } = require('../scripts/seed');
  const db = getDb(':memory:');
  const file = path.join(os.tmpdir(), `chem-${Date.now()}.tsv`);
  fs.writeFileSync(file, 'Floor Gel 6x800ml\tEach\nSanitiser Tabs 12x113g\tCase\n');
  seedChemicals(db, file);
  db.prepare("UPDATE items SET buffer_value = 3 WHERE name = 'Floor Gel 6x800ml'").run();
  seedChemicals(db, file); // idempotent, keeps edits
  const rows = db.prepare("SELECT name, category, unit_label, buffer_value FROM items ORDER BY name").all();
  assert.deepStrictEqual(rows.map(r => [r.name, r.category, r.unit_label, r.buffer_value]),
    [['Floor Gel 6x800ml', 'Chemicals', 'Each', 3], ['Sanitiser Tabs 12x113g', 'Chemicals', 'Case', 0]]);
  fs.unlinkSync(file);
  db.close();
});

test('seeding without the running inventory imports items but leaves stock for the first count', () => {
  const db = getDb(':memory:');
  seed(db, { itemMasterTsvPath: path.join(__dirname, 'fixtures', 'item_master.sample.tsv') });
  const fries = db.prepare('SELECT * FROM items WHERE name = ?').get('Fries');
  assert.strictEqual(fries.usage_per_100_sales, 0.15);
  assert.strictEqual(getOnHand(db, fries.id), 0);
  db.close();
});

test('a database already in use (counts or deliveries) is recognised, so the seed script refuses it', () => {
  const { inUse } = require('../scripts/seed');
  const db = getDb(':memory:');
  assert.strictEqual(inUse(db), false);
  db.prepare("INSERT INTO deliveries (delivered_at) VALUES ('2026-09-21')").run();
  assert.strictEqual(inUse(db), true);
  db.close();
});
