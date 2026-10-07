// The baseline is the first count logged after meta.baseline_after_count_id was recorded.
// Until it exists the store is treated as brand new: nothing should deduct from stock or be asked for.
function baselineAfterId(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'baseline_after_count_id'").get();
  return row ? Number(row.value) : 0;
}

// Date of the most recent count taken since the baseline was reset, or null if none yet.
// Usage on or before this date is already reflected in that count.
function latestCountDate(db) {
  return db.prepare('SELECT MAX(counted_at) AS d FROM counts WHERE id > ?').get(baselineAfterId(db)).d || null;
}

function baselineDone(db) {
  return latestCountDate(db) !== null;
}

module.exports = { baselineAfterId, latestCountDate, baselineDone };
