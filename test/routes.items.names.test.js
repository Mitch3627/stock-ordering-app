const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { getDb } = require('../db/connection');
const { createItemsRouter } = require('../routes/items');
const { seed, seedChemicals } = require('../scripts/seed');

function setup() {
  const db = getDb(':memory:');
  const a = db.prepare(`INSERT INTO items (name, category, supplier_name, supplier_product_id, unit_label)
    VALUES ('Vinyl Gloves Clear Lge PF GD09L 1x100', 'Chemicals', 'Vinyl Gloves Clear Lge PF GD09L 1x100', 10000891, 'Case')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO items (name, category, unit_label) VALUES ('Fries', 'Freezer', 'Box')`).run();
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/items', createItemsRouter(db));
  const server = app.listen(0);
  return { db, server, a, url: `http://127.0.0.1:${server.address().port}/api/items` };
}
const put = (url, id, body) => fetch(`${url}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('an item can be renamed and its official supplier name and product id stay put', async () => {
  const { db, server, url, a } = setup();
  const res = await put(url, a, { name: 'Gloves, Large' });
  assert.strictEqual(res.status, 200);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(a);
  assert.deepStrictEqual([row.name, row.supplier_name, row.supplier_product_id],
    ['Gloves, Large', 'Vinyl Gloves Clear Lge PF GD09L 1x100', 10000891]);
  server.close(); db.close();
});

test('rename rejects blank and duplicate names', async () => {
  const { db, server, url, a } = setup();
  assert.strictEqual((await put(url, a, { name: '   ' })).status, 400);
  const dup = await put(url, a, { name: 'Fries' });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(db.prepare('SELECT name FROM items WHERE id = ?').get(a).name, 'Vinyl Gloves Clear Lge PF GD09L 1x100');
  server.close(); db.close();
});

test('the official supplier name and product id cannot be changed once set', async () => {
  const { db, server, url, a } = setup();
  assert.strictEqual((await put(url, a, { supplier_name: 'something else' })).status, 400);
  assert.strictEqual((await put(url, a, { supplier_product_id: 1 })).status, 400);
  const fries = db.prepare("SELECT id FROM items WHERE name = 'Fries'").get().id;
  assert.strictEqual((await put(url, fries, { supplier_name: 'Medium Fry Cartons' })).status, 200); // unset -> can be set once
  server.close(); db.close();
});

test('seedChemicals does not duplicate an item that was renamed', () => {
  const db = getDb(':memory:');
  const file = path.join(os.tmpdir(), `chem-${Date.now()}.tsv`);
  fs.writeFileSync(file, 'Floor Gel 6x800ml\tEach\n');
  seedChemicals(db, file);
  db.prepare("UPDATE items SET name = 'Actigel Detergent' WHERE supplier_name = 'Floor Gel 6x800ml'").run();
  seedChemicals(db, file);
  const rows = db.prepare('SELECT name, supplier_name FROM items').all();
  assert.deepStrictEqual(rows, [{ name: 'Actigel Detergent', supplier_name: 'Floor Gel 6x800ml' }]);
  fs.unlinkSync(file);
  db.close();
});

test('seed keeps a renamed item linked to its official name and does not clobber the display name', () => {
  const db = getDb(':memory:');
  const opts = {
    itemMasterTsvPath: path.join(__dirname, 'fixtures', 'item_master.sample.tsv'),
    runningInventoryJsonPath: path.join(__dirname, 'fixtures', 'running_inventory.sample.json'),
  };
  seed(db, opts);
  const before = db.prepare("SELECT id, supplier_name FROM items WHERE name = 'Fries'").get();
  db.prepare("UPDATE items SET name = 'French Fries' WHERE id = ?").run(before.id);
  seed(db, opts);
  const rows = db.prepare('SELECT id, name FROM items WHERE supplier_name = ?').all(before.supplier_name);
  assert.deepStrictEqual(rows, [{ id: before.id, name: 'French Fries' }]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM items WHERE name = 'Fries'").get().c, 0);
  db.close();
});
