const test = require('node:test');
const assert = require('node:assert');
const { convertToOrderUnits } = require('../lib/unitConversion');

test('order unit passes through unchanged', () => {
  const item = { items_per_order_unit: 10 };
  assert.strictEqual(convertToOrderUnits(3, 'order', item), 3);
});

test('native unit divides by items_per_order_unit', () => {
  // Shredded Cheese: 10 bags per box, counted 25 bags -> 2.5 boxes
  const item = { items_per_order_unit: 10 };
  assert.strictEqual(convertToOrderUnits(25, 'native', item), 2.5);
});

test('unknown unit throws', () => {
  const item = { items_per_order_unit: 10 };
  assert.throws(() => convertToOrderUnits(1, 'sleeve', item), /Unknown unit/);
});

test('non-positive items_per_order_unit throws for native conversion', () => {
  const item = { items_per_order_unit: 0 };
  assert.throws(() => convertToOrderUnits(1, 'native', item), /items_per_order_unit/);
});
