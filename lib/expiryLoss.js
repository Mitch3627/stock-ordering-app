// Projects how much of the batches currently on hand will pass their use-by date unused.
// Usage is run through batches oldest-first; a batch is lost at the start of the day AFTER
// its use-by date. Loss on a delivery's own date counts before that delivery, so the order
// arriving that morning has to cover it. Returns { bridge, perDelivery }:
//   bridge          - loss up to and including the first delivery date (apply to bridged on-hand)
//   perDelivery[i]  - loss after delivery i-1 up to and including delivery i's date (i >= 1)
const { addDays } = require('./dates');

const addDay = (dateStr) => addDays(dateStr, 1);

function computeExpiryLoss({ batches, dailyUsage, startDate, deliveryDates }) {
  const live = batches
    .map(b => ({ use_by_date: b.use_by_date, left: b.qty_remaining }))
    .sort((a, b) => a.use_by_date.localeCompare(b.use_by_date));
  const perDelivery = deliveryDates.map(() => 0);
  let bridge = 0;
  const lastDate = deliveryDates[deliveryDates.length - 1];

  for (let day = startDate; day <= lastDate; day = addDay(day)) {
    let lost = 0;
    for (const b of live) {
      if (b.left > 0 && b.use_by_date < day) { lost += b.left; b.left = 0; }
    }
    if (lost > 0) {
      if (day <= deliveryDates[0]) bridge += lost;
      else perDelivery[deliveryDates.findIndex(d => d >= day)] += lost;
    }
    let usage = dailyUsage(day);
    for (const b of live) {
      if (usage <= 0) break;
      const take = Math.min(b.left, usage);
      b.left -= take;
      usage -= take;
    }
  }
  return { bridge, perDelivery };
}

module.exports = { computeExpiryLoss };
