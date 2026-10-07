const express = require('express');

// Usage between two counts: opening count + deliveries in the period - closing count. Logged waste is part of
// that, but the stock ledger already takes logged waste off separately - so the suggested rate per £100 of sales
// is worked out from usage minus waste, or waste would be counted twice.
// Deliveries that arrived on the opening count's date are already in that count, so the period is (from, to].
function createUsageRouter(db) {
  const router = express.Router();

  router.get('/counts', (req, res) => {
    res.json(db.prepare('SELECT id, counted_at FROM counts ORDER BY counted_at DESC, id DESC').all());
  });

  router.get('/', (req, res) => {
    const from = db.prepare('SELECT * FROM counts WHERE id = ?').get(Number(req.query.from));
    const to = db.prepare('SELECT * FROM counts WHERE id = ?').get(Number(req.query.to));
    if (!from || !to || from.counted_at >= to.counted_at) {
      return res.status(400).json({ error: 'from and to must be two counts, from earlier than to' });
    }

    const days = Math.round((new Date(to.counted_at + 'T00:00:00Z') - new Date(from.counted_at + 'T00:00:00Z')) / 86400000);
    const salesRow = db.prepare(`
      SELECT COALESCE(SUM(actual_sales), 0) AS total, COUNT(*) AS n FROM sales_forecast
      WHERE date > ? AND date <= ? AND actual_sales IS NOT NULL
    `).get(from.counted_at, to.counted_at);

    const delivered = db.prepare(`
      SELECT dl.item_id, SUM(dl.qty) AS qty FROM delivery_lines dl
      JOIN deliveries d ON d.id = dl.delivery_id
      WHERE COALESCE(d.arrived_at, d.delivered_at) > ? AND COALESCE(d.arrived_at, d.delivered_at) <= ?
      GROUP BY dl.item_id
    `).all(from.counted_at, to.counted_at);
    const deliveredBy = Object.fromEntries(delivered.map(r => [r.item_id, r.qty]));
    const wasted = db.prepare(`
      SELECT item_id, SUM(qty) AS qty FROM waste_entries
      WHERE deleted_at IS NULL AND occurred_at > ? AND occurred_at <= ? GROUP BY item_id
    `).all(from.counted_at, to.counted_at);
    const wastedBy = Object.fromEntries(wasted.map(r => [r.item_id, r.qty]));

    const openLines = db.prepare('SELECT item_id, converted_qty FROM count_lines WHERE count_id = ?').all(from.id);
    const closeBy = Object.fromEntries(db.prepare('SELECT item_id, converted_qty FROM count_lines WHERE count_id = ?').all(to.id).map(r => [r.item_id, r.converted_qty]));
    const getItem = db.prepare('SELECT id, name, category, unit_label, usage_per_100_sales FROM items WHERE id = ?');
    const r3 = (n) => Math.round(n * 1000) / 1000;

    const items = [];
    for (const o of openLines) {
      if (closeBy[o.item_id] === undefined) continue;
      const item = getItem.get(o.item_id);
      const del = deliveredBy[o.item_id] || 0;
      const waste = wastedBy[o.item_id] || 0;
      const used = r3(o.converted_qty + del - closeBy[o.item_id]);
      const salesUsed = r3(used - waste);
      items.push({
        itemId: item.id, name: item.name, category: item.category, unit_label: item.unit_label,
        opening: o.converted_qty, delivered: del, closing: closeBy[o.item_id], used, wasted: r3(waste), salesUsed,
        current: item.usage_per_100_sales,
        suggested: salesRow.total > 0 ? Math.max(0, salesUsed) / (salesRow.total / 100) : null,
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ from: from.counted_at, to: to.counted_at, days, salesDays: salesRow.n, sales: salesRow.total, items });
  });

  return router;
}

module.exports = { createUsageRouter };
