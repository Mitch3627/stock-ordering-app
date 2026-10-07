const { consumeFromBatches } = require('../lib/batchConsumption');
const { currentUserId } = require('../lib/context');

const VALID_TYPES = new Set(['delivery', 'waste', 'usage_decay', 'count_correction']);
const EPS = 1e-6;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Prepared statements are cached per database connection.
const cache = new WeakMap();
function stmt(db, sql) {
  let byDb = cache.get(db);
  if (!byDb) cache.set(db, (byDb = new Map()));
  let s = byDb.get(sql);
  if (!s) byDb.set(sql, (s = db.prepare(sql)));
  return s;
}

const BATCHES_OLDEST_FIRST = `SELECT * FROM batches WHERE item_id = ? AND qty_remaining > 0
  ORDER BY use_by_date ASC, received_at ASC, id ASC`;

function getOnHand(db, itemId) {
  const row = stmt(db, 'SELECT on_hand_qty FROM inventory_ledger WHERE item_id = ?').get(itemId);
  return row ? row.on_hand_qty : 0;
}

function getAllOnHand(db) {
  const result = {};
  for (const row of stmt(db, 'SELECT item_id, on_hand_qty FROM inventory_ledger').all()) result[row.item_id] = row.on_hand_qty;
  return result;
}

// Stock on hand at the end of a given day: today's figure minus everything logged for later days.
function getOnHandAsOf(db, itemId, date) {
  const later = stmt(db, 'SELECT COALESCE(SUM(qty_delta), 0) AS q FROM inventory_events WHERE item_id = ? AND occurred_at > ?').get(itemId, date).q;
  return round6(getOnHand(db, itemId) - later);
}

function setBatchQty(db, batchId, qty) {
  stmt(db, 'UPDATE batches SET qty_remaining = ? WHERE id = ?').run(round6(qty), batchId);
}

// Dated stock can never be more than the stock on hand: trims the oldest batches until it isn't.
function reconcileBatches(db, itemId) {
  const batches = stmt(db, BATCHES_OLDEST_FIRST).all(itemId);
  if (batches.length === 0) return;
  let excess = round6(batches.reduce((s, b) => s + b.qty_remaining, 0) - Math.max(0, getOnHand(db, itemId)));
  for (const b of batches) {
    if (excess <= EPS) break;
    const take = Math.min(b.qty_remaining, excess);
    setBatchQty(db, b.id, b.qty_remaining - take);
    excess = round6(excess - take);
  }
}

// Records one stock movement and returns its event id. The ledger is the single source of truth for
// on-hand; this is the only place it changes.
function applyEvent(db, { itemId, type, qtyDelta, occurredAt, note, source, sourceId }) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Unknown event type "${type}"`);
  }
  if (!Number.isFinite(qtyDelta)) {
    throw new Error('qtyDelta must be a finite number');
  }
  const delta = round6(qtyDelta);
  let eventId;
  db.transaction(() => {
    eventId = stmt(db, `
      INSERT INTO inventory_events (item_id, type, qty_delta, occurred_at, note, source, source_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, type, delta, occurredAt, note || null, source || null, sourceId ?? null, currentUserId()).lastInsertRowid;
    stmt(db, `
      INSERT INTO inventory_ledger (item_id, on_hand_qty, last_updated)
      VALUES (?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        on_hand_qty = ROUND(on_hand_qty + excluded.on_hand_qty, 6),
        last_updated = excluded.last_updated
    `).run(itemId, delta, occurredAt);
    reconcileBatches(db, itemId);
  })();
  return Number(eventId);
}

// Stock leaving: comes off the oldest-dated batches first, then off undated stock. Batches and the ledger
// move by exactly the same amount, and which batches it came from is recorded so it can be undone.
function applyEventWithConsumption(db, { itemId, type, qtyDelta, occurredAt, note, source, sourceId }) {
  if (!(qtyDelta < 0)) {
    return applyEvent(db, { itemId, type, qtyDelta, occurredAt, note, source, sourceId });
  }
  const qty = round6(-qtyDelta);
  let eventId;
  db.transaction(() => {
    const { consumptions } = consumeFromBatches(stmt(db, BATCHES_OLDEST_FIRST).all(itemId), qty);
    for (const c of consumptions) setBatchQty(db, c.batchId, c.newRemaining);
    eventId = applyEvent(db, { itemId, type, qtyDelta: -qty, occurredAt, note, source, sourceId });
    const record = stmt(db, 'INSERT INTO batch_consumptions (event_id, batch_id, qty) VALUES (?, ?, ?)');
    for (const c of consumptions) record.run(eventId, c.batchId, c.amountConsumed);
  })();
  return eventId;
}

// Stock coming back (an undo): on-hand goes up by qty, and the batches that the given earlier events took it
// from get it back, most recently taken first. Whatever those events didn't take from a batch comes back undated.
function returnStock(db, { itemId, type, qty, occurredAt, note, source, sourceId, fromEventIds = [] }) {
  let eventId;
  db.transaction(() => {
    eventId = applyEvent(db, { itemId, type, qtyDelta: round6(qty), occurredAt, note, source, sourceId });
    if (fromEventIds.length === 0) return;
    const taken = db.prepare(`
      SELECT batch_id, SUM(qty) AS net, MAX(id) AS last FROM batch_consumptions
      WHERE event_id IN (${fromEventIds.map(() => '?').join(',')})
      GROUP BY batch_id HAVING net > 1e-9 ORDER BY last DESC
    `).all(...fromEventIds);
    const record = stmt(db, 'INSERT INTO batch_consumptions (event_id, batch_id, qty) VALUES (?, ?, ?)');
    let left = round6(qty);
    for (const t of taken) {
      if (left <= EPS) break;
      const batch = stmt(db, 'SELECT qty_remaining FROM batches WHERE id = ?').get(t.batch_id);
      if (!batch) continue;
      const back = round6(Math.min(t.net, left));
      setBatchQty(db, t.batch_id, batch.qty_remaining + back);
      record.run(eventId, t.batch_id, -back);
      left = round6(left - back);
    }
  })();
  return eventId;
}

// Takes stock out of dated batches only (oldest first), leaving on-hand alone. Used when stock that was thought
// to come from one batch must really have come from the others (e.g. a delivery turns out to be smaller).
function takeFromBatches(db, itemId, qty, { excludeBatchIds = [] } = {}) {
  let left = round6(qty);
  for (const b of stmt(db, BATCHES_OLDEST_FIRST).all(itemId)) {
    if (left <= EPS) break;
    if (excludeBatchIds.includes(b.id)) continue;
    const take = Math.min(b.qty_remaining, left);
    setBatchQty(db, b.id, b.qty_remaining - take);
    left = round6(left - take);
  }
  return round6(qty - left);
}

module.exports = {
  applyEvent, applyEventWithConsumption, returnStock, takeFromBatches, reconcileBatches,
  getOnHand, getAllOnHand, getOnHandAsOf, setBatchQty,
};
