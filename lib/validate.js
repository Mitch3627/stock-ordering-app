// Input checks shared by the API routes. Throwing badRequest() inside a handler (or inside a
// transaction, which rolls it back) ends the request with a 400 and a plain-English message.
function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function requireDate(value, label) {
  if (!isDate(value)) throw badRequest(`${label} must be a date (YYYY-MM-DD)`);
  return value;
}

function toNumber(value) {
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return value;
}

// A quantity above 0 (or 0 or more with allowZero); numeric strings are accepted.
function requireQty(value, label, { allowZero = false } = {}) {
  const n = toNumber(value);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw badRequest(`${label} must be a number ${allowZero ? 'of 0 or more' : 'above 0'}`);
  }
  return n;
}

function requireItem(db, itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(itemId));
  if (!item) throw badRequest(`There is no item with id ${itemId}`);
  return item;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

module.exports = { badRequest, isDate, requireDate, requireQty, requireItem, toNumber, round6 };
