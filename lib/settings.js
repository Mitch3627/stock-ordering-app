// Store settings, changed on the Settings page. Each is stored as JSON in the settings table; anything not set
// yet uses the demo default here.
const { badRequest } = require('./validate');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DEFAULTS = {
  // Delivery days and the day each one's order is placed (0 = Sunday ... 6 = Saturday).
  deliverySchedule: [{ day: 1, orderDay: 5 }, { day: 3, orderDay: 1 }, { day: 5, orderDay: 3 }],
  targetCost: 3500, // Â£ per delivery that the plan balances towards
  fallbackSales: 4500, // Â£ a day assumed for days with no sales forecast
  // Items in these categories can be moved to another delivery to keep costs near the target.
  flexibleCategories: ['Dry Store', 'Packaging', 'Seasonal Items'],
};

// What the planner needs from a schedule: for each delivery weekday, how many days it has to last (until the
// next delivery day) and how many days before it the order is placed.
function makeSchedule(list) {
  const days = [...list].sort((a, b) => a.day - b.day);
  const cover = {};
  const lead = {};
  days.forEach((d, i) => {
    const next = days[(i + 1) % days.length].day;
    cover[d.day] = ((next - d.day + 7) % 7) || 7;
    lead[d.day] = ((d.day - d.orderDay + 7) % 7) || 7;
  });
  return { days, cover, lead };
}
const DEFAULT_SCHEDULE = makeSchedule(DEFAULTS.deliverySchedule);

function getSettings(db) {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in DEFAULTS) {
      try { out[r.key] = JSON.parse(r.value); } catch (e) { /* a damaged value keeps the default */ }
    }
  }
  return out;
}

function deliverySchedule(db) {
  return makeSchedule(getSettings(db).deliverySchedule);
}

// Checks and tidies a change; throws a 400 error explaining what's wrong.
function validate(patch) {
  const clean = {};
  if (patch.deliverySchedule !== undefined) {
    const list = patch.deliverySchedule;
    if (!Array.isArray(list) || list.length === 0) throw badRequest('Choose at least one delivery day');
    const seen = new Set();
    for (const d of list) {
      const day = Number(d.day);
      const orderDay = Number(d.orderDay);
      if (![day, orderDay].every(n => Number.isInteger(n) && n >= 0 && n <= 6)) throw badRequest('Days must be Sunday to Saturday');
      if (seen.has(day)) throw badRequest(`${DAY_NAMES[day]} is listed twice`);
      if (day === orderDay) throw badRequest(`${DAY_NAMES[day]}'s order has to be placed on an earlier day`);
      seen.add(day);
    }
    clean.deliverySchedule = list.map(d => ({ day: Number(d.day), orderDay: Number(d.orderDay) })).sort((a, b) => a.day - b.day);
  }
  for (const key of ['targetCost', 'fallbackSales']) {
    if (patch[key] === undefined) continue;
    const n = Number(patch[key]);
    if (!(Number.isFinite(n) && n > 0 && n < 1e7)) throw badRequest(`${key === 'targetCost' ? 'The target per delivery' : 'The default daily sales'} must be a number above 0`);
    clean[key] = Math.round(n * 100) / 100;
  }
  if (patch.flexibleCategories !== undefined) {
    if (!Array.isArray(patch.flexibleCategories) || patch.flexibleCategories.some(c => typeof c !== 'string')) {
      throw badRequest('flexibleCategories must be a list of category names');
    }
    clean.flexibleCategories = [...new Set(patch.flexibleCategories.map(c => c.trim()).filter(Boolean))];
  }
  return clean;
}

function saveSettings(db, patch) {
  const clean = validate(patch);
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => { for (const [k, v] of Object.entries(clean)) upsert.run(k, JSON.stringify(v)); })();
  return getSettings(db);
}

module.exports = { DEFAULTS, DAY_NAMES, DEFAULT_SCHEDULE, makeSchedule, getSettings, deliverySchedule, saveSettings, validate };
