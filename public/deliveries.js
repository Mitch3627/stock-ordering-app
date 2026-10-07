const { esc, round, dayLabel, fmtQty, nativeUnit, unitOptions, conversionText, toOrder, toPacks, packSize, busy, toast } = window.ui;

let items = [];
let itemsById = {};
let pendingLines = []; // { itemId, qty (cases), useByDate, expected }
let slotsInfo = null;
let picker;

const $ = (id) => document.getElementById(id);

const addDays = (dateStr, n) => ui.addDays(dateStr, Math.floor(n)); // whole days of a shelf life

// The delivery slot being received (Mon / Wed / Fri), or the typed date for an extra delivery.
function chosenSlot() {
  const v = $('slot-select').value;
  return v === 'other' ? $('other-date').value : v;
}
function arrivalDate() { return $('arrived-at').value || chosenSlot(); }

function defaultUseBy(item) {
  return item.shelf_life_days != null ? addDays(arrivalDate() || ui.todayStr(), item.shelf_life_days) : '';
}

async function loadSlots() {
  slotsInfo = await window.api.get('/api/deliveries/slots');
  const describe = (s) => {
    if (s.loggedId) return `${s.label} – already logged`;
    if (s.skipped) return `${s.label} – marked not arrived`;
    if (s.confirmedLines != null) return `${s.label} – confirmed order (${s.confirmedLines} items)`;
    return `${s.label} – no confirmed order`;
  };
  $('slot-select').innerHTML = slotsInfo.slots.map(s => `<option value="${s.date}">${esc(describe(s))}</option>`).join('')
    + '<option value="other">Another date (extra delivery)…</option>';
  if (slotsInfo.suggested) $('slot-select').value = slotsInfo.suggested;
  onSlotChange();
}

function onSlotChange() {
  const other = $('slot-select').value === 'other';
  $('other-date-label').hidden = !other;
  if (!$('arrived-at').value) $('arrived-at').value = ui.todayStr();
}

async function init() {
  items = (await window.api.get('/api/items')).filter(i => i.active !== 0);
  itemsById = Object.fromEntries(items.map(i => [i.id, i]));
  picker = ui.itemPicker($('item-input'), items, {
    onPick: (item) => {
      $('qty-unit').innerHTML = unitOptions(item, 'order', { packs: true });
      $('line-useby').value = defaultUseBy(item);
      updateConversion();
      $('qty').focus();
    },
  });
  $('qty-unit').innerHTML = '<option value="order">cases</option>';
  $('arrived-at').value = ui.todayStr();
  renderLines();
  await loadSlots();
  await loadDeliveries();
}

function updateConversion() {
  const item = picker && picker.item;
  $('qty-conv').textContent = item ? conversionText(item, $('qty').value, $('qty-unit').value) : '';
}
// Enter in a box mustn't submit (and reload) the page; saving is done with the buttons.
for (const id of ['delivery-form', 'line-form']) $(id).addEventListener('submit', (e) => e.preventDefault());
$('qty').addEventListener('input', updateConversion);
$('qty-unit').addEventListener('change', updateConversion);
$('slot-select').addEventListener('change', onSlotChange);

// ---- the delivery being logged ----
function renderLines() {
  const totals = {};
  for (const l of pendingLines) totals[l.itemId] = (totals[l.itemId] || 0) + (Number(l.qty) || 0);
  const firstRow = new Set();
  const tbody = $('lines-table').querySelector('tbody');
  if (pendingLines.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No items yet – load the expected items, or add them one at a time above.</td></tr>';
    $('lines-summary').textContent = 'Add the same item twice to record two use-by dates. Use-by dates can also be added later.';
    return;
  }
  tbody.innerHTML = pendingLines.map((line, idx) => {
    const item = itemsById[line.itemId];
    const isFirst = !firstRow.has(line.itemId);
    firstRow.add(line.itemId);
    const short = isFirst && line.expected != null && totals[line.itemId] < line.expected;
    const tags = (item.track_use_by ? ' <span class="badge badge-info no-dot">Use-by</span>' : '')
      + (isFirst ? '' : ' <span class="badge badge-neutral no-dot">Another use-by</span>')
      + (short ? ' <span class="badge badge-warn">Short</span>' : '');
    const nc = packSize(item) ? ` · ${round(toPacks(item, Number(line.qty) || 0))} supplier packs` : '';
    return `<tr data-idx="${idx}"${short ? ' class="short-line"' : ''}>
      <td><span class="cell-title">${esc(item.name)}</span>${tags}</td>
      <td class="num muted">${isFirst && line.expected != null ? round(line.expected) : ''}</td>
      <td><input type="number" step="0.01" min="0" class="line-qty" value="${line.qty}" aria-label="Received cases"><span class="cell-sub">${esc(fmtQty(item, Number(line.qty) || 0))}${nc}</span></td>
      <td><input type="date" class="line-useby" value="${line.useByDate || ''}" aria-label="Use-by date"></td>
      <td class="num"><button type="button" class="line-remove btn-ghost btn-sm">Remove</button></td>
    </tr>`;
  }).join('');
  const itemCount = new Set(pendingLines.filter(l => l.qty > 0).map(l => l.itemId)).size;
  const shortItems = [...new Set(pendingLines.map(l => l.itemId))].filter(id => {
    const first = pendingLines.find(l => l.itemId === id);
    return first.expected != null && totals[id] < first.expected;
  }).length;
  $('lines-summary').textContent = `${itemCount} item${itemCount === 1 ? '' : 's'} to receive${shortItems ? ` · ${shortItems} short of the order` : ''}`;
}

$('lines-table').querySelector('tbody').addEventListener('change', (event) => {
  const tr = event.target.closest('tr');
  if (!tr) return;
  const line = pendingLines[Number(tr.dataset.idx)];
  if (event.target.classList.contains('line-qty')) line.qty = Number(event.target.value);
  if (event.target.classList.contains('line-useby')) line.useByDate = event.target.value || null;
  renderLines();
});

$('lines-table').querySelector('tbody').addEventListener('click', (event) => {
  if (!event.target.classList.contains('line-remove')) return;
  pendingLines.splice(Number(event.target.closest('tr').dataset.idx), 1);
  renderLines();
});

$('add-line').addEventListener('click', () => {
  const item = picker.item;
  const typed = Number($('qty').value);
  if (!item) { toast('Pick an item from the list first.', 'warn'); $('item-input').focus(); return; }
  if (!(typed > 0)) { toast('Enter a quantity above 0.', 'warn'); $('qty').focus(); return; }
  const qty = round(toOrder(item, typed, $('qty-unit').value), 6);
  const useByDate = $('line-useby').value || null;
  const existing = pendingLines.find(l => l.itemId === item.id && (l.useByDate || null) === useByDate);
  if (existing) existing.qty = round(existing.qty + qty, 6);
  else pendingLines.push({ itemId: item.id, qty, useByDate, expected: (pendingLines.find(l => l.itemId === item.id) || {}).expected ?? null });
  renderLines();
  picker.clear();
  $('qty').value = '';
  $('line-useby').value = '';
  $('qty-conv').textContent = '';
  $('item-input').focus();
});

$('load-expected').addEventListener('click', async () => {
  const slot = chosenSlot();
  if (!slot) { toast('Pick the delivery first.', 'warn'); return; }
  if (pendingLines.length && !confirm('Replace the lines already entered with the expected items?')) return;
  try {
    const expected = await window.api.get(`/api/orders/expected/${slot}`);
    pendingLines = expected.lines.filter(l => itemsById[l.itemId]).map(l => ({
      itemId: l.itemId, qty: l.qty, expected: l.qty, useByDate: defaultUseBy(itemsById[l.itemId]) || null,
    }));
    const note = $('expected-note');
    note.hidden = false;
    note.classList.toggle('warn', expected.source !== 'confirmed');
    const text = expected.source === 'confirmed'
      ? `Loaded the confirmed order for ${dayLabel(slot)} (${pendingLines.length} items). Change anything that came short or extra.`
      : `There's no confirmed order for ${dayLabel(slot)}, so these are only the plan's suggestions – check every line against the delivery note.`;
    note.innerHTML = `${window.icon(expected.source === 'confirmed' ? 'info' : 'alert')}<span>${esc(text)}</span>`;
    renderLines();
  } catch (err) {
    toast('Could not load the expected items: ' + err.message, 'error');
  }
});

// Use-by dates for tracked items that don't have one yet: optional - blanks are asked for later.
function askUseByDates(lines) {
  const dialog = $('useby-dialog');
  $('useby-fields').innerHTML = lines.map((l, idx) => {
    const item = itemsById[l.itemId];
    return `<label>${esc(item.name)} (${esc(fmtQty(item, l.qty))}) <input type="date" data-idx="${idx}"></label>`;
  }).join('');
  return new Promise(resolve => {
    const form = $('useby-form');
    const cancel = $('useby-cancel');
    const cleanup = () => { form.onsubmit = null; cancel.onclick = null; };
    form.onsubmit = (e) => {
      e.preventDefault();
      form.querySelectorAll('input[data-idx]').forEach(inp => { lines[Number(inp.dataset.idx)].useByDate = inp.value || null; });
      cleanup(); dialog.close(); resolve(true);
    };
    cancel.onclick = () => { cleanup(); dialog.close(); resolve(false); };
    dialog.showModal();
  });
}

async function postDelivery(body) {
  try {
    return await window.api.post('/api/deliveries', body);
  } catch (err) {
    if (!/already logged/.test(err.message)) throw err;
    if (!confirm(`${err.message}. Add these items to that delivery instead?\n\n(Cancel if it was already logged in full – nothing will be saved.)`)) return null;
    return window.api.post('/api/deliveries', { ...body, addToExisting: true });
  }
}

$('submit-delivery').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  const deliveredAt = chosenSlot();
  if (!deliveredAt) { toast('Pick which delivery this is (or a date for an extra one).', 'warn'); return; }
  const active = pendingLines.filter(l => l.qty > 0);
  if (active.length === 0) { toast('Add at least one line with a quantity.', 'warn'); return; }
  const undated = active.filter(l => !l.useByDate && itemsById[l.itemId].track_use_by);
  if (undated.length > 0 && !(await askUseByDates(undated))) return;
  const arrivedAt = $('arrived-at').value;
  const body = {
    deliveredAt,
    arrivedAt: arrivedAt && arrivedAt !== deliveredAt ? arrivedAt : undefined,
    note: $('delivery-note').value || undefined,
    lines: active.map(l => ({ itemId: l.itemId, qty: l.qty, ...(l.useByDate ? { useByDate: l.useByDate } : {}) })),
  };
  let saved;
  try {
    saved = await postDelivery(body);
  } catch (err) {
    toast('The delivery was not saved: ' + err.message, 'error');
    return;
  }
  if (!saved) return;
  toast((saved.merged ? `Added to the ${dayLabel(deliveredAt)} delivery.` : `Delivery for ${dayLabel(deliveredAt)} saved (${active.length} lines).`)
    + (saved.stockChanged === false ? ' Recorded only – the latest count already includes this stock.' : ''));
  pendingLines = [];
  renderLines();
  $('delivery-note').value = '';
  $('expected-note').hidden = true;
  await loadSlots();
  await loadDeliveries();
}));

// ---- delivery history: view, correct, add, remove, delete ----
let deliveries = [];
let openDeliveryId = null;
let historyPicker = null;

// When it was logged, in UK time ("Wed 23 Sep 14:05").
const ukDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const ukTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
function loggedAt(created) {
  if (!created) return '—';
  const d = new Date(created.replace(' ', 'T') + 'Z');
  return `${dayLabel(ukDay.format(d))} ${ukTime.format(d)}`;
}

function batchText(l) {
  if (!l.batches || l.batches.length === 0) return l.track_use_by ? '<span class="badge badge-warn">No date yet</span>' : '<span class="muted">—</span>';
  return l.batches.map(b => `<span class="nowrap">${esc(dayLabel(b.use_by_date))} <small class="muted">· ${round(b.qty_remaining)} left</small></span>`).join('<br>');
}

function detailRow(d) {
  const editing = window.isEditing && window.isEditing();
  const rows = d.lines.map(l => {
    const short = l.ordered_qty != null && l.qty < l.ordered_qty;
    const useBy = editing && l.batches && l.batches.length
      ? l.batches.map(b => `<input type="date" class="edit-date" value="${esc(b.use_by_date)}" data-batch="${b.id}" aria-label="Use-by date">`).join('<br>')
      : batchText(l);
    const qtyCell = editing
      ? `<input type="number" step="0.01" min="0" class="edit-line-qty" value="${l.qty}" data-item="${l.item_id}" aria-label="Received cases">`
      : `<span class="cell-title">${round(l.qty)}</span>`;
    return `<tr data-item="${l.item_id}"${short ? ' class="short-line"' : ''}>
      <td><span class="cell-title">${esc(l.item_name)}</span>${short ? ' <span class="badge badge-warn">Short</span>' : ''}${l.ordered_qty == null ? ' <span class="badge badge-neutral no-dot">Not on the order</span>' : ''}</td>
      <td class="num muted">${l.ordered_qty ?? '—'}</td>
      <td>${qtyCell}<span class="cell-sub">${esc(fmtQty(l, l.qty))}</span></td>
      <td>${useBy}</td>
      <td class="num">${editing ? `<button type="button" class="remove-delivery-line btn-ghost btn-sm" data-item="${l.item_id}">Remove</button>` : ''}</td>
    </tr>`;
  }).join('');
  const addRow = editing ? `<tr class="add-row"><td colspan="5"><div class="row">
      <span class="picker-wrap" style="flex:1 1 260px"><input type="text" class="add-delivery-item" placeholder="Add an item that was missed…" aria-label="Item to add"></span>
      <input type="number" step="0.01" min="0" class="add-delivery-qty" placeholder="Cases" aria-label="Cases" style="width:110px">
      <input type="date" class="add-delivery-useby" aria-label="Use-by date (optional)" style="width:170px">
      <button type="button" class="confirm-add-delivery-line btn-sm">Add</button>
      <span class="spacer"></span>
      <button type="button" class="delete-delivery btn-danger btn-sm">Delete this delivery</button>
    </div></td></tr>` : '';
  const countedNote = d.countedSince
    ? `<div class="callout" style="margin-bottom:12px">${window.icon('info')}<span>A stock count has been taken since this delivery arrived, so corrections here fix the record without changing stock again.</span></div>` : '';
  return `<tr class="delivery-detail"><td colspan="6">${countedNote}
    <table class="detail-table"><thead><tr><th>Item</th><th class="num">Ordered</th><th>Received (cases)</th><th>Use by</th><th></th></tr></thead>
    <tbody>${rows}${addRow}</tbody></table>
  </td></tr>`;
}

function renderDeliveries() {
  const tbody = $('deliveries-table').querySelector('tbody');
  if (deliveries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No deliveries logged yet.</td></tr>';
    return;
  }
  tbody.innerHTML = deliveries.map(d => {
    const received = d.lines.filter(l => l.qty > 0).length;
    const shortCount = d.lines.filter(l => l.ordered_qty != null && l.qty < l.ordered_qty).length;
    const open = openDeliveryId === d.id;
    const rows = [`<tr data-id="${d.id}"><td class="nowrap"><span class="cell-title">${esc(dayLabel(d.delivered_at))}</span></td>
      <td class="muted nowrap">${d.arrived_at ? esc(dayLabel(d.arrived_at)) : 'Same day'}</td>
      <td class="muted nowrap">${esc(loggedAt(d.created_at))}${d.created_by_name ? `<span class="cell-sub">by ${esc(d.created_by_name.split(' ')[0])}</span>` : ''}</td><td>${esc(d.note ?? '')}</td>
      <td class="nowrap">${received} item${received === 1 ? '' : 's'}${shortCount ? ` <span class="badge badge-warn">${shortCount} short</span>` : ''}</td>
      <td class="num"><button type="button" class="view-delivery btn-secondary btn-sm" data-id="${d.id}" aria-expanded="${open}">${open ? 'Hide' : 'View'}</button></td></tr>`];
    if (open) rows.push(detailRow(d));
    return rows.join('');
  }).join('');
  const addInput = tbody.querySelector('.add-delivery-item');
  historyPicker = addInput ? ui.itemPicker(addInput, items) : null;
}

const historyBody = $('deliveries-table').querySelector('tbody');

historyBody.addEventListener('click', async (event) => {
  const t = event.target;
  if (t.classList.contains('view-delivery')) {
    const id = Number(t.dataset.id);
    openDeliveryId = openDeliveryId === id ? null : id;
    renderDeliveries();
    return;
  }
  const delivery = deliveries.find(d => d.id === openDeliveryId);
  if (!delivery) return;
  const afterSave = (res, done) => {
    toast(res && res.stockChanged === false ? `${done} (record only – stock unchanged, a later count covers it).` : done);
  };
  if (t.classList.contains('remove-delivery-line')) {
    const line = delivery.lines.find(l => l.item_id === Number(t.dataset.item));
    if (!confirm(`Remove ${line.item_name} from the ${dayLabel(delivery.delivered_at)} delivery? Its stock will be taken back off.`)) return;
    await busy(t, async () => {
      try { afterSave(await window.api.del(`/api/deliveries/${delivery.id}/lines/${line.item_id}`), 'Removed'); await loadDeliveries(); }
      catch (err) { toast('Not removed: ' + err.message, 'error'); }
    });
    return;
  }
  if (t.classList.contains('confirm-add-delivery-line')) {
    const box = t.closest('.detail-table');
    const qty = Number(box.querySelector('.add-delivery-qty').value);
    const useByDate = box.querySelector('.add-delivery-useby').value || undefined;
    if (!historyPicker || !historyPicker.value || !(qty > 0)) { toast('Pick an item and enter the cases received.', 'warn'); return; }
    await busy(t, async () => {
      try {
        afterSave(await window.api.post(`/api/deliveries/${delivery.id}/lines`, { itemId: historyPicker.value, qty, useByDate }), 'Added');
        await loadDeliveries();
      } catch (err) { toast('Not added: ' + err.message, 'error'); }
    });
    return;
  }
  if (t.classList.contains('delete-delivery')) {
    if (!confirm(`Delete the whole ${dayLabel(delivery.delivered_at)} delivery (${delivery.lines.length} lines)? Its stock comes back off, and if it had a confirmed order that order is expected again.`)) return;
    await busy(t, async () => {
      try {
        const res = await window.api.del(`/api/deliveries/${delivery.id}`);
        toast(res.restoredOrder ? 'Delivery deleted – its confirmed order is expected again.' : 'Delivery deleted.');
        openDeliveryId = null;
        await loadSlots();
        await loadDeliveries();
      } catch (err) { toast('Not deleted: ' + err.message, 'error'); }
    });
  }
});

historyBody.addEventListener('change', async (event) => {
  const t = event.target;
  if (!openDeliveryId) return;
  try {
    if (t.classList.contains('edit-line-qty')) {
      const qty = Number(t.value);
      if (t.value === '' || !(qty >= 0)) { toast('Enter the cases received (0 or more).', 'warn'); await loadDeliveries(); return; }
      const res = await window.api.put(`/api/deliveries/${openDeliveryId}/lines/${t.dataset.item}`, { qty });
      toast(res.stockChanged === false ? 'Saved (record only – a later count covers this delivery).' : 'Saved');
      await loadDeliveries();
    } else if (t.classList.contains('edit-date')) {
      if (!t.value) { await loadDeliveries(); return; }
      await window.api.put(`/api/batches/${t.dataset.batch}`, { use_by_date: t.value });
      toast('Use-by date saved');
      await loadDeliveries();
    }
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
    await loadDeliveries();
  }
});

window.addEventListener('editmodechange', renderDeliveries);

// The last 60 days unless 'Show older' has been pressed, so the page stays quick as the months go by.
let showAllDeliveries = false;
async function loadDeliveries() {
  deliveries = await window.api.get(showAllDeliveries ? '/api/deliveries' : `/api/deliveries?since=${ui.addDays(ui.todayStr(), -60)}`);
  $('deliveries-more').hidden = showAllDeliveries;
  renderDeliveries();
}
$('deliveries-show-older').addEventListener('click', () => { showAllDeliveries = true; loadDeliveries().catch(err => toast('Failed to load: ' + err.message, 'error')); });

init().catch(err => toast('Failed to load: ' + err.message, 'error'));
