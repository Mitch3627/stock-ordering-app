const express = require('express');
const { getAllOnHand } = require('../ledger/ledger');
const { buildPlan, planSchedule } = require('./orders');
const { salesDaysDue, weeklyCountDue, shift } = require('./prompts');
const { expiredStock } = require('../lib/expiredStock');
const { todayLocal } = require('../lib/dates');
const { getSettings } = require('../lib/settings');

const DAY_MS = 86400000;

function createDashboardRouter(db, options = {}) {
  const getToday = options.today || todayLocal;
  const router = express.Router();

  router.get('/', (req, res) => {
    const today = getToday();
    const daysLeft = (d) => Math.round((new Date(d + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / DAY_MS);

    const batches = db.prepare(`
      SELECT batches.use_by_date, batches.qty_remaining, items.name AS item_name,
             items.unit_label, items.supplier_unit, items.items_per_order_unit
      FROM batches JOIN items ON items.id = batches.item_id
      WHERE batches.qty_remaining > 0
      ORDER BY batches.use_by_date ASC, batches.received_at ASC, batches.id ASC
    `).all().map(b => ({ ...b, daysLeft: daysLeft(b.use_by_date) }));

    const items = db.prepare('SELECT id, name, category, usage_per_100_sales, unit_label, supplier_unit, items_per_order_unit FROM items WHERE active = 1').all();
    const onHand = getAllOnHand(db);

    const settings = getSettings(db);
    const deliveries = planSchedule(db, today, 12);
    let nextDelivery = null;
    let plan = null;
    if (deliveries.length > 0) {
      const s = settings;
      plan = buildPlan(db, {
        today, deliveries,
        targetCost: options.targetCost ?? s.targetCost,
        flexibleCategories: options.flexibleCategories ?? s.flexibleCategories,
        fallbackSales: s.fallbackSales,
      });
      nextDelivery = {
        date: plan.deliveries[0],
        orderBy: plan.orderBy[0],
        confirmed: plan.confirmedDates.includes(plan.deliveries[0]),
        itemCount: plan.items.filter(p => p.qtys[0] > 0).length,
        cost: plan.costs[0],
        targetCost: plan.targetCost,
      };
    }

    // Lowest stock by how long it will last (days of cover), not by raw numbers - half a case of beef and half a
    // case of napkins aren't comparable. Items with no usage rate yet (e.g. new chemicals) are left out.
    const forecast = db.prepare('SELECT forecasted_sales FROM sales_forecast WHERE date >= ? AND date < ? AND forecasted_sales IS NOT NULL').all(today, shift(today, 7));
    const dailySales = forecast.length ? forecast.reduce((s, r) => s + r.forecasted_sales, 0) / forecast.length : settings.fallbackSales;
    const planRow = plan ? Object.fromEntries(plan.items.map(p => [p.id, p])) : {};
    const stock = items.filter(i => i.usage_per_100_sales > 0).map(i => {
      const qty = Math.round((onHand[i.id] || 0) * 100) / 100;
      const perDay = i.usage_per_100_sales * dailySales / 100;
      const cover = Math.max(0, qty) / perDay;
      const row = planRow[i.id];
      const nextIdx = row ? row.qtys.findIndex(q => q > 0) : -1;
      const nextArrival = nextIdx >= 0 ? plan.deliveries[nextIdx] : null;
      return {
        name: i.name, onHand: qty, unit_label: i.unit_label, supplier_unit: i.supplier_unit, items_per_order_unit: i.items_per_order_unit,
        daysLeft: Math.round(cover * 10) / 10, nextArrival,
        runsOut: nextArrival ? cover < daysLeft(nextArrival) : false,
      };
    }).sort((a, b) => a.daysLeft - b.daysLeft || a.onHand - b.onHand);

    const yesterday = shift(today, -1);
    const y = db.prepare('SELECT forecasted_sales, actual_sales FROM sales_forecast WHERE date = ?').get(yesterday);

    const weekAgo = shift(today, -7);
    const waste = db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(ood), 0) AS ood FROM waste_entries WHERE occurred_at >= ? AND deleted_at IS NULL').get(weekAgo);
    const expired = expiredStock(db, today);

    const lastCount = db.prepare('SELECT MAX(counted_at) AS d FROM counts').get().d;
    const categories = [...new Set(items.map(i => i.category))].sort();

    res.json({
      today,
      useBy: {
        next: batches.slice(0, 5),
        soonCount: batches.filter(b => b.daysLeft <= 1).length,
        // which items, so the dashboard can name them
        soonItems: [...new Set(batches.filter(b => b.daysLeft <= 1).map(b => b.item_name))],
        trackedBatches: batches.length,
      },
      nextDelivery,
      inventory: {
        itemsTracked: items.length,
        atOrBelowZero: stock.filter(s => s.onHand <= 0).length,
        runningOut: stock.filter(s => s.runsOut).length,
        runningOutItems: stock.filter(s => s.runsOut).map(s => ({ name: s.name, nextArrival: s.nextArrival, daysLeft: s.daysLeft })),
        atOrBelowZeroItems: stock.filter(s => s.onHand <= 0).map(s => s.name),
        lowest: stock.slice(0, 5),
      },
      sales: {
        yesterday,
        projected: y ? y.forecasted_sales : null,
        actual: y ? y.actual_sales : null,
        unloggedDays: salesDaysDue(db, today).length,
      },
      waste: { entriesLast7Days: waste.entries, oodLast7Days: waste.ood, expiredNotLogged: expired.length, expiredItems: expired.map(e => e.item_name) },
      count: { last: lastCount, ...weeklyCountDue(db, today) },
      master: { itemCount: items.length, categories },
    });
  });

  return router;
}

module.exports = { createDashboardRouter };
