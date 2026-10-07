const { esc, round, dayLabel, fmtQty, perOrder, unitOptions, toOrder, confirmStockChange, busy, toast } = window.ui;

let batches = [];
const tbody = document.querySelector('#batches-table tbody');

function daysLeft(useBy) {
  const today = ui.todayStr();
  return Math.round((new Date(useBy + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
}

function describeDays(n) {
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} past`;
  if (n === 0) return 'today';
  return `${n} day${n === 1 ? '' : 's'}`;
}

function statusBadge(b) {
  if (b.status === 'expired') return '<span class="badge badge-bad">Past use-by</span>';
  if (b.status === 'use_soon') return `<span class="badge badge-warn">${daysLeft(b.use_by_date) === 0 ? 'Use today' : 'Use by tomorrow'}</span>`;
  return '<span class="badge badge-ok">OK</span>';
}

function renderStats() {
  const expired = batches.filter(b => b.status === 'expired');
  const soon = batches.filter(b => b.status === 'use_soon');
  const items = new Set(batches.map(b => b.item_id)).size;
  const stat = (label, value, sub, cls = '') => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  document.getElementById('useby-stats').innerHTML =
    stat('Past use-by', expired.length, expired.length ? 'waiting to be logged as waste' : 'nothing out of date', expired.length ? 'text-bad' : '') +
    stat('Use today or tomorrow', soon.length, soon.length ? 'batches to use first' : 'nothing close to its date', soon.length ? 'text-warn' : '') +
    stat('Dated batches', batches.length, `across ${items} item${items === 1 ? '' : 's'}`);
}

function render() {
  const editing = window.isEditing && window.isEditing();
  renderStats();
  if (batches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No use-by tracked stock right now.</td></tr>';
    return;
  }
  const seen = new Set();
  tbody.innerHTML = batches.map(b => {
    const inUse = !seen.has(b.item_id);
    seen.add(b.item_id);
    const useBy = editing
      ? `<input type="date" class="edit-date" value="${esc(b.use_by_date)}" aria-label="Use-by date">`
      : `<span class="cell-title">${esc(dayLabel(b.use_by_date))}</span>`;
    const qty = editing
      ? `<span class="qty-with-unit" style="justify-content:flex-end"><input type="number" step="0.01" min="0" class="edit-qty" value="${round(b.qty_remaining * perOrder(b))}" aria-label="Quantity"><select class="edit-unit" aria-label="Unit">${unitOptions(b, 'native')}</select></span>`
      : esc(fmtQty(b, b.qty_remaining));
    const action = b.status === 'expired' ? '<button type="button" class="log-ood btn-secondary btn-sm">Log as out-of-date</button>' : '';
    const n = daysLeft(b.use_by_date);
    return `<tr class="status-${b.status}" data-id="${b.id}" data-item-id="${b.item_id}">
      <td${editing ? ' contenteditable="true" data-field="name"' : ''}><span class="cell-title">${esc(b.item_name)}</span>${inUse && !editing ? ' <span class="badge badge-info no-dot">In use</span>' : ''}</td>
      <td class="muted nowrap">${esc(dayLabel(b.received_at))}</td>
      <td class="nowrap">${useBy}</td>
      <td class="nowrap ${n < 0 ? 'text-bad' : n <= 1 ? 'text-warn' : 'muted'}">${describeDays(n)}</td>
      <td class="num">${qty}</td><td>${statusBadge(b)}</td><td class="num">${action}</td>
    </tr>`;
  }).join('');
}

async function load() {
  batches = await window.api.get('/api/batches');
  render();
}

window.addEventListener('editmodechange', render);

// Date and quantity edits save as soon as you change them
tbody.addEventListener('change', async (event) => {
  const tr = event.target.closest('tr');
  if (!tr) return;
  const batch = batches.find(b => b.id === Number(tr.dataset.id));
  try {
    if (event.target.classList.contains('edit-date')) {
      if (!event.target.value) { event.target.value = batch.use_by_date; return; }
      await window.api.put(`/api/batches/${batch.id}`, { use_by_date: event.target.value });
      toast('Use-by date saved');
    } else if (event.target.classList.contains('edit-qty')) {
      const typed = Number(event.target.value);
      const unit = tr.querySelector('.edit-unit').value;
      if (event.target.value === '' || Number.isNaN(typed) || typed < 0) { toast('Enter a number of 0 or more.', 'warn'); render(); return; }
      const orderQty = toOrder(batch, typed, unit);
      if (!confirmStockChange({ ...batch, name: batch.item_name }, batch.qty_remaining, orderQty, typed, unit, 'this batch')) { render(); return; }
      await window.api.put(`/api/batches/${batch.id}`, { qty_remaining: orderQty });
      toast('Batch saved');
    } else {
      return;
    }
    await load();
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
    await load();
  }
});

// Expired stock is only removed when someone says so: log it as out-of-date waste in one go.
tbody.addEventListener('click', async (event) => {
  if (!event.target.classList.contains('log-ood')) return;
  const tr = event.target.closest('tr');
  const batch = batches.find(b => b.id === Number(tr.dataset.id));
  const shift = new Date().getHours() < 15 ? 'open' : 'close';
  if (!confirm(`Log ${fmtQty(batch, batch.qty_remaining)} of ${batch.item_name} (use-by ${dayLabel(batch.use_by_date)}) as out-of-date waste?\n\nIf only part of it is being thrown away, press Cancel and use the Waste page.`)) return;
  await busy(event.target, async () => {
    try {
      await window.api.post('/api/waste', {
        itemId: batch.item_id, qty: batch.qty_remaining, unit: 'order', occurredAt: ui.todayStr(),
        shift, reason: 'Out of date', ood: true, allowRepeat: true, // one click per batch; the button can't double-save
      });
      toast(`Logged ${batch.item_name} as out-of-date waste.`);
      await load();
    } catch (err) {
      toast('Not logged: ' + err.message, 'error');
    }
  });
});

// ---- give part of a batch its own use-by date ----
const $ = (id) => document.getElementById(id);

function redateBatch() { return batches.find(b => b.id === Number($('redate-batch').value)); }

function showRedateConversion() {
  const b = redateBatch();
  $('redate-conv').textContent = b ? ui.conversionText(b, $('redate-qty').value, $('redate-unit').value) : '';
}

// The item's batches, the latest date picked first - usually the stock being taken out.
function fillRedateBatches() {
  const list = batches.filter(b => b.item_id === Number($('redate-item').value));
  $('redate-batch').innerHTML = list.map((b, i) =>
    `<option value="${b.id}"${i === list.length - 1 ? ' selected' : ''}>Use by ${esc(dayLabel(b.use_by_date))} – ${esc(fmtQty(b, b.qty_remaining))}</option>`).join('');
  $('redate-unit').innerHTML = unitOptions(list[0], ui.hasCases(list[0]) ? 'order' : 'native');
  showRedateConversion();
}

$('redate-open').addEventListener('click', () => {
  const items = [...new Map(batches.map(b => [b.item_id, b.item_name]))].sort((a, b) => a[1].localeCompare(b[1]));
  if (items.length === 0) { toast('There is no dated stock to add a date to.', 'warn'); return; }
  $('redate-item').innerHTML = items.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
  $('redate-qty').value = '';
  $('redate-date').value = '';
  fillRedateBatches();
  $('redate-dialog').showModal();
});
$('redate-item').addEventListener('change', fillRedateBatches);
$('redate-batch').addEventListener('change', showRedateConversion);
$('redate-qty').addEventListener('input', showRedateConversion);
$('redate-unit').addEventListener('change', showRedateConversion);
$('redate-cancel').addEventListener('click', () => $('redate-dialog').close());

$('redate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('redate-save'), async () => {
    const b = redateBatch();
    const typed = Number($('redate-qty').value);
    const date = $('redate-date').value;
    if (!(typed > 0)) { toast('Enter how much is getting the new date.', 'warn'); return; }
    if (!date) { toast('Pick the new use-by date.', 'warn'); return; }
    if (date === b.use_by_date) { toast(`That batch is already use by ${dayLabel(date)}.`, 'warn'); return; }
    const qty = toOrder(b, typed, $('redate-unit').value);
    if (qty > b.qty_remaining + 1e-6) { toast(`That batch only has ${fmtQty(b, b.qty_remaining)}.`, 'warn'); return; }
    try {
      const res = await window.api.post(`/api/batches/${b.id}/split`, { qty, useByDate: date });
      $('redate-dialog').close();
      toast(res.whole
        ? `All ${fmtQty(b, b.qty_remaining)} of ${b.item_name} is now use by ${dayLabel(date)}.`
        : `${fmtQty(b, res.qty)} of ${b.item_name} is now use by ${dayLabel(date)} – ${fmtQty(b, b.qty_remaining - res.qty)} stays on ${dayLabel(b.use_by_date)}.`);
      await load();
    } catch (err) {
      toast('Not saved: ' + err.message, 'error');
    }
  });
});

// Item names save when you click away
tbody.addEventListener('blur', async (event) => {
  const td = event.target;
  if (!td.dataset || td.dataset.field !== 'name') return;
  const tr = td.closest('tr');
  const batch = batches.find(b => b.id === Number(tr.dataset.id));
  const name = td.textContent.trim();
  if (name === batch.item_name) return;
  try {
    if (!name) throw new Error('An item needs a name');
    await window.api.put(`/api/items/${batch.item_id}`, { name });
    toast('Name saved');
    await load();
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
    await load();
  }
}, true);

load().catch(err => toast('Failed to load: ' + err.message, 'error'));
