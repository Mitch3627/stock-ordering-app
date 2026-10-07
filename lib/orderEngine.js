// A tolerance so floating-point noise (17.1 - 15.1 = 2.0000000000000018) can't round an order up a whole case.
const EPS = 1e-9;
const ceilE = (x) => Math.ceil(x - EPS);
const floorE = (x) => Math.floor(x + EPS);
const round = (n, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;
const DAY_MS = 86400000;

// The supplier orders some items in packs of several app order units (Hashbrowns: 2.5 KG a pack, ordered in KG here).
// Such items are ordered in whole packs. Catch-weight differences of a couple of percent are ignored.
function packMultiple(item) {
  if (!(item.supplier_order_pack > 0) || !(item.items_per_order_unit > 0)) return null;
  const m = item.supplier_order_pack / item.items_per_order_unit;
  return m >= 1.05 ? m : null;
}

// fixedOrders: { 'YYYY-MM-DD': { itemId: qty } } - deliveries whose order has been placed. Their quantities are
// used as-is (an item with no line orders none), and later deliveries are planned on top of that stock.
// Each item also gets an `explain` entry per delivery describing how its quantity was worked out.
function computeDeliveryPlan({ items, onHand, deliveries, salesForDay, expiryLoss = {}, fixedOrders = {} }) {
  const plan = {};

  const usageOn = (item, day) => item.usage_per_100_sales * (salesForDay(day) / 100);
  const projectedUsage = (item, coverDays) => coverDays.reduce((sum, d) => sum + usageOn(item, d), 0);
  // Usage over `days` days starting on dateStr; a fractional last day counts pro rata.
  function usageOverDays(item, dateStr, days) {
    let total = 0;
    let t = new Date(dateStr + 'T00:00:00Z').getTime();
    for (let left = days; left > EPS; left -= 1, t += DAY_MS) {
      total += Math.min(1, left) * usageOn(item, new Date(t).toISOString().slice(0, 10));
    }
    return total;
  }

  for (const item of items) {
    // Physical stock can't be negative: a negative ledger balance (drift) must not inflate orders past max_boxes.
    let runningOnHand = Math.max(0, onHand[item.id] || 0);
    const qtys = [];
    const stockAfter = [];
    const buffers = [];
    const explain = [];
    // How long a delivery stays usable: the set shelf life, or for use-by tracked items one learnt from deliveries.
    const life = item.shelf_life_days ?? item.planning_shelf_life ?? null;
    const caseSize = item.case_multiple != null ? item.case_multiple : packMultiple(item);

    for (let i = 0; i < deliveries.length; i++) {
      const delivery = deliveries[i];
      // Stock that will pass its use-by date unused before this delivery is effectively extra usage.
      const loss = (expiryLoss[item.id] && expiryLoss[item.id][i]) || 0;
      runningOnHand = Math.max(0, runningOnHand - loss);
      const projUsage = projectedUsage(item, delivery.coverDays);

      const buffer = item.buffer_value;
      const target = projUsage + buffer;
      const fixed = fixedOrders[delivery.date];
      const step = {
        before: round(runningOnHand), expiryLoss: round(loss), usage: round(projUsage), buffer,
        target: round(target), need: null, limits: [], fixed: !!fixed,
      };
      // What the plan works out from the stock expected when this delivery arrives. A confirmed order keeps its
      // own quantities, but the suggestion is still worked out for it so the two can be compared.
      const suggest = (limits) => {
        let qty = Math.max(0, ceilE(target - runningOnHand));
        const need = qty;

        if (life != null) {
          const usable = usageOverDays(item, delivery.date, life);
          let shelfCap = floorE(usable - runningOnHand);
          // The ceiling only trims what would go out of date: it never cuts below what the days until the next
          // delivery need, and never zeroes an order when nothing usable is on hand (low-usage items can round
          // the ceiling below 1 whole order unit otherwise).
          shelfCap = Math.max(shelfCap, ceilE(projUsage - runningOnHand));
          if (runningOnHand <= 0 && shelfCap < 1) shelfCap = 1;
          if (qty > Math.max(0, shelfCap)) limits.push({ kind: 'shelf', days: round(life, 1), usable: round(usable), cap: Math.max(0, shelfCap) });
          qty = Math.max(0, Math.min(qty, shelfCap));
        }

        if (item.max_boxes != null) {
          const cap = floorE(item.max_boxes - runningOnHand);
          if (qty > Math.max(0, cap)) limits.push({ kind: 'max', max: item.max_boxes, cap: Math.max(0, cap) });
          qty = Math.max(0, Math.min(qty, cap));
        }

        if (caseSize != null && qty > 0) {
          let rounded = ceilE(qty / caseSize) * caseSize;
          if (item.max_boxes != null) {
            const fitCap = floorE((item.max_boxes - runningOnHand) / caseSize) * caseSize;
            if (fitCap === 0 && caseSize > item.max_boxes) {
              // A real stockout is worse than exceeding max_boxes by one case - this only fires when case_multiple > max_boxes, a store configuration Aaron would want to know about anyway.
              rounded = caseSize;
            } else {
              rounded = Math.min(rounded, Math.max(fitCap, 0));
            }
          }
          rounded = round(rounded, 6);
          if (rounded !== qty) limits.push({ kind: 'case', size: round(caseSize), from: qty, to: rounded });
          qty = rounded;
        }
        return { need, order: qty };
      };

      let orderQty;
      if (fixed) {
        orderQty = fixed[item.id] || 0;
        const limits = [];
        step.suggested = { ...suggest(limits), limits };
      } else {
        const s = suggest(step.limits);
        step.need = s.need;
        orderQty = s.order;
      }

      qtys.push(orderQty);
      buffers.push(buffer);
      stockAfter.push(Math.round((runningOnHand + orderQty) * 100) / 100);
      step.order = orderQty;
      step.after = round(runningOnHand + orderQty);
      explain.push(step);
      // Demand that can't be met is lost, not owed to the next delivery.
      runningOnHand = Math.max(0, runningOnHand + orderQty - projUsage);
    }

    plan[item.id] = { qtys, stockAfter, buffers, explain };
  }

  return plan;
}

module.exports = { computeDeliveryPlan, packMultiple };
