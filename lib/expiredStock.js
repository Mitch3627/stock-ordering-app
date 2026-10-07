// Stock that is past its use-by date but still in inventory. Nothing removes it automatically:
// it stays (and keeps being used oldest-first) until someone logs it as out-of-date waste.
// A batch is still fine on its use-by date and counts as expired from the day after.
function expiredStock(db, today) {
  return db.prepare(`
    SELECT batches.item_id, items.name AS item_name, items.unit_label, items.supplier_unit, items.items_per_order_unit,
           ROUND(SUM(batches.qty_remaining), 4) AS qty, MIN(batches.use_by_date) AS oldest_use_by
    FROM batches JOIN items ON items.id = batches.item_id
    WHERE batches.qty_remaining > 0 AND batches.use_by_date < ?
    GROUP BY batches.item_id
    ORDER BY oldest_use_by ASC
  `).all(today);
}

module.exports = { expiredStock };
