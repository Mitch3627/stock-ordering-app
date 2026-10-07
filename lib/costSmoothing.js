function deliveryCost(plan, items, index) {
  let total = 0;
  for (const item of items) {
    const qty = plan[item.id].qtys[index];
    const price = item.price_per_unit || 0;
    total += qty * price;
  }
  return total;
}

function smoothDeliveryCosts({ plan, items, deliveries, targetCost, flexibleCategories, lockedIndexes = [] }) {
  // Deep-copy the plan so callers' original data is untouched.
  // Use Object.keys(plan) to ensure every item in plan is copied, not just those in items array.
  const result = {};
  for (const itemId of Object.keys(plan)) {
    result[itemId] = {
      qtys: [...plan[itemId].qtys],
      stockAfter: [...plan[itemId].stockAfter],
      buffers: [...plan[itemId].buffers],
    };
  }

  const moves = [];

  for (let i = 1; i < deliveries.length; i++) {
    const fromIndex = i;
    const toIndex = i - 1;
    if (lockedIndexes.includes(fromIndex) || lockedIndexes.includes(toIndex)) continue; // placed orders never move
    let fromCost = deliveryCost(result, items, fromIndex);
    let toCost = deliveryCost(result, items, toIndex);
    if (fromCost <= targetCost || toCost >= targetCost) continue;

    // Candidate items: flexible category, not perishable (no shelf life, not use-by tracked), has a nonzero order
    // on the "from" delivery.
    const candidates = items
      .filter(it => flexibleCategories.includes(it.category))
      .filter(it => it.shelf_life_days == null && !it.track_use_by)
      .filter(it => result[it.id].qtys[fromIndex] > 0)
      .sort((a, b) => (b.price_per_unit || 0) - (a.price_per_unit || 0));

    for (const candidate of candidates) {
      const qty = result[candidate.id].qtys[fromIndex];
      const price = candidate.price_per_unit || 0;
      const newFromCost = fromCost - qty * price;
      const newToCost = toCost + qty * price;
      const currentMax = Math.max(fromCost, toCost);
      const newMax = Math.max(newFromCost, newToCost);
      if (newMax >= currentMax) continue; // must actually improve the worse of the two

      // Move it: destination gets the qty added on toIndex, source becomes 0 on fromIndex.
      // Stock after each delivery from toIndex up to fromIndex-1 rises by qty; at fromIndex it is unchanged,
      // because the stock that no longer arrives there arrived earlier instead (the caller re-simulates the
      // final plan for exact figures).
      let ok = true;
      for (let j = toIndex; j < fromIndex; j++) {
        if (result[candidate.id].stockAfter[j] + qty < 0) { ok = false; break; }
      }
      // Moving the order earlier stacks it on top of stock already in store; respect the max in store.
      if (candidate.max_boxes != null) {
        for (let j = toIndex; j < fromIndex; j++) {
          if (result[candidate.id].stockAfter[j] + qty > candidate.max_boxes) { ok = false; break; }
        }
      }
      if (!ok) continue;

      result[candidate.id].qtys[toIndex] += qty;
      result[candidate.id].qtys[fromIndex] = 0;
      for (let j = toIndex; j < fromIndex; j++) {
        result[candidate.id].stockAfter[j] += qty;
      }

      moves.push({ itemId: candidate.id, fromIndex, toIndex });
      fromCost = newFromCost;
      toCost = newToCost;
      if (fromCost <= targetCost) break;
    }
  }

  return { plan: result, moves };
}

module.exports = { smoothDeliveryCosts, deliveryCost };
