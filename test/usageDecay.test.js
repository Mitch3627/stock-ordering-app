const test = require('node:test');
const assert = require('node:assert');
const { computeDecay } = require('../lib/usageDecay');

test('computeDecay applies the usage-per-100-sales formula', () => {
  const items = [{ id: 1, usage_per_100_sales: 1 }, { id: 2, usage_per_100_sales: 0.5 }];
  const decay = computeDecay(items, 1000);
  assert.strictEqual(decay[1], 10); // 1 * (1000/100)
  assert.strictEqual(decay[2], 5);  // 0.5 * (1000/100)
});

test('computeDecay omits items with zero usage', () => {
  const items = [{ id: 1, usage_per_100_sales: 0 }];
  const decay = computeDecay(items, 1000);
  assert.strictEqual(decay[1], undefined);
});

test('computeDecay returns an empty object for zero sales', () => {
  const items = [{ id: 1, usage_per_100_sales: 1 }];
  const decay = computeDecay(items, 0);
  assert.deepStrictEqual(decay, {});
});
