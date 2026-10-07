const express = require('express');
const { requireManager } = require('../lib/auth');
const { getAllOnHand } = require('../ledger/ledger');
const { buildPlan, buildScheduleFrom, isDeliveryDay } = require('./orders');
const { baselineDone, latestCountDate } = require('../lib/baseline');
const { orderDay } = require('./orders');
const { todayLocal, addDays } = require('../lib/dates');
const { deliverySchedule, getSettings } = require('../lib/settings');

const MAX_SALES_DAYS = 14;
const DELIVERY_LOOKBACK_DAYS = 4;

const shift = addDays; // kept under its old name for the dashboard

// Real sales still owed: every day since the last one logged, capped; only yesterday if none ever logged.
function salesDaysDue(db, today) {
  const yesterday = shift(today, -1);
  const counted = latestCountDate(db);
  if (!counted) return []; // brand-new store: nothing to log until the first count sets the baseline
  const lastReal = db.prepare('SELECT MAX(date) AS d FROM sales_forecast WHERE actual_sales IS NOT NULL').get().d;
  // Usage up to the count date is already reflected in that count.
  const last = lastReal && lastReal > counted ? lastReal : counted;
  const days = [];
  for (let d = shift(last, 1); d <= yesterday; d = shift(d, 1)) days.push(d);
  return days.slice(-MAX_SALES_DAYS);
}

// Weekly count: due Sunday and Monday until at least half the active items have been counted since the most
// recent Sunday (in one count or several) - a quick spot check of a few items doesn't count as the weekly count.
function weeklyCountDue(db, today) {
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  const since = dow === 0 ? today : dow === 1 ? shift(today, -1) : null;
  if (!since) return { due: false, since };
  const active = db.prepare('SELECT COUNT(*) AS n FROM items WHERE active = 1').get().n;
  const counted = db.prepare(`
    SELECT COUNT(DISTINCT cl.item_id) AS n FROM count_lines cl JOIN counts c ON c.id = cl.count_id
    WHERE c.counted_at >= ?
  `).get(since).n;
  return { due: counted < Math.max(1, Math.ceil(active / 2)), since };
}

// Tracked items whose on-hand exceeds the quantity sitting in dated batches (e.g. stock found by a count).
function useByNeeded(db) {
  const tracked = db.prepare('SELECT id, name, unit_label, supplier_unit, items_per_order_unit FROM items WHERE active = 1 AND track_use_by = 1').all();
  const onHand = getAllOnHand(db);
  const batched = db.prepare('SELECT COALESCE(SUM(qty_remaining), 0) AS q FROM batches WHERE item_id = ? AND qty_remaining > 0');
  const out = [];
  for (const item of tracked) {
    const have = onHand[item.id] || 0;
    const dated = batched.get(item.id).q;
    const missing = Math.round((have - dated) * 100) / 100;
    if (missing > 0) out.push({
      itemId: item.id, name: item.name, unit_label: item.unit_label,
      supplier_unit: item.supplier_unit || item.unit_label, items_per_order_unit: item.items_per_order_unit,
      onHand: have, dated: Math.round(dated * 1e6) / 1e6, missing,
    });
  }
  return out;
}

function createPromptsRouter(db, options = {}) {
  const getToday = options.today || todayLocal;
  const router = express.Router();

  router.get('/', (req, res) => {
    const today = getToday();

    const baseline = baselineDone(db);
    const schedule = deliverySchedule(db);
    const settings = getSettings(db);
    const salesDays = salesDaysDue(db, today);

    // Scheduled delivery days that have passed (or are today) with no delivery logged.
    const logged = new Set(db.prepare('SELECT delivered_at FROM deliveries').all().map(r => r.delivered_at));
    const skipped = new Set(db.prepare('SELECT date FROM skipped_deliveries').all().map(r => r.date));
    const items = db.prepare('SELECT * FROM items WHERE active = 1').all();
    const deliveries = [];
    for (let d = shift(today, -DELIVERY_LOOKBACK_DAYS); baseline && d <= today; d = shift(d, 1)) {
      if (!isDeliveryDay(d, schedule) || logged.has(d) || skipped.has(d)) continue;
      const plan = buildPlan(db, {
        today: d, deliveries: buildScheduleFrom(d, 1, schedule),
        targetCost: options.targetCost ?? settings.targetCost,
        flexibleCategories: options.flexibleCategories ?? settings.flexibleCategories,
        fallbackSales: settings.fallbackSales,
      });
      const lines = plan.items
        .filter(p => p.qtys[0] > 0)
        .map(p => {
          const item = items.find(i => i.id === p.id);
          return { itemId: p.id, name: p.name, unit_label: p.unit_label, qty: p.qtys[0], trackUseBy: !!item.track_use_by };
        });
      // confirmed: the lines are the order that was placed; otherwise they're only the plan's suggestion
      deliveries.push({ date: d, confirmed: plan.confirmedDates.includes(d), lines });
    }

    const weeklyCount = baseline ? weeklyCountDue(db, today) : { due: false, since: null };

    // Orders whose placing day has arrived but which haven't been confirmed yet
    const confirmed = new Set(db.prepare('SELECT delivery_date FROM order_confirmations').all().map(r => r.delivery_date));
    const ordersDue = [];
    for (let d = shift(today, 1); baseline && d <= shift(today, 7); d = shift(d, 1)) {
      if (!isDeliveryDay(d, schedule) || confirmed.has(d) || logged.has(d) || skipped.has(d)) continue;
      const by = orderDay(d, schedule);
      if (by <= today) ordersDue.push({ deliveryDate: d, orderBy: by });
    }

    // The forecast for each day asked about, so a typo in real sales (£45,000 for £4,500) can be caught.
    const forecastOf = db.prepare('SELECT forecasted_sales FROM sales_forecast WHERE date = ?');
    const salesForecasts = Object.fromEntries(salesDays.map(d => [d, (forecastOf.get(d) || {}).forecasted_sales ?? null]));

    res.json({
      ordersDue,
      firstCount: { due: !baseline },
      salesDays, salesForecasts, deliveries, weeklyCount,
      useByNeeded: baseline ? useByNeeded(db) : [],
    });
  });

  router.post('/skip-delivery', requireManager, (req, res) => {
    const { date } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    db.prepare('INSERT OR IGNORE INTO skipped_deliveries (date) VALUES (?)').run(date);
    db.prepare('DELETE FROM order_confirmations WHERE delivery_date = ?').run(date); // it isn't coming
    res.status(201).json({ date });
  });

  return router;
}

module.exports = { createPromptsRouter, salesDaysDue, weeklyCountDue, baselineDone, useByNeeded, shift };
