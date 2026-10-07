function convertToOrderUnits(qty, unit, item) {
  if (unit === 'order') return qty;
  if (unit === 'native') {
    if (!(item.items_per_order_unit > 0)) {
      throw new Error('items_per_order_unit must be a positive number for native-unit conversion');
    }
    return qty / item.items_per_order_unit;
  }
  throw new Error(`Unknown unit "${unit}" - expected "order" or "native"`);
}

module.exports = { convertToOrderUnits };
