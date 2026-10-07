const express = require('express');
const { requireManager } = require('../lib/auth');
const { getAllOnHand } = require('../ledger/ledger');
const { computeDeliveryPlan } = require('../lib/orderEngine');
const { computeExpiryLoss } = require('../lib/expiryLoss');
const { smoothDeliveryCosts, deliveryCost } = require('../lib/costSmoothing');
const { latestCountDate } = require('../lib/baseline');
const { addDays, daysBetween, todayLocal } = require('../lib/dates');
const { requireDate } = require('../lib/validate');
const { DAY_NAMES, DEFAULT_SCHEDULE, deliverySchedule, getSettings } = require('../lib/settings');
const { currentUserId } = require('../lib/context');

const DAY_MS = 86400000;
const round = (n, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

function fmt(d) { return d.toISOString().slice(0, 10); }

// Days from (and including) todayStr up to (but not including) firstDeliveryDateStr.
function bridgeDays(todayStr, firstDeliveryDateStr) {
  const days = [];
  let d = new Date(todayStr + 'T00:00:00Z');
  const end = new Date(firstDeliveryDateStr + 'T00:00:00Z');
  while (d.getTime() < end.getTime()) {
    days.push(fmt(d));
    d = new Date(d.getTime() + DAY_MS);
  }
  return days;
}

// The order engine's onHand contract requires callers to bridge raw current on-hand
// forward to the first delivery's date (see lib/orderEngine.js). Otherwise usage
// between "today" and the first delivery (e.g. a manager opening the page mid-week,
// with the next delivery on Monday) is never subtracted.
function bridgeOnHand(onHand, items, todayStr, firstDeliveryDateStr, salesForDay) {
  const days = bridgeDays(todayStr, firstDeliveryDateStr);
  const bridged = {};
  for (const item of items) {
    const current = onHand[item.id] || 0;
    if (days.length === 0) {
      bridged[item.id] = current;
      continue;
    }
    const sales = days.reduce((sum, d) => sum + salesForDay(d), 0);
    const usage = item.usage_per_100_sales * (sales / 100);
    bridged[item.id] = current - usage;
  }
  return bridged;
}

const weekday = (dateStr) => new Date(dateStr + 'T00:00:00Z').getUTCDay();

// The day a delivery's order is placed, from the store's schedule (Settings) - by default Monday's on the Friday
// before, Wednesday's on Monday and Friday's on Wednesday.
function orderDay(deliveryDateStr, schedule = DEFAULT_SCHEDULE) {
  return addDays(deliveryDateStr, -(schedule.lead[weekday(deliveryDateStr)] ?? 2));
}

// How many days a delivery of each use-by tracked item stays usable (delivery day to use-by day, inclusive):
// the median over the deliveries logged with use-by dates. Items with none logged yet get no limit.
function learnedShelfLife(db) {
  const byItem = {};
  // Batches given a new date by hand (e.g. taken out to defrost) don't show how long a delivery keeps.
  for (const b of db.prepare('SELECT item_id, received_at, use_by_date FROM batches WHERE delivery_id IS NOT NULL AND redated_at IS NULL').all()) {
    const days = daysBetween(b.received_at, b.use_by_date) + 1;
    if (days >= 1) (byItem[b.item_id] = byItem[b.item_id] || []).push(days);
  }
  const out = {};
  for (const [id, list] of Object.entries(byItem)) {
    list.sort((a, b) => a - b);
    const mid = Math.floor(list.length / 2);
    out[id] = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  }
  return out;
}

function buildPlan(db, { today, deliveries, targetCost, flexibleCategories, fallbackSales }) {
  const schedule = deliverySchedule(db);
  const items = db.prepare('SELECT * FROM items WHERE active = 1').all();
  const onHandNow = getAllOnHand(db);
  // Confirmed orders whose delivery day has passed but which haven't been logged (or marked not arrived) are
  // still expected: count them as arriving before the first planned delivery.
  const pending = {};
  if (deliveries.length > 0) {
    for (const r of db.prepare('SELECT item_id, SUM(qty) AS q FROM confirmed_order_lines WHERE delivery_date < ? GROUP BY item_id').all(deliveries[0].date)) {
      pending[r.item_id] = r.q;
    }
  }
  const onHand = {};
  for (const item of items) onHand[item.id] = (onHandNow[item.id] || 0) + (pending[item.id] || 0);

  const forecastRows = db.prepare('SELECT * FROM sales_forecast').all();
  const forecastedRows = forecastRows.filter(r => r.forecasted_sales != null);
  const forecastByDate = {};
  for (const row of forecastedRows) forecastByDate[row.date] = row.forecasted_sales;
  const salesForDay = (dateStr) => forecastByDate[dateStr] ?? fallbackSales;

  const shelfLife = learnedShelfLife(db);
  const engineItems = items.map(it => ({
    ...it,
    planning_shelf_life: it.track_use_by ? (shelfLife[it.id] ?? null) : null,
  }));

  // Usage on a day that a count has already covered (a count taken tonight) isn't taken off again.
  const counted = latestCountDate(db);
  const usageFrom = counted && counted >= today ? addDays(counted, 1) : today;
  const bridge = deliveries.length > 0 ? bridgeDays(usageFrom, deliveries[0].date) : [];
  const bridgeSales = bridge.reduce((s, d) => s + salesForDay(d), 0);

  let bridgedOnHand = deliveries.length > 0
    ? bridgeOnHand(onHand, items, usageFrom, deliveries[0].date, salesForDay)
    : onHand;

  // Tracked stock that will go out of date before it's used counts as extra usage.
  const expiryLoss = {};
  const expiryBeforeFirst = {};
  if (deliveries.length > 0) {
    const batchRows = db.prepare('SELECT item_id, use_by_date, qty_remaining FROM batches WHERE qty_remaining > 0').all();
    const batchesByItem = {};
    for (const b of batchRows) (batchesByItem[b.item_id] = batchesByItem[b.item_id] || []).push(b);
    bridgedOnHand = { ...bridgedOnHand };
    for (const item of items) {
      if (!batchesByItem[item.id]) continue;
      const loss = computeExpiryLoss({
        batches: batchesByItem[item.id],
        dailyUsage: (d) => item.usage_per_100_sales * (salesForDay(d) / 100),
        startDate: usageFrom,
        deliveryDates: deliveries.map(d => d.date),
      });
      bridgedOnHand[item.id] = (bridgedOnHand[item.id] || 0) - loss.bridge;
      expiryBeforeFirst[item.id] = loss.bridge;
      expiryLoss[item.id] = loss.perDelivery;
    }
  }

  // Orders already placed are fixed, and their quantities count as stock arriving that morning.
  const inPlan = new Set(deliveries.map(d => d.date));
  const fixedOrders = {};
  for (const r of db.prepare('SELECT delivery_date FROM order_confirmations').all()) {
    if (inPlan.has(r.delivery_date)) fixedOrders[r.delivery_date] = {};
  }
  for (const l of db.prepare('SELECT delivery_date, item_id, qty FROM confirmed_order_lines').all()) {
    if (fixedOrders[l.delivery_date]) fixedOrders[l.delivery_date][l.item_id] = l.qty;
  }
  const lockedIndexes = deliveries.map((d, i) => (fixedOrders[d.date] ? i : -1)).filter(i => i >= 0);

  const rawPlan = computeDeliveryPlan({
    items: engineItems, onHand: bridgedOnHand, deliveries, salesForDay, expiryLoss, fixedOrders,
  });
  const { plan: smoothed, moves } = smoothDeliveryCosts({
    plan: rawPlan, items, deliveries, targetCost, flexibleCategories, lockedIndexes,
  });

  // Re-run the plan with the final quantities fixed, so "projected on hand" is exact after any cost-smoothing moves.
  const finalOrders = {};
  deliveries.forEach((d, i) => {
    finalOrders[d.date] = {};
    for (const it of items) finalOrders[d.date][it.id] = smoothed[it.id].qtys[i];
  });
  const finalPlan = computeDeliveryPlan({
    items: engineItems, onHand: bridgedOnHand, deliveries, salesForDay, expiryLoss, fixedOrders: finalOrders,
  });

  const costs = deliveries.map((_, i) => Math.round(deliveryCost(smoothed, items, i) * 100) / 100);

  return {
    deliveries: deliveries.map(d => d.date),
    orderBy: deliveries.map(d => orderDay(d.date, schedule)),
    confirmedDates: deliveries.filter(d => fixedOrders[d.date]).map(d => d.date),
    cover: deliveries.map(d => ({
      from: d.coverDays[0], to: d.coverDays[d.coverDays.length - 1],
      sales: Math.round(d.coverDays.reduce((s, day) => s + salesForDay(day), 0)),
    })),
    bridge: { from: usageFrom, days: bridge.length, sales: Math.round(bridgeSales) },
    items: engineItems.map(it => {
      const explain = rawPlan[it.id].explain.map(step => ({ ...step }));
      for (const m of moves.filter(mv => mv.itemId === it.id)) {
        explain[m.fromIndex].movedTo = deliveries[m.toIndex].date;
        explain[m.toIndex].movedFrom = deliveries[m.fromIndex].date;
      }
      return {
        id: it.id, name: it.name, category: it.category, unit_label: it.unit_label, price: it.price_per_unit,
        supplier_name: it.supplier_name, supplier_unit: it.supplier_unit, supplier_product_id: it.supplier_product_id,
        items_per_order_unit: it.items_per_order_unit, supplier_order_pack: it.supplier_order_pack, supplier_sort: it.supplier_sort,
        qtys: smoothed[it.id].qtys, stockAfter: finalPlan[it.id].stockAfter,
        start: {
          now: round(onHandNow[it.id] || 0), pending: round(pending[it.id] || 0),
          usage: round(it.usage_per_100_sales * (bridgeSales / 100)), expiry: round(expiryBeforeFirst[it.id] || 0),
          shelfLife: it.shelf_life_days ?? it.planning_shelf_life,
        },
        explain,
      };
    }),
    costs,
    moves,
    targetCost,
  };
}

function isDeliveryDay(dateStr, schedule = DEFAULT_SCHEDULE) {
  return !!dateStr && schedule.cover[weekday(dateStr)] !== undefined;
}

// Deliveries on the store's delivery days from a date on; each has to last until the next one arrives.
function buildScheduleFrom(startDateStr, numDeliveries, schedule = DEFAULT_SCHEDULE) {
  const deliveries = [];
  for (let d = startDateStr; deliveries.length < numDeliveries; d = addDays(d, 1)) {
    const cover = schedule.cover[weekday(d)];
    if (cover !== undefined) deliveries.push({ date: d, coverDays: Array.from({ length: cover }, (_, i) => addDays(d, i)) });
  }
  return deliveries;
}

// First delivery day on or after today whose stock is not already accounted for: today's delivery is
// skipped once it has been logged (already on hand) or marked as not arrived.
function planStartDate(db, today, schedule) {
  const logged = db.prepare('SELECT 1 FROM deliveries WHERE delivered_at = ?');
  const skipped = db.prepare('SELECT 1 FROM skipped_deliveries WHERE date = ?');
  let d = new Date(today + 'T00:00:00Z');
  for (let i = 0; i < 10; i++) {
    const s = fmt(d);
    if (isDeliveryDay(s, schedule) && !logged.get(s) && !skipped.get(s)) return s;
    d = new Date(d.getTime() + DAY_MS);
  }
  return fmt(d);
}

// Every planned delivery from the next one onward, so deliveries still to come this week count.
function planSchedule(db, today, numDeliveries) {
  const schedule = deliverySchedule(db);
  return buildScheduleFrom(planStartDate(db, today, schedule), numDeliveries, schedule);
}

function createOrdersRouter(db, options = {}) {
  const getToday = options.today || todayLocal;
  const numDeliveries = options.numDeliveries ?? 12;
  // Target, default daily sales and movable categories come from Settings (tests can pass their own).
  const planOptions = (fallbackSales) => {
    const s = getSettings(db);
    return {
      targetCost: options.targetCost ?? s.targetCost,
      flexibleCategories: options.flexibleCategories ?? s.flexibleCategories,
      fallbackSales: fallbackSales || s.fallbackSales,
    };
  };

  const router = express.Router();

  // Place (or change) the order for a delivery: quantities are fixed from here on.
  router.put('/confirm', requireManager, (req, res) => {
    const { date, lines } = req.body;
    const schedule = deliverySchedule(db);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !isDeliveryDay(date, schedule)) {
      return res.status(400).json({ error: `date must be a delivery day (${schedule.days.map(d => DAY_NAMES[d.day]).join(', ')})` });
    }
    if (date < getToday()) return res.status(400).json({ error: 'that delivery date has already passed' });
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be an array' });
    const exists = db.prepare('SELECT 1 FROM items WHERE id = ?');
    const seen = new Set();
    for (const l of lines) {
      if (!(Number.isFinite(l.qty) && l.qty >= 0) || !exists.get(l.itemId)) return res.status(400).json({ error: 'each line needs an existing item and a quantity of 0 or more' });
      if (seen.has(Number(l.itemId))) return res.status(400).json({ error: 'the same item is on the order twice' });
      seen.add(Number(l.itemId));
    }
    db.transaction(() => {
      db.prepare('DELETE FROM confirmed_order_lines WHERE delivery_date = ?').run(date);
      db.prepare(`INSERT INTO order_confirmations (delivery_date, confirmed_by) VALUES (?, ?)
        ON CONFLICT(delivery_date) DO UPDATE SET confirmed_at = datetime('now'), confirmed_by = excluded.confirmed_by`).run(date, currentUserId());
      const insert = db.prepare('INSERT INTO confirmed_order_lines (delivery_date, item_id, qty) VALUES (?, ?, ?)');
      for (const l of lines) if (l.qty > 0) insert.run(date, l.itemId, l.qty);
    })();
    res.json({ date, lines: lines.filter(l => l.qty > 0).length });
  });

  // Take an order back to the plan.
  router.delete('/confirm/:date', requireManager, (req, res) => {
    db.prepare('DELETE FROM order_confirmations WHERE delivery_date = ?').run(req.params.date);
    res.json({ date: req.params.date });
  });

  // Confirmed orders that haven't been received yet: what is on its way, per item (soonest delivery).
  router.get('/incoming', (req, res) => {
    const rows = db.prepare(`
      SELECT l.item_id, l.delivery_date, l.qty FROM confirmed_order_lines l
      ORDER BY l.delivery_date ASC
    `).all();
    const out = {};
    for (const r of rows) if (!out[r.item_id]) out[r.item_id] = { date: r.delivery_date, qty: r.qty };
    res.json(out);
  });

  // What should arrive in a delivery: the confirmed order when there is one, otherwise the plan's suggestion.
  router.get('/expected/:date', (req, res) => {
    const date = requireDate(req.params.date, 'date');
    const confirmed = db.prepare('SELECT 1 FROM order_confirmations WHERE delivery_date = ?').get(date);
    if (confirmed) {
      const lines = db.prepare('SELECT item_id AS itemId, qty FROM confirmed_order_lines WHERE delivery_date = ?').all(date);
      return res.json({ date, source: 'confirmed', lines });
    }
    const today = getToday();
    const schedule = planSchedule(db, today, numDeliveries);
    let idx = schedule.findIndex(d => d.date === date);
    let plan;
    if (idx >= 0) {
      plan = buildPlan(db, { today, deliveries: schedule, ...planOptions() });
    } else {
      plan = buildPlan(db, { today: date < today ? date : today, deliveries: buildScheduleFrom(date, 1, deliverySchedule(db)), ...planOptions() });
      idx = 0;
    }
    const lines = plan.items.filter(p => p.qtys[idx] > 0).map(p => ({ itemId: p.id, qty: p.qtys[idx] }));
    res.json({ date, source: 'suggested', lines });
  });

  router.get('/plan', (req, res) => {
    const deliveries = planSchedule(db, getToday(), numDeliveries);
    res.json(buildPlan(db, { today: getToday(), deliveries, ...planOptions(Number(req.query.avgDailySales) || null) }));
  });

  return router;
}

module.exports = {
  createOrdersRouter, orderDay, planSchedule, bridgeOnHand, buildPlan, buildScheduleFrom, isDeliveryDay, learnedShelfLife,
};
