const { computeDecay } = require('../lib/usageDecay');
const { applyEventWithConsumption } = require('./ledger');

function applyDailyDecay(db, { date, actualSales, note = 'Daily usage decay from real sales' }) {
  const items = db.prepare('SELECT * FROM items WHERE active = 1').all();
  const decay = computeDecay(items, actualSales);

  const run = db.transaction(() => {
    for (const [itemId, qty] of Object.entries(decay)) {
      applyEventWithConsumption(db, {
        itemId: Number(itemId),
        type: 'usage_decay',
        qtyDelta: -qty,
        occurredAt: date,
        note,
      });
    }
  });
  run();
}

module.exports = { applyDailyDecay };
