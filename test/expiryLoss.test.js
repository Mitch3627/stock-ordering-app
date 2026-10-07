const test = require('node:test');
const assert = require('node:assert');
const { computeExpiryLoss } = require('../lib/expiryLoss');

const deliveryDates = ['2026-09-21', '2026-09-23'];

test('stock that will be used before its use-by date is not lost', () => {
  const loss = computeExpiryLoss({
    batches: [{ use_by_date: '2026-09-25', qty_remaining: 4 }],
    dailyUsage: () => 2, startDate: '2026-09-19', deliveryDates,
  });
  assert.deepStrictEqual(loss, { bridge: 0, perDelivery: [0, 0] });
});

test('unused stock is lost the day AFTER its use-by date; loss landing on a delivery date counts before that delivery', () => {
  const loss = computeExpiryLoss({
    batches: [{ use_by_date: '2026-09-20', qty_remaining: 10 }],
    dailyUsage: () => 1, startDate: '2026-09-19', deliveryDates,
  });
  // 19th and 20th use 1 each; the remaining 8 are lost on the 21st, the first delivery's date
  assert.deepStrictEqual(loss, { bridge: 8, perDelivery: [0, 0] });
});

test('loss before the first delivery goes to the bridge', () => {
  const loss = computeExpiryLoss({
    batches: [{ use_by_date: '2026-09-19', qty_remaining: 5 }],
    dailyUsage: () => 1, startDate: '2026-09-19', deliveryDates,
  });
  // used 1 on the 19th, lost 4 on the 20th
  assert.strictEqual(loss.bridge, 4);
});

test('usage runs through the oldest batch first so the newer batch is what survives', () => {
  const loss = computeExpiryLoss({
    batches: [
      { use_by_date: '2026-09-24', qty_remaining: 3 },
      { use_by_date: '2026-09-20', qty_remaining: 3 },
    ],
    dailyUsage: () => 2, startDate: '2026-09-19', deliveryDates,
  });
  // day19: 2 off the 20th batch; day20: 1 + 1 off the 24th batch; 21,22: 2 left, used by day 21 -> nothing lost
  assert.deepStrictEqual(loss, { bridge: 0, perDelivery: [0, 0] });
});

test('loss between two deliveries is charged to the later delivery', () => {
  const loss = computeExpiryLoss({
    batches: [{ use_by_date: '2026-09-21', qty_remaining: 10 }],
    dailyUsage: () => 1, startDate: '2026-09-19', deliveryDates,
  });
  // used on 19, 20, 21; lost on the 22nd, which is between the 21st and 23rd deliveries
  assert.deepStrictEqual(loss, { bridge: 0, perDelivery: [0, 7] });
});
