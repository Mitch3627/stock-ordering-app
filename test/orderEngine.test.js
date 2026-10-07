const test = require('node:test');
const assert = require('node:assert');
const { computeDeliveryPlan } = require('../lib/orderEngine');

function makeDeliveries(dates) {
  return dates.map(date => ({ date, coverDays: [date] }));
}

test('orders enough to cover projected usage plus buffer', () => {
  const items = [{
    id: 1, name: 'Fries', items_per_order_unit: 1,
    usage_per_100_sales: 1, buffer_value: 2, max_boxes: null,
    case_multiple: null, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 0 }, deliveries,
    salesForDay: () => 1000, // usage = 1 * (1000/100) = 10
  });
  // target = usage(10) + buffer(2) = 12; on hand 0 -> order 12
  assert.strictEqual(plan[1].qtys[0], 12);
  assert.strictEqual(plan[1].stockAfter[0], 12);
});

test('never orders a negative quantity when on-hand exceeds target', () => {
  const items = [{
    id: 1, name: 'Fries', items_per_order_unit: 1,
    usage_per_100_sales: 1, buffer_value: 2, max_boxes: null,
    case_multiple: null, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 50 }, deliveries,
    salesForDay: () => 1000,
  });
  assert.strictEqual(plan[1].qtys[0], 0);
  assert.strictEqual(plan[1].stockAfter[0], 50);
});

test('max_boxes caps the order so stock-after never exceeds it', () => {
  const items = [{
    id: 1, name: 'Chives', items_per_order_unit: 1,
    usage_per_100_sales: 0.01, buffer_value: 2, max_boxes: 2,
    case_multiple: null, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 0 }, deliveries,
    salesForDay: () => 1000,
  });
  assert.ok(plan[1].stockAfter[0] <= 2);
});

test('case_multiple rounds the order up to a whole case, never a partial one', () => {
  const items = [{
    id: 1, name: 'Fine Table Salt', items_per_order_unit: 1,
    usage_per_100_sales: 0.05, buffer_value: 1, max_boxes: null,
    case_multiple: 10, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 0 }, deliveries,
    salesForDay: () => 1000, // usage = 0.5, target = 1.5 -> raw order 2 -> rounds to 10
  });
  assert.strictEqual(plan[1].qtys[0] % 10, 0);
  assert.ok(plan[1].qtys[0] >= 2);
});

test('case_multiple never breaches max_boxes - steps down to the largest fitting case', () => {
  const items = [{
    id: 1, name: 'Fine Table Salt', items_per_order_unit: 1,
    usage_per_100_sales: 0.05, buffer_value: 1, max_boxes: 15,
    case_multiple: 10, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 8 }, deliveries,
    salesForDay: () => 1000,
  });
  // raw case-rounded order would be 10, but 8 + 10 = 18 > max_boxes 15,
  // so it must step down to a case size that fits (0, since one case is 10 and 8+10>15)
  assert.strictEqual(plan[1].qtys[0], 0);
  assert.ok(plan[1].stockAfter[0] <= 15);
});

test('shelf_life_days caps the order so stock does not outlive its shelf life', () => {
  const items = [{
    id: 1, name: 'Fruit Pots', items_per_order_unit: 1,
    usage_per_100_sales: 0.02, buffer_value: 5, max_boxes: null,
    case_multiple: null, shelf_life_days: 2.5, avg_daily_sales: 1000
  }];
  // avg daily usage = 0.02 * (1000/100) = 0.2/day; max allowed stock = 0.2 * 2.5 = 0.5
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 0 }, deliveries,
    salesForDay: () => 1000,
  });
  assert.ok(plan[1].stockAfter[0] <= 0.5 + 1); // +1 for the "never zero out an order" floor
});

test('stock never goes negative across multiple deliveries', () => {
  const items = [{
    id: 1, name: 'Fries', items_per_order_unit: 1,
    usage_per_100_sales: 1, buffer_value: 0, max_boxes: null,
    case_multiple: null, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14', '2026-09-16', '2026-09-18']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 0 }, deliveries,
    salesForDay: () => 1000,
  });
  for (const stock of plan[1].stockAfter) {
    assert.ok(stock >= 0);
  }
});

test('case_multiple fitCap step-down: genuinely rounds raw demand up then steps down to largest fitting case', () => {
  const items = [{
    id: 1, name: 'Fine Table Salt', items_per_order_unit: 1,
    usage_per_100_sales: 1, buffer_value: 10, max_boxes: 15,
    case_multiple: 10, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 8 }, deliveries,
    salesForDay: () => 1000, // usage = 1*(1000/100) = 10; target = 10+10 = 20; raw order = ceil(20-8) = 12; case-rounds to 20; fitCap = 0 -> final order 0
  });
  // Verify fitCap step-down was exercised: raw demand was positive, got rounded up by case_multiple,
  // then stepped down by fitCap because one case doesn't fit under max_boxes
  assert.strictEqual(plan[1].qtys[0], 0);
  assert.ok(plan[1].stockAfter[0] <= 15);
});

test('case_multiple > max_boxes: order one full case instead of zero to avoid stockout', () => {
  const items = [{
    id: 1, name: 'Bulk Item', items_per_order_unit: 1,
    usage_per_100_sales: 1, buffer_value: 0, max_boxes: 5,
    case_multiple: 20, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: 0 }, deliveries,
    salesForDay: () => 1000, // usage = 10, target = 10, raw order = 10; max_boxes caps to 5; case-rounds to 20; fitCap = 0 -> ordered 20 (one case) instead of 0
  });
  // When fitCap = 0 (can't fit even one case), order exactly one case to avoid stockout
  assert.strictEqual(plan[1].qtys[0], 20);
  // Stock after should not be negative (even though it exceeds max_boxes by one case)
  assert.ok(plan[1].stockAfter[0] >= 0);
});

test('negative on-hand is treated as empty, so an order never pushes stock above max_boxes', () => {
  const items = [{
    id: 1, name: 'Ranch Dip', items_per_order_unit: 1,
    usage_per_100_sales: 0.5, buffer_value: 0.6, max_boxes: 2,
    case_multiple: null, shelf_life_days: null, avg_daily_sales: 5000,
  }];
  const deliveries = makeDeliveries(['2026-09-21', '2026-09-23', '2026-09-25']);
  const plan = computeDeliveryPlan({
    items, onHand: { 1: -1.19 }, deliveries, salesForDay: () => 5000,
  });
  for (let i = 0; i < deliveries.length; i++) {
    assert.ok(plan[1].qtys[i] <= 2, `delivery ${i} orders ${plan[1].qtys[i]}, over max 2`);
    assert.ok(plan[1].stockAfter[i] <= 2, `delivery ${i} leaves ${plan[1].stockAfter[i]} in store, over max 2`);
  }
});

test('a shortfall is not carried forward as a negative balance that inflates later orders', () => {
  const items = [{
    id: 1, name: 'Ranch Dip', items_per_order_unit: 1,
    usage_per_100_sales: 1, buffer_value: 0, max_boxes: 3,
    case_multiple: null, shelf_life_days: null, avg_daily_sales: 1000,
  }];
  const deliveries = makeDeliveries(['2026-09-21', '2026-09-23']);
  const plan = computeDeliveryPlan({ items, onHand: { 1: 0 }, deliveries, salesForDay: () => 1000 });
  // usage 10 per delivery but max 3: the first order is capped at 3 and the store runs out.
  // Unmet demand is lost, not owed, so the second delivery is again 3, not 3 + a backlog.
  assert.deepStrictEqual(plan[1].qtys, [3, 3]);
});

test('a confirmed order keeps its quantity but still carries the suggestion it replaced', () => {
  const items = [{
    id: 1, name: 'Fries', items_per_order_unit: 1,
    usage_per_100_sales: 1, buffer_value: 2, max_boxes: 15,
    case_multiple: 5, shelf_life_days: null, avg_daily_sales: 1000
  }];
  const deliveries = makeDeliveries(['2026-09-14', '2026-09-16']);
  const args = { items, onHand: { 1: 4 }, deliveries, salesForDay: () => 1000 }; // usage 10 a delivery
  const planned = computeDeliveryPlan(args);
  const confirmed = computeDeliveryPlan({ ...args, fixedOrders: { '2026-09-14': { 1: 20 } } });
  assert.strictEqual(confirmed[1].qtys[0], 20);
  // target 12 - 4 on hand = 8, max 15 allows 11, cases of 5 -> 10
  assert.strictEqual(planned[1].qtys[0], 10);
  assert.deepStrictEqual(confirmed[1].explain[0].suggested, { need: 8, order: 10, limits: planned[1].explain[0].limits });
  // later deliveries are planned on top of what was really ordered
  assert.strictEqual(confirmed[1].explain[1].before, 14);
  assert.strictEqual(planned[1].explain[0].suggested, undefined);
});
