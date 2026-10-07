const test = require('node:test');
const assert = require('node:assert');
const { smoothDeliveryCosts } = require('../lib/costSmoothing');

test('moves a flexible item from an over-target delivery to an earlier under-target one', () => {
  const deliveries = [
    { date: '2026-09-14' }, // Monday - light
    { date: '2026-09-16' }, // Wednesday - heavy
  ];
  const items = [
    { id: 1, category: 'Dry Store', price_per_unit: 100, shelf_life_days: null },
  ];
  const plan = {
    1: { qtys: [0, 1], stockAfter: [0, 1], buffers: [0, 0] },
  };
  const result = smoothDeliveryCosts({
    plan, items, deliveries, targetCost: 50,
    flexibleCategories: ['Dry Store'],
  });
  // Monday alone costs 0 (under target), Wednesday costs 100 (over target).
  // Moving the 1 unit from Wednesday to Monday brings Wednesday to 0 and Monday to 100 -
  // net delivery-cost total is unchanged, but the smoother should only move items when doing so
  // actually reduces the *maximum* delivery cost across the pair; with only one item and one
  // unit, moving it just relocates the spike, so the plan should be unchanged and moves empty.
  assert.deepStrictEqual(result.moves, []);
});

test('never moves an item with a shelf_life_days set (perishable)', () => {
  const deliveries = [
    { date: '2026-09-14' },
    { date: '2026-09-16' },
  ];
  const items = [
    { id: 1, category: 'Dry Store', price_per_unit: 10, shelf_life_days: 2 },
    { id: 2, category: 'Dry Store', price_per_unit: 4000, shelf_life_days: null },
  ];
  const plan = {
    1: { qtys: [0, 1], stockAfter: [0, 1], buffers: [0, 0] },
    2: { qtys: [0, 1], stockAfter: [0, 1], buffers: [0, 0] },
  };
  const result = smoothDeliveryCosts({
    plan, items, deliveries, targetCost: 100,
    flexibleCategories: ['Dry Store'],
  });
  assert.ok(!result.moves.some(m => m.itemId === 1));
});

test('never moves an item outside the flexible categories', () => {
  const deliveries = [
    { date: '2026-09-14' },
    { date: '2026-09-16' },
  ];
  const items = [
    { id: 1, category: 'Chiller', price_per_unit: 4000, shelf_life_days: null },
  ];
  const plan = {
    1: { qtys: [0, 1], stockAfter: [0, 1], buffers: [0, 0] },
  };
  const result = smoothDeliveryCosts({
    plan, items, deliveries, targetCost: 100,
    flexibleCategories: ['Dry Store'],
  });
  assert.deepStrictEqual(result.moves, []);
});

test('moving an item earlier only happens if the destination stays non-negative and reduces the max cost', () => {
  const deliveries = [
    { date: '2026-09-14' }, // will end up over target if we dump both items here
    { date: '2026-09-16' }, // currently over target with 2 cheap + 1 pricey item
  ];
  const items = [
    { id: 1, category: 'Dry Store', price_per_unit: 4000, shelf_life_days: null }, // expensive, movable
    { id: 2, category: 'Dry Store', price_per_unit: 10, shelf_life_days: null },   // cheap filler on Monday
  ];
  const plan = {
    1: { qtys: [0, 1], stockAfter: [0, 1], buffers: [0, 0] },
    2: { qtys: [1, 0], stockAfter: [1, 0], buffers: [0, 0] },
  };
  // Monday total = 10, Wednesday total = 4000. Moving item 1's Wednesday unit to Monday
  // gives Monday=4010, Wednesday=0 - that makes the max WORSE (4010 > 4000), so it must not move.
  const result = smoothDeliveryCosts({
    plan, items, deliveries, targetCost: 100,
    flexibleCategories: ['Dry Store'],
  });
  assert.deepStrictEqual(result.moves, []);
});

test('when a move commits, stockAfter values are correct (not double-incremented)', () => {
  const deliveries = [
    { date: '2026-09-14' }, // Monday
    { date: '2026-09-16' }, // Wednesday
    { date: '2026-09-18' }, // Friday
  ];
  const items = [
    { id: 1, category: 'Dry Store', price_per_unit: 3000, shelf_life_days: null }, // expensive
    { id: 2, category: 'Dry Store', price_per_unit: 10, shelf_life_days: null },   // cheap
    { id: 3, category: 'Dry Store', price_per_unit: 100, shelf_life_days: null },  // filler
  ];
  const plan = {
    1: { qtys: [0, 1, 0], stockAfter: [0, 1, 0], buffers: [0, 0, 0] },
    2: { qtys: [1, 0, 1], stockAfter: [1, 1, 1], buffers: [0, 0, 0] },
    3: { qtys: [0, 1, 0], stockAfter: [0, 1, 1], buffers: [0, 0, 0] },
  };
  // Monday: 10, Wednesday: 3000 + 100 = 3100 (over target), Friday: 10
  // Item 1 can move from Wednesday to Monday, reducing max from 3100 to 3010
  const result = smoothDeliveryCosts({
    plan, items, deliveries, targetCost: 100,
    flexibleCategories: ['Dry Store'],
  });
  // Item 1 should have moved from index 1 to index 0
  assert.deepStrictEqual(result.moves, [{ itemId: 1, fromIndex: 1, toIndex: 0 }]);
  // After move, stockAfter[0] should be 0 + 1 = 1 (not 2 from double-increment)
  assert.strictEqual(result.plan[1].stockAfter[0], 1, 'stockAfter[0] should be 1, not double-incremented');
  // qtys should show item moved: [1, 0, 0]
  assert.deepStrictEqual(result.plan[1].qtys, [1, 0, 0]);
  // The unit now arrives Monday and is still there Wednesday: stock after Wednesday's delivery is unchanged
  // (it used to be wrongly dropped to 0), so a later move can't be judged against understated stock.
  assert.deepStrictEqual(result.plan[1].stockAfter, [1, 1, 0]);
});

test('does not move an item earlier if that would put stock above its max in store', () => {
  const deliveries = [{ date: '2026-09-21' }, { date: '2026-09-23' }];
  const items = [
    { id: 1, category: 'Dry Store', price_per_unit: 100, shelf_life_days: null, max_boxes: 2 },
    { id: 2, category: 'Dry Store', price_per_unit: 10, shelf_life_days: null, max_boxes: null },
  ];
  const plan = {
    1: { qtys: [1, 1], stockAfter: [2, 2], buffers: [0, 0] },
    2: { qtys: [0, 5], stockAfter: [0, 5], buffers: [0, 0] },
  };
  const result = smoothDeliveryCosts({ plan, items, deliveries, targetCost: 60, flexibleCategories: ['Dry Store'] });
  // Item 1 is the priciest and would be moved first, but +1 on delivery 0 would leave 3 in store (max 2).
  assert.strictEqual(result.plan[1].qtys[0], 1);
  assert.ok(result.plan[1].stockAfter[0] <= 2);
});
