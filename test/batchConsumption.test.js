const test = require('node:test');
const assert = require('node:assert');
const { consumeFromBatches } = require('../lib/batchConsumption');

test('consumes fully from the first batch when it has enough', () => {
  const batches = [{ id: 1, qty_remaining: 10 }, { id: 2, qty_remaining: 5 }];
  const result = consumeFromBatches(batches, 4);
  assert.deepStrictEqual(result.consumptions, [{ batchId: 1, amountConsumed: 4, newRemaining: 6 }]);
  assert.strictEqual(result.unconsumed, 0);
});

test('spans into the second batch when the first runs out', () => {
  const batches = [{ id: 1, qty_remaining: 3 }, { id: 2, qty_remaining: 5 }];
  const result = consumeFromBatches(batches, 4);
  assert.deepStrictEqual(result.consumptions, [
    { batchId: 1, amountConsumed: 3, newRemaining: 0 },
    { batchId: 2, amountConsumed: 1, newRemaining: 4 },
  ]);
  assert.strictEqual(result.unconsumed, 0);
});

test('reports unconsumed remainder when total batch stock is insufficient', () => {
  const batches = [{ id: 1, qty_remaining: 2 }];
  const result = consumeFromBatches(batches, 5);
  assert.deepStrictEqual(result.consumptions, [{ batchId: 1, amountConsumed: 2, newRemaining: 0 }]);
  assert.strictEqual(result.unconsumed, 3);
});

test('an empty batch list consumes nothing and reports it all as unconsumed', () => {
  const result = consumeFromBatches([], 5);
  assert.deepStrictEqual(result.consumptions, []);
  assert.strictEqual(result.unconsumed, 5);
});
