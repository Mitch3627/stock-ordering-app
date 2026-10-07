const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Takes qtyToConsume from the batches in the order given (oldest use-by first). Quantities are kept to
// 6 decimal places and the same figures are used for the batch and the stock ledger, so the two never drift.
function consumeFromBatches(batches, qtyToConsume) {
  const consumptions = [];
  let remaining = round6(qtyToConsume);

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = round6(Math.min(batch.qty_remaining, remaining));
    if (take > 0) {
      consumptions.push({
        batchId: batch.id,
        amountConsumed: take,
        newRemaining: round6(batch.qty_remaining - take),
      });
      remaining = round6(remaining - take);
    }
  }

  return { consumptions, unconsumed: remaining };
}

module.exports = { consumeFromBatches };
