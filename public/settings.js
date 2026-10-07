// Store settings: which days deliveries arrive, the day each is ordered, the cost target and default sales.
const { esc, busy, toast } = window.ui;
const $ = (id) => document.getElementById(id);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // shown Monday first
let settings = null;

// The rows as they stand on screen: { day: orderDay } for every ticked day.
function scheduleOnScreen() {
  return [...document.querySelectorAll('#schedule-table tbody tr')]
    .filter(tr => tr.querySelector('.is-delivery').checked)
    .map(tr => ({ day: Number(tr.dataset.day), orderDay: Number(tr.querySelector('.order-day').value) }));
}

// "Mon – Tue (2 days)" for each delivery day, and how many days ahead its order goes in.
function describe(schedule) {
  const days = [...schedule].sort((a, b) => a.day - b.day);
  const out = {};
  days.forEach((d, i) => {
    const next = days[(i + 1) % days.length].day;
    const cover = ((next - d.day + 7) % 7) || 7;
    const lead = ((d.day - d.orderDay + 7) % 7) || 7;
    const last = (d.day + cover - 1) % 7;
    const until = cover === 1 ? 'the same day' : `${DAYS[d.day].slice(0, 3)} – ${DAYS[last].slice(0, 3)}`;
    out[d.day] = `${until} (${cover} day${cover === 1 ? '' : 's'}) · ordered ${lead} day${lead === 1 ? '' : 's'} before`;
  });
  return out;
}

function renderSchedule() {
  const byDay = Object.fromEntries(settings.deliverySchedule.map(d => [d.day, d.orderDay]));
  const info = describe(settings.deliverySchedule);
  $('schedule-table').querySelector('tbody').innerHTML = WEEK.map(day => {
    const on = day in byDay;
    // default order day for a newly ticked day: two days before
    const orderDay = on ? byDay[day] : (day + 5) % 7;
    const options = WEEK.filter(d => d !== day).map(d => `<option value="${d}"${d === orderDay ? ' selected' : ''}>${DAYS[d]}</option>`).join('');
    return `<tr data-day="${day}"${on ? '' : ' class="muted"'}>
      <td><span class="cell-title">${DAYS[day]}</span></td>
      <td><label class="check"><input type="checkbox" class="is-delivery"${on ? ' checked' : ''}> Delivery</label></td>
      <td><select class="order-day" aria-label="Order day for ${DAYS[day]}"${on ? '' : ' disabled'}>${options}</select></td>
      <td class="muted">${on ? esc(info[day]) : ''}</td></tr>`;
  }).join('');
}

function renderPlanSettings() {
  $('target-cost').value = settings.targetCost;
  $('fallback-sales').value = settings.fallbackSales;
  const chosen = new Set(settings.flexibleCategories);
  $('flex-cats').innerHTML = settings.categories.map(c =>
    `<label class="check" style="margin-right:18px"><input type="checkbox" class="flex-cat" value="${esc(c)}"${chosen.has(c) ? ' checked' : ''}> ${esc(c)}</label>`).join('');
}

// Ticking or changing a day redraws the "has to last" column straight away.
$('schedule-table').addEventListener('change', () => {
  settings.deliverySchedule = scheduleOnScreen();
  renderSchedule();
});

$('save-settings').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  const deliverySchedule = scheduleOnScreen();
  if (deliverySchedule.length === 0) { toast('Tick at least one delivery day.', 'warn'); return; }
  try {
    const saved = await window.api.put('/api/settings', {
      deliverySchedule,
      targetCost: Number($('target-cost').value),
      fallbackSales: Number($('fallback-sales').value),
      flexibleCategories: [...document.querySelectorAll('.flex-cat:checked')].map(c => c.value),
    });
    settings = { ...settings, ...saved };
    renderSchedule();
    renderPlanSettings();
    toast('Settings saved – the order plan now uses them.');
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
  }
}));

async function init() {
  settings = await window.api.get('/api/settings');
  renderSchedule();
  renderPlanSettings();
}

init().catch(err => toast('Failed to load: ' + err.message, 'error'));
