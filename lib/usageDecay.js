function computeDecay(items, actualSales) {
  const decay = {};
  for (const item of items) {
    const qty = item.usage_per_100_sales * (actualSales / 100);
    if (qty > 0) decay[item.id] = qty;
  }
  return decay;
}

module.exports = { computeDecay };
