const { esc, dayLabel, toast } = window.ui;
let report = null;
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n === null || n === undefined) ? '<span class="muted">—</span>' : String(Math.round(n * 10000) / 10000);

async function init() {
  const counts = await window.api.get('/api/usage/counts');
  const opts = counts.map(c => `<option value="${c.id}">${esc(dayLabel(c.counted_at))} ${esc(c.counted_at.slice(0, 4))}</option>`).join('');
  $('from-count').innerHTML = opts;
  $('to-count').innerHTML = opts;
  if (counts.length >= 2) {
    $('to-count').value = counts[0].id;
    $('from-count').value = counts[1].id;
  } else {
    $('usage-summary').innerHTML = 'You need at least two stock counts before usage can be worked out – this becomes available after next week\'s count.';
  }
}

function render() {
  const cat = $('usage-category').value;
  const rows = report.items.filter(i => !cat || i.category === cat);
  const complete = report.salesDays >= report.days;
  $('usage-summary').innerHTML =
    `${esc(dayLabel(report.from))} to ${esc(dayLabel(report.to))} · ${report.days} days · real sales logged for ${report.salesDays} of them (£${report.sales.toLocaleString('en-GB')})` +
    (complete ? '' : `<div class="callout warn" style="margin-top:10px">${window.icon('alert')}<span>Some days have no real sales logged, so suggested rates would read too high. Log the missing days first.</span></div>`);
  $('usage-table').querySelector('tbody').innerHTML = rows.length === 0
    ? '<tr><td colspan="10" class="table-empty">No items were counted in both counts.</td></tr>'
    : rows.map(i => {
      const changed = i.suggested !== null && i.current > 0 && Math.abs(i.suggested - i.current) / i.current > 0.2;
      return `<tr data-id="${i.itemId}"><td><span class="cell-title">${esc(i.name)}</span></td>
        <td class="num">${fmt(i.opening)}</td><td class="num">${fmt(i.delivered)}</td><td class="num">${fmt(i.closing)}</td>
        <td class="num">${fmt(i.used)}</td><td class="num">${fmt(i.wasted)}</td><td class="num cell-title">${fmt(i.salesUsed)}</td>
        <td class="num">${fmt(i.current)}</td><td class="num">${fmt(i.suggested)}${changed ? ' <span class="badge badge-warn no-dot">±20%+</span>' : ''}</td>
        <td class="num">${i.suggested !== null && i.salesUsed >= 0 ? '<button type="button" class="apply-rate btn-secondary btn-sm manager-only">Apply</button>' : ''}</td></tr>`;
    }).join('');
}

$('usage-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    report = await window.api.get(`/api/usage?from=${$('from-count').value}&to=${$('to-count').value}`);
  } catch (err) { toast(err.message, 'error'); return; }
  const cats = [...new Set(report.items.map(i => i.category))].sort();
  $('usage-category').innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
  render();
});

$('usage-category').addEventListener('change', () => report && render());

$('usage-table').querySelector('tbody').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('apply-rate')) return;
  const id = Number(e.target.closest('tr').dataset.id);
  const row = report.items.find(i => i.itemId === id);
  try {
    await window.api.put(`/api/items/${id}`, { usage_per_100_sales: row.suggested });
    row.current = row.suggested;
    toast(`${row.name}: usage rate updated.`);
    render();
  } catch (err) { toast('Not saved: ' + err.message, 'error'); }
});

init().catch(err => toast('Failed to load: ' + err.message, 'error'));
