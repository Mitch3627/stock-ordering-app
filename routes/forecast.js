const express = require('express');
const { requireManager } = require('../lib/auth');
const { applyDailyDecay } = require('../ledger/decay');
const { applyEventWithConsumption, returnStock } = require('../ledger/ledger');
const { latestCountDate } = require('../lib/baseline');
const { badRequest, isDate, toNumber } = require('../lib/validate');

const EPS = 1e-6;
const money = (n) => '£' + Number(n).toLocaleString('en-GB');

// Optional sales figure: undefined/null stays unset, anything else must be a number of 0 or more.
function salesValue(value, date) {
  if (value === undefined || value === null) return null;
  const n = toNumber(value);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw badRequest(`Sales for ${date} must be a number of 0 or more`);
  return n;
}

// A day's real sales were applied to stock at `from` and are now `to`: move every item's usage for that day
// by the same proportion (using the rate each item had when the day was applied), taking more stock off or
// putting it back into the batches it came from.
function correctDayUsage(db, date, from, to, note) {
  const used = db.prepare(`
    SELECT item_id, -SUM(qty_delta) AS used FROM inventory_events
    WHERE type = 'usage_decay' AND occurred_at = ? GROUP BY item_id
  `).all(date);
  if (from > 0 && used.length > 0) {
    const eventIds = db.prepare("SELECT id FROM inventory_events WHERE type = 'usage_decay' AND occurred_at = ? AND item_id = ?");
    for (const u of used) {
      const change = u.used * (to / from) - u.used;
      if (change > EPS) {
        applyEventWithConsumption(db, { itemId: u.item_id, type: 'usage_decay', qtyDelta: -change, occurredAt: date, note });
      } else if (change < -EPS) {
        returnStock(db, {
          itemId: u.item_id, type: 'usage_decay', qty: -change, occurredAt: date, note,
          fromEventIds: eventIds.all(date, u.item_id).map(r => r.id),
        });
      }
    }
  } else if (to > from) {
    // Nothing recorded to scale from (the day was applied at £0): use today's usage rates.
    applyDailyDecay(db, { date, actualSales: to - from, note });
  }
}

function createForecastRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from and to must be dates (YYYY-MM-DD)' });
    const rows = db.prepare(`
      SELECT * FROM sales_forecast WHERE date BETWEEN ? AND ? ORDER BY date ASC
    `).all(from, to);
    res.json(rows);
  });

  router.put('/', requireManager, (req, res) => {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be a list' });
    const clean = entries.map(e => {
      if (!e || !isDate(e.date)) throw badRequest('each entry needs a date (YYYY-MM-DD)');
      return {
        date: e.date,
        forecastedSales: salesValue(e.forecastedSales, e.date),
        actualSales: salesValue(e.actualSales, e.date),
        clearActual: e.clearActual === true,
      };
    });

    const upsert = db.prepare(`
      INSERT INTO sales_forecast (date, forecasted_sales, actual_sales, decayed)
      VALUES (@date, @forecastedSales, NULL, 0)
      ON CONFLICT(date) DO UPDATE SET
        forecasted_sales = COALESCE(@forecastedSales, sales_forecast.forecasted_sales)
    `);
    const getRow = db.prepare('SELECT * FROM sales_forecast WHERE date = ?');
    const setActual = db.prepare('UPDATE sales_forecast SET actual_sales = ?, decayed = ? WHERE date = ?');

    const decayedDates = [];
    const alreadyDecayedDates = [];
    const skippedDecayDates = [];
    const correctedDates = [];
    const clearedDates = [];
    db.transaction(() => {
      for (const entry of clean) {
        const before = getRow.get(entry.date);
        upsert.run({ date: entry.date, forecastedSales: entry.forecastedSales });
        const counted = latestCountDate(db);
        // Usage on or before the latest count date (or before any count exists) is already reflected in the
        // counted stock, so sales for those days are recorded but never change stock.
        const coveredByCount = !counted || entry.date <= counted;
        const wasApplied = before && before.decayed && before.actual_sales != null;

        if (entry.clearActual) {
          if (before && before.actual_sales != null) {
            if (wasApplied && !coveredByCount) {
              correctDayUsage(db, entry.date, before.actual_sales, 0, `Real sales removed (were ${money(before.actual_sales)})`);
            }
            setActual.run(null, 0, entry.date);
            clearedDates.push(entry.date);
          }
          continue;
        }
        if (entry.actualSales == null) continue;

        if (!wasApplied) {
          setActual.run(entry.actualSales, 1, entry.date);
          if (coveredByCount) {
            skippedDecayDates.push(entry.date);
          } else {
            applyDailyDecay(db, { date: entry.date, actualSales: entry.actualSales });
            decayedDates.push(entry.date);
          }
        } else if (Math.abs(entry.actualSales - before.actual_sales) < 0.005) {
          alreadyDecayedDates.push(entry.date);
        } else {
          setActual.run(entry.actualSales, 1, entry.date);
          if (!coveredByCount) {
            correctDayUsage(db, entry.date, before.actual_sales, entry.actualSales,
              `Real sales corrected ${money(before.actual_sales)} -> ${money(entry.actualSales)}`);
          }
          correctedDates.push({ date: entry.date, from: before.actual_sales, to: entry.actualSales, stockChanged: !coveredByCount });
        }
      }
    })();

    res.json({ updated: clean.length, decayedDates, alreadyDecayedDates, skippedDecayDates, correctedDates, clearedDates });
  });

  return router;
}

module.exports = { createForecastRouter };
