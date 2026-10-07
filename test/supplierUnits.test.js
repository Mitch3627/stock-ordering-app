const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDb } = require('../db/connection');
const { seedSupplierUnits } = require('../scripts/seed');

test('seedSupplierUnits sets the supplier inventory unit by official or display name, and never overwrites one', () => {
  const db = getDb(':memory:');
  const add = db.prepare('INSERT INTO items (name, category, supplier_name, unit_label) VALUES (?, ?, ?, ?)');
  add.run('Ketchup Packets', 'Packaging', 'Ketchup Packets', 'Case');
  add.run('Cup Carriers (2)', 'Packaging', 'Two-Cup Carrier Tray', 'Case'); // renamed: matched via official name
  add.run('Actigel Detergent', 'Chemicals', 'Floor Gel 6x800ml', 'Each'); // chemicals count in their own unit
  add.run('Fries', 'Freezer', 'Medium Fry Cartons', 'Box');
  db.prepare("UPDATE items SET supplier_unit = 'Sleeve' WHERE name = 'Fries'").run(); // already set: kept

  const file = path.join(os.tmpdir(), `units-${Date.now()}.tsv`);
  fs.writeFileSync(file, 'Ketchup Packets\tEach\nTwo-Cup Carrier Tray\tEach\nMedium Fry Cartons\tBox\nSomething Else\tKG\n');
  const result = seedSupplierUnits(db, file);

  const units = Object.fromEntries(db.prepare('SELECT name, supplier_unit FROM items').all().map(r => [r.name, r.supplier_unit]));
  assert.deepStrictEqual(units, {
    'Ketchup Packets': 'Each', 'Cup Carriers (2)': 'Each', 'Actigel Detergent': 'Each', Fries: 'Sleeve',
  });
  assert.deepStrictEqual(result.unmatched, ['Something Else']);
  fs.unlinkSync(file);
  db.close();
});
