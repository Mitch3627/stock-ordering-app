const express = require('express');
const { requireManager } = require('../lib/auth');
const { applyEvent, reconcileBatches, takeFromBatches, setBatchQty } = require('../ledger/ledger');
const { latestCountDate } = require('../lib/baseline');
const { addDays, daysBetween, dayLabel, todayLocal } = require('../lib/dates');
const { currentUserId } = require('../lib/context');
const { badRequest, isDate, requireQty, round6 } = require('../lib/validate');

const { deliverySchedule } = require('../lib/settings');

const EPS = 1e-6;

// A delivery has two dates: the slot it fills (delivered_at: one of the store's delivery days) and, when different, the day it
// actually arrived (arrived_at). Stock movements and batches use the arrival day.
const arrivalOf = (delivery) => delivery.arrived_at || delivery.delivered_at;

function createDeliveriesRouter(db, options = {}) {
  const getToday = options.today || todayLocal;
  const router = express.Router();
  const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
  const getDelivery = db.prepare('SELECT * FROM deliveries WHERE id = ?');
  const getLine = db.prepare('SELECT * FROM delivery_lines WHERE delivery_id = ? AND item_id = ?');
  const insertBatch = db.prepare(`
    INSERT INTO batches (item_id, delivery_id, received_at, shelf_life_days, use_by_date, qty_remaining)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Once a count has been taken on or after the day a delivery arrived, that count already reflects the real
  // stock, so correcting the delivery afterwards fixes the record without moving stock again.
  function coveredByCount(delivery) {
    const counted = latestCountDate(db);
    return !!counted && counted >= arrivalOf(delivery);
  }

  // Validates posted lines and groups them by item: one delivery line per item, one batch per use-by date given
  // (the same item can arrive with two use-by dates).
  function groupLines(lines) {
    if (!Array.isArray(lines) || lines.length === 0) throw badRequest('add at least one line');
    const byItem = new Map();
    for (const l of lines) {
      const item = getItem.get(Number(l.itemId));
      if (!item) throw badRequest(`There is no item with id ${l.itemId}`);
      const qty = requireQty(l.qty, `The quantity for ${item.name}`);
      if (l.useByDate != null && l.useByDate !== '' && !isDate(l.useByDate)) throw badRequest('useByDate must be YYYY-MM-DD');
      const group = byItem.get(item.id) || { item, qty: 0, parts: [] };
      group.qty = round6(group.qty + qty);
      group.parts.push({ qty, useByDate: l.useByDate || null });
      byItem.set(item.id, group);
    }
    return [...byItem.values()];
  }

  // Dated batches for a line's parts. A part without a date gets the item's standard shelf life if it has one;
  // otherwise (e.g. a use-by item logged without its date) it stays undated until the use-by pop-up asks for it.
  function addBatches(deliveryId, receivedAt, group) {
    for (const p of group.parts) {
      if (p.useByDate) {
        insertBatch.run(group.item.id, deliveryId, receivedAt, daysBetween(receivedAt, p.useByDate), p.useByDate, p.qty);
      } else {
        const shelfLife = group.item.shelf_life_days;
        if (shelfLife != null) insertBatch.run(group.item.id, deliveryId, receivedAt, shelfLife, addDays(receivedAt, shelfLife), p.qty);
      }
    }
    reconcileBatches(db, group.item.id);
  }

  // Adds items to an existing delivery: a line already there goes up, otherwise a new line (not on the order).
  function addToDelivery(delivery, group, note) {
    const existing = getLine.get(delivery.id, group.item.id);
    if (existing) {
      db.prepare('UPDATE delivery_lines SET qty = ? WHERE id = ?').run(round6(existing.qty + group.qty), existing.id);
    } else {
      db.prepare('INSERT INTO delivery_lines (delivery_id, item_id, qty, ordered_qty) VALUES (?, ?, ?, NULL)').run(delivery.id, group.item.id, group.qty);
    }
    const stockChanged = !coveredByCount(delivery);
    if (stockChanged) {
      applyEvent(db, {
        itemId: group.item.id, type: 'delivery', qtyDelta: group.qty, occurredAt: arrivalOf(delivery), note,
        source: 'delivery', sourceId: delivery.id,
      });
    }
    addBatches(delivery.id, arrivalOf(delivery), group);
    return stockChanged;
  }

  // Takes `amount` off a delivery line's stock. The line's own batches give it up first, latest use-by first (the
  // part least likely to have been used yet); whatever they no longer hold was used already - and as it can't have
  // come from this delivery after all, it must have come from the other dated stock, oldest first.
  function reduceLine(delivery, line, amount, note) {
    const own = db.prepare('SELECT * FROM batches WHERE delivery_id = ? AND item_id = ? ORDER BY use_by_date DESC, id DESC').all(delivery.id, line.item_id);
    let left = round6(amount);
    for (const b of own) {
      if (left <= EPS) break;
      const take = Math.min(b.qty_remaining, left);
      if (take > 0) {
        setBatchQty(db, b.id, b.qty_remaining - take);
        left = round6(left - take);
      }
    }
    if (left > EPS && own.length > 0) takeFromBatches(db, line.item_id, left, { excludeBatchIds: own.map(b => b.id) });
    applyEvent(db, {
      itemId: line.item_id, type: 'count_correction', qtyDelta: -amount, occurredAt: arrivalOf(delivery), note,
      source: 'delivery', sourceId: delivery.id,
    });
  }

  // Puts `amount` more on a line: its latest-dated batch grows with it (if it has one).
  function increaseLine(delivery, line, amount, note) {
    applyEvent(db, {
      itemId: line.item_id, type: 'count_correction', qtyDelta: amount, occurredAt: arrivalOf(delivery), note,
      source: 'delivery', sourceId: delivery.id,
    });
    const latest = db.prepare('SELECT * FROM batches WHERE delivery_id = ? AND item_id = ? ORDER BY use_by_date DESC, id DESC LIMIT 1').get(delivery.id, line.item_id);
    if (latest) setBatchQty(db, latest.id, latest.qty_remaining + amount);
  }

  // Recent and upcoming delivery slots, and which one is most likely being received now.
  router.get('/slots', (req, res) => {
    const today = getToday();
    const logged = {};
    for (const d of db.prepare('SELECT id, delivered_at FROM deliveries').all()) logged[d.delivered_at] = logged[d.delivered_at] || d.id;
    const skipped = new Set(db.prepare('SELECT date FROM skipped_deliveries').all().map(r => r.date));
    const confirmed = {};
    for (const r of db.prepare(`SELECT c.delivery_date, COUNT(l.item_id) AS n FROM order_confirmations c
      LEFT JOIN confirmed_order_lines l ON l.delivery_date = c.delivery_date GROUP BY c.delivery_date`).all()) {
      confirmed[r.delivery_date] = r.n;
    }
    const slots = [];
    const schedule = deliverySchedule(db);
    for (let d = addDays(today, -7); d <= addDays(today, 7); d = addDays(d, 1)) {
      if (schedule.cover[new Date(d + 'T00:00:00Z').getUTCDay()] === undefined) continue;
      slots.push({ date: d, label: dayLabel(d), loggedId: logged[d] || null, skipped: skipped.has(d), confirmedLines: confirmed[d] ?? null });
    }
    // A missed slot is only a likely candidate within the last few days and after the latest count (a count
    // already covers anything before it).
    const counted = latestCountDate(db) || '';
    const recent = addDays(today, -4);
    const open = slots.filter(s => s.date <= today && s.date >= recent && s.date > counted && !s.loggedId && !s.skipped);
    const next = slots.find(s => s.date > today && !s.loggedId && !s.skipped);
    res.json({ today, slots, suggested: open.length ? open[open.length - 1].date : (next ? next.date : null) });
  });

  // Correct an already-logged line's received quantity.
  router.put('/:id/lines/:itemId', requireManager, (req, res) => {
    const deliveryId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const qty = requireQty(req.body.qty, 'qty', { allowZero: true });
    const line = getLine.get(deliveryId, itemId);
    if (!line) return res.status(404).json({ error: 'not found' });
    const delivery = getDelivery.get(deliveryId);
    const delta = round6(qty - line.qty);
    const stockChanged = delta !== 0 && !coveredByCount(delivery);
    db.transaction(() => {
      db.prepare('UPDATE delivery_lines SET qty = ? WHERE id = ?').run(qty, line.id);
      if (!stockChanged) return;
      const note = `Delivery of ${delivery.delivered_at} corrected: ${line.qty} -> ${qty}`;
      if (delta < 0) reduceLine(delivery, line, -delta, note);
      else increaseLine(delivery, line, delta, note);
    })();
    res.json({ deliveryId, itemId, qty, stockChanged });
  });

  // Remove a line. One that was actually ordered keeps a zero-qty record (a confirmed shortage);
  // one added after the fact with no order behind it is deleted outright.
  router.delete('/:id/lines/:itemId', requireManager, (req, res) => {
    const deliveryId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const line = getLine.get(deliveryId, itemId);
    if (!line) return res.status(404).json({ error: 'not found' });
    const delivery = getDelivery.get(deliveryId);
    const stockChanged = line.qty > 0 && !coveredByCount(delivery);
    db.transaction(() => {
      if (stockChanged) reduceLine(delivery, line, line.qty, `Removed from the ${delivery.delivered_at} delivery (was ${line.qty})`);
      if (line.ordered_qty != null) {
        db.prepare('UPDATE delivery_lines SET qty = 0 WHERE id = ?').run(line.id);
      } else {
        db.prepare('DELETE FROM delivery_lines WHERE id = ?').run(line.id);
      }
    })();
    res.json({ deliveryId, itemId, stockChanged });
  });

  // Add an item that was missed off the original log (or more of one already on it).
  router.post('/:id/lines', requireManager, (req, res) => {
    const delivery = getDelivery.get(Number(req.params.id));
    if (!delivery) return res.status(404).json({ error: 'not found' });
    const { itemId, qty, useByDate } = req.body;
    const [group] = groupLines([{ itemId, qty, useByDate }]);
    let stockChanged;
    db.transaction(() => {
      stockChanged = addToDelivery(delivery, group, `Added to the ${delivery.delivered_at} delivery after logging`);
    })();
    res.status(201).json({ deliveryId: delivery.id, itemId: group.item.id, qty: group.qty, stockChanged });
  });

  // Delete a whole delivery logged by mistake (e.g. twice). Its stock comes back off; if nothing else is logged
  // for that slot, its confirmed order is put back so the plan still expects it.
  router.delete('/:id', requireManager, (req, res) => {
    const delivery = getDelivery.get(Number(req.params.id));
    if (!delivery) return res.status(404).json({ error: 'not found' });
    const lines = db.prepare('SELECT * FROM delivery_lines WHERE delivery_id = ?').all(delivery.id);
    const stockChanged = !coveredByCount(delivery);
    let restoredOrder = false;
    db.transaction(() => {
      if (stockChanged) {
        for (const line of lines) if (line.qty > 0) reduceLine(delivery, line, line.qty, `Delivery of ${delivery.delivered_at} deleted`);
      }
      const others = db.prepare('SELECT 1 FROM deliveries WHERE delivered_at = ? AND id <> ?').get(delivery.delivered_at, delivery.id);
      const ordered = lines.filter(l => l.ordered_qty > 0);
      if (!others && ordered.length > 0) {
        db.prepare('INSERT OR IGNORE INTO order_confirmations (delivery_date) VALUES (?)').run(delivery.delivered_at);
        const put = db.prepare('INSERT OR REPLACE INTO confirmed_order_lines (delivery_date, item_id, qty) VALUES (?, ?, ?)');
        for (const l of ordered) put.run(delivery.delivered_at, l.item_id, l.ordered_qty);
        restoredOrder = true;
      }
      db.prepare('UPDATE batches SET delivery_id = NULL WHERE delivery_id = ?').run(delivery.id);
      db.prepare('DELETE FROM delivery_lines WHERE delivery_id = ?').run(delivery.id);
      db.prepare('DELETE FROM deliveries WHERE id = ?').run(delivery.id);
    })();
    res.json({ deleted: delivery.id, restoredOrder, stockChanged });
  });

  router.post('/', (req, res) => {
    const { deliveredAt, arrivedAt, note, lines, addToExisting } = req.body;
    if (!isDate(deliveredAt)) return res.status(400).json({ error: 'deliveredAt must be a date (YYYY-MM-DD)' });
    if (arrivedAt != null && arrivedAt !== '' && !isDate(arrivedAt)) return res.status(400).json({ error: 'arrivedAt must be a date (YYYY-MM-DD)' });
    const groups = groupLines(lines);
    const arrival = arrivedAt && arrivedAt !== deliveredAt ? arrivedAt : null;

    // The same delivery logged twice (a double click, or two people) would double its stock.
    const existing = db.prepare('SELECT * FROM deliveries WHERE delivered_at = ? ORDER BY id LIMIT 1').get(deliveredAt);
    if (existing && !addToExisting) {
      return res.status(409).json({ error: `A delivery for ${dayLabel(deliveredAt)} is already logged`, existingId: existing.id });
    }

    let deliveryId;
    // A delivery that arrived on or before the latest count is already in that count's figures: it is recorded
    // (lines, shortages, use-by dates) without adding its stock a second time.
    const stockChanged = !coveredByCount({ delivered_at: deliveredAt, arrived_at: arrival });
    db.transaction(() => {
      if (existing) {
        deliveryId = existing.id;
        for (const g of groups) addToDelivery(existing, g, note || `Added to the ${deliveredAt} delivery`);
        return;
      }
      deliveryId = Number(db.prepare(`INSERT INTO deliveries (delivered_at, arrived_at, note, created_at, created_by) VALUES (?, ?, ?, datetime('now'), ?)`)
        .run(deliveredAt, arrival, note || null, currentUserId()).lastInsertRowid);
      const receivedAt = arrival || deliveredAt;
      // Two parts to a delivery: what was expected (the confirmed order) and what actually arrived.
      const ordered = Object.fromEntries(
        db.prepare('SELECT item_id, qty FROM confirmed_order_lines WHERE delivery_date = ?').all(deliveredAt).map(r => [r.item_id, r.qty]));
      // the order for this slot has now arrived; its quantities are in the delivery being logged
      db.prepare('DELETE FROM order_confirmations WHERE delivery_date = ?').run(deliveredAt);
      const insertLine = db.prepare('INSERT INTO delivery_lines (delivery_id, item_id, qty, ordered_qty) VALUES (?, ?, ?, ?)');
      const received = new Set(groups.map(g => g.item.id));
      for (const [itemId, qty] of Object.entries(ordered)) {
        // ordered but nothing arrived: keep a zero line so the shortage is on record (no stock is added)
        if (!received.has(Number(itemId))) insertLine.run(deliveryId, Number(itemId), 0, qty);
      }
      for (const g of groups) {
        insertLine.run(deliveryId, g.item.id, g.qty, ordered[g.item.id] ?? null);
        if (stockChanged) {
          applyEvent(db, {
            itemId: g.item.id, type: 'delivery', qtyDelta: g.qty, occurredAt: receivedAt, note: note || null,
            source: 'delivery', sourceId: deliveryId,
          });
        }
        addBatches(deliveryId, receivedAt, g);
      }
    })();

    res.status(201).json({ id: deliveryId, deliveredAt, arrivedAt: arrival, note, lines, merged: !!existing, stockChanged });
  });

  // History, newest first. ?since=YYYY-MM-DD limits it to deliveries from that day on (the page shows the last
  // 60 days until 'Show older' is pressed, so it stays quick as the months go by).
  router.get('/', (req, res) => {
    const since = isDate(req.query.since) ? req.query.since : '0000-00-00';
    const deliveries = db.prepare(`SELECT deliveries.*, users.name AS created_by_name FROM deliveries
      LEFT JOIN users ON users.id = deliveries.created_by WHERE delivered_at >= ? ORDER BY delivered_at DESC, deliveries.id DESC`).all(since);
    const lines = db.prepare(`
      SELECT dl.*, items.name AS item_name, items.unit_label, items.supplier_unit, items.items_per_order_unit, items.track_use_by
      FROM delivery_lines dl JOIN items ON items.id = dl.item_id
      WHERE dl.delivery_id IN (SELECT id FROM deliveries WHERE delivered_at >= ?)
      ORDER BY items.name
    `).all(since);
    const batches = db.prepare(`
      SELECT id, delivery_id, item_id, use_by_date, qty_remaining FROM batches
      WHERE delivery_id IN (SELECT id FROM deliveries WHERE delivered_at >= ?) ORDER BY use_by_date, id
    `).all(since);
    const batchesOf = {};
    for (const b of batches) (batchesOf[`${b.delivery_id}:${b.item_id}`] = batchesOf[`${b.delivery_id}:${b.item_id}`] || []).push(b);
    const linesOf = {};
    for (const l of lines) {
      const own = batchesOf[`${l.delivery_id}:${l.item_id}`] || [];
      l.batches = own.map(b => ({ id: b.id, use_by_date: b.use_by_date, qty_remaining: b.qty_remaining }));
      l.use_by_date = own.length ? own[0].use_by_date : null;
      l.batch_id = own.length === 1 ? own[0].id : null;
      (linesOf[l.delivery_id] = linesOf[l.delivery_id] || []).push(l);
    }
    for (const d of deliveries) {
      d.lines = linesOf[d.id] || [];
      d.countedSince = coveredByCount(d);
    }
    res.json(deliveries);
  });

  return router;
}

module.exports = { createDeliveriesRouter };
