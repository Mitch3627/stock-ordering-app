const express = require('express');
const { requireManager } = require('../lib/auth');
const { getSettings, saveSettings, validate, makeSchedule, DAY_NAMES } = require('../lib/settings');
const { todayLocal, dayLabel } = require('../lib/dates');

function createSettingsRouter(db, options = {}) {
  const getToday = options.today || todayLocal;
  const router = express.Router();

  // The settings, plus the item categories (for choosing which can be moved between deliveries).
  router.get('/', (req, res) => {
    const categories = db.prepare('SELECT DISTINCT category FROM items WHERE active = 1 ORDER BY category').all().map(r => r.category);
    res.json({ ...getSettings(db), categories, dayNames: DAY_NAMES });
  });

  router.put('/', requireManager, (req, res) => {
    const patch = req.body || {};
    const clean = validate(patch);
    // An order already placed for a day that stops being a delivery day would drop out of the plan.
    if (clean.deliverySchedule) {
      const schedule = makeSchedule(clean.deliverySchedule);
      const stranded = db.prepare('SELECT delivery_date FROM order_confirmations WHERE delivery_date >= ? ORDER BY delivery_date').all(getToday())
        .map(r => r.delivery_date)
        .filter(d => schedule.cover[new Date(d + 'T00:00:00Z').getUTCDay()] === undefined);
      if (stranded.length) {
        return res.status(400).json({
          error: `There's a confirmed order for ${stranded.map(dayLabel).join(', ')}, which wouldn't be a delivery day any more. `
            + 'Unconfirm it on the Order plan first, or keep that day.',
        });
      }
    }
    res.json(saveSettings(db, clean));
  });

  return router;
}

module.exports = { createSettingsRouter };
