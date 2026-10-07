const express = require('express');
const { requireManager } = require('../lib/auth');
const { convertToOrderUnits } = require('../lib/unitConversion');
const { applyEventWithConsumption, getOnHand, getOnHandAsOf } = require('../ledger/ledger');
const { badRequest, isDate, requireQty, round6 } = require('../lib/validate');
const { currentUserId } = require('../lib/context');
const { todayLocal } = require('../lib/dates');

// Each line is compared with the stock the app expected at the end of the count date - not with stock now -
// so a count saved a day or two late doesn't wipe out deliveries, waste or sales logged after it.
function computeVarianceLines(db, lines, countedAt) {
  const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
  return lines.map(line => {
    const item = getItem.get(Number(line.itemId));
    if (!item) throw badRequest(`There is no item with id ${line.itemId}`);
    const countedQty = requireQty(line.countedQty, `The count for ${item.name}`, { allowZero: true });
    if (!['order', 'native'].includes(line.unit)) throw badRequest('unit must be "order" or "native"');
    const convertedQty = round6(convertToOrderUnits(countedQty, line.unit, item));
    const now = getOnHand(db, item.id);
    const expectedQty = countedAt ? getOnHandAsOf(db, item.id, countedAt) : round6(now);
    return {
      itemId: item.id,
      countedQty,
      unit: line.unit,
      convertedQty,
      expectedQty,
      variance: round6(convertedQty - expectedQty),
      // stock logged for days after the count date, which stays on top of the counted figure
      laterChange: round6(now - expectedQty),
    };
  });
}

function createCountsRouter(db, options = {}) {
  const getToday = options.today || todayLocal;
  const router = express.Router();

  router.post('/preview', (req, res) => {
    const { lines, countedAt } = req.body;
    if (!Array.isArray(lines)) {
      return res.status(400).json({ error: 'lines must be an array' });
    }
    if (countedAt != null && !isDate(countedAt)) return res.status(400).json({ error: 'countedAt must be a date (YYYY-MM-DD)' });
    res.json(computeVarianceLines(db, lines, countedAt || null));
  });

  router.post('/', requireManager, (req, res) => {
    const { countedAt, lines } = req.body;
    if (!isDate(countedAt)) return res.status(400).json({ error: 'countedAt must be a date (YYYY-MM-DD)' });
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'a count needs at least one counted item' });
    }

    let countId;
    let variance;
    db.transaction(() => {
      variance = computeVarianceLines(db, lines, countedAt);
      countId = db.prepare("INSERT INTO counts (counted_at, created_by, created_at) VALUES (?, ?, datetime('now'))").run(countedAt, currentUserId()).lastInsertRowid;
      const insertLine = db.prepare(`
        INSERT INTO count_lines (count_id, item_id, counted_qty, unit_used, converted_qty, expected_qty, variance)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const v of variance) {
        insertLine.run(countId, v.itemId, v.countedQty, v.unit, v.convertedQty, v.expectedQty, v.variance);
        if (v.variance !== 0) {
          applyEventWithConsumption(db, {
            itemId: v.itemId, type: 'count_correction', qtyDelta: v.variance,
            occurredAt: countedAt, note: `Count correction (expected ${v.expectedQty}, counted ${v.convertedQty})`,
          });
        }
      }
      clearDraft(); // the shared count sheet starts empty again
    })();

    res.status(201).json({ id: countId, countedAt, lines: variance });
  });

  // ---- the count being entered: shared, so two people can split a count and see each other's figures ----
  const getMeta = (key) => { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; };
  const setMeta = (key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  function clearDraft() {
    db.prepare('DELETE FROM count_draft').run();
    db.prepare("DELETE FROM meta WHERE key IN ('count_draft_date', 'count_draft_started')").run();
  }

  router.get('/draft', (req, res) => {
    const rows = db.prepare(`
      SELECT d.item_id, d.value, d.updated_at, users.name AS updated_by_name
      FROM count_draft d LEFT JOIN users ON users.id = d.updated_by
    `).all();
    const latest = rows.reduce((a, r) => (!a || r.updated_at > a.updated_at ? r : a), null);
    res.json({
      countedAt: getMeta('count_draft_date'),
      startedOn: getMeta('count_draft_started'),
      entries: Object.fromEntries(rows.map(r => [r.item_id, r.value])),
      people: [...new Set(rows.map(r => r.updated_by_name).filter(Boolean))],
      lastChange: latest ? { at: latest.updated_at, by: latest.updated_by_name } : null,
    });
  });

  // Figures as typed, by item ('' clears one). Only the items sent change, so people counting different
  // sections never overwrite each other.
  router.put('/draft/items', (req, res) => {
    const entries = req.body && req.body.entries;
    if (!entries || typeof entries !== 'object') return res.status(400).json({ error: 'entries must be an object of item id -> value' });
    const upsert = db.prepare(`INSERT INTO count_draft (item_id, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(item_id) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    const remove = db.prepare('DELETE FROM count_draft WHERE item_id = ?');
    for (const [id, value] of Object.entries(entries)) {
      if (value !== '' && !(Number.isFinite(Number(value)) && Number(value) >= 0)) return res.status(400).json({ error: `item ${id}: enter a number of 0 or more` });
      if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(Number(id))) return res.status(400).json({ error: `unknown item ${id}` });
    }
    db.transaction(() => {
      for (const [id, value] of Object.entries(entries)) {
        if (value === '') remove.run(Number(id)); else upsert.run(Number(id), String(value), currentUserId());
      }
      if (!getMeta('count_draft_started')) setMeta('count_draft_started', getToday());
    })();
    res.json({ ok: true });
  });

  router.put('/draft', (req, res) => {
    const { countedAt } = req.body || {};
    if (!isDate(countedAt)) return res.status(400).json({ error: 'countedAt must be a date (YYYY-MM-DD)' });
    setMeta('count_draft_date', countedAt);
    res.json({ ok: true });
  });

  // Start again with an empty count sheet.
  router.delete('/draft', requireManager, (req, res) => {
    clearDraft();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createCountsRouter };
