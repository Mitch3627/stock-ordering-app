// Calendar-date helpers. Dates are 'YYYY-MM-DD' strings handled as UTC midnights.
const DAY_MS = 86400000;

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Math.floor(days));
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr + 'T00:00:00Z') - new Date(fromStr + 'T00:00:00Z')) / DAY_MS);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'Mon 21 Sep'
function dayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// Today's date in the UK - the app runs on UK time whatever the server's clock is set to (a hosted server is
// usually on UTC, which is still yesterday between midnight and 1am in summer).
const ukDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
function todayLocal(now = new Date()) { return ukDate.format(now); }

module.exports = { DAY_MS, addDays, daysBetween, dayLabel, todayLocal };
