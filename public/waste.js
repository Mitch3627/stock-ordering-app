const { esc, round, dayLabel, fmtQty, unitOptions, conversionText, toOrder, toNative, busy, toast } = window.ui;

let items = [];
let itemsById = {};
let wasteRows = [];
let picker;
const $ = (id) => document.getElementById(id);

async function init() {
  items = await window.api.get('/api/items');
  itemsById = Object.fromEntries(items.map(i => [i.id, i]));
  picker = ui.itemPicker($('item-input'), items, {
    onPick: (item) => {
      $('qty-unit').innerHTML = unitOptions(item, 'native');
      updateConversion();
      $('qty').focus();
    },
  });
  $('qty-unit').innerHTML = '<option value="native">Unit</option>';
  $('occurred-at').value = ui.todayStr();
  prefillFromLink();
  await loadWaste();
  await loadUnclaimed();
}

function updateConversion() {
  $('qty-conv').textContent = picker.item ? conversionText(picker.item, $('qty').value, $('qty-unit').value) : '';
}
$('qty').addEventListener('input', updateConversion);
$('qty-unit').addEventListener('change', updateConversion);

// Pre-fills the form from a link such as waste.html?item=94&ood=1 (the Expiry page's "log as out-of-date").
function prefillFromLink() {
  const p = new URLSearchParams(location.search);
  const item = itemsById[Number(p.get('item'))];
  if (!item) return;
  picker.set(item);
  if (p.get('qty')) { $('qty-unit').value = 'order'; $('qty').value = p.get('qty'); }
  if (p.get('ood') === '1') { $('ood').checked = true; $('reason').value = 'Out of date'; }
  updateConversion();
}

function setOod(item, orderQty) {
  picker.set(item);
  $('qty-unit').innerHTML = unitOptions(item, 'native');
  $('qty').value = round(toNative(item, orderQty));
  $('ood').checked = true;
  $('reason').value = 'Out of date';
  $('occurred-at').value = ui.todayStr();
  updateConversion();
  $('waste-form').scrollIntoView({ behavior: 'smooth' });
}

// Waste larger than half of what's in stock is usually a unit slip (6 cases typed for 6 nuggets): check first.
function looksWrong(item, orderQty) {
  const onHand = Math.max(0, item.on_hand_qty || 0);
  if (onHand > 0 && orderQty <= onHand * 0.5) return false;
  if (onHand === 0 && orderQty < 1) return false;
  return !confirm(`${item.name}: logging ${fmtQty(item, orderQty)} as waste takes ${onHand > 0 ? Math.round(orderQty / onHand * 100) + '% of' : 'more than'} the ${fmtQty(item, onHand)} in stock.\n\nIs that right?`);
}

$('waste-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('log-waste'), async () => {
    const item = picker.item;
    const typed = Number($('qty').value);
    if (!item) { toast('Pick an item from the list.', 'warn'); return; }
    if (!(typed > 0)) { toast('Enter a quantity above 0.', 'warn'); return; }
    const unit = $('qty-unit').value;
    let saved;
    if (looksWrong(item, toOrder(item, typed, unit))) return;
    try {
      saved = await window.api.post('/api/waste', {
        itemId: item.id, qty: typed, unit,
        occurredAt: $('occurred-at').value,
        shift: $('shift').value,
        reason: $('reason').value || null,
        ood: $('ood').checked,
      });
    } catch (err) {
      toast('Not logged: ' + err.message, 'error');
      return;
    }
    toast(`Logged ${fmtQty(item, toOrder(item, typed, unit))} of ${item.name}.` + (saved && saved.stockChanged === false ? ' Recorded only – the latest count already includes it.' : ''));
    const keepDate = $('occurred-at').value;
    const keepShift = $('shift').value;
    $('waste-form').reset();
    picker.clear();
    $('occurred-at').value = keepDate;
    $('shift').value = keepShift;
    $('qty-conv').textContent = '';
    items = await window.api.get('/api/items');
    itemsById = Object.fromEntries(items.map(i => [i.id, i]));
    picker.setItems(items);
    await loadWaste();
    await loadUnclaimed();
  });
});

// The last 60 days unless 'Show older' has been pressed, so the page stays quick as the months go by.
let showAllWaste = false;
async function loadWaste() {
  wasteRows = await window.api.get(showAllWaste ? '/api/waste' : `/api/waste?from=${ui.addDays(ui.todayStr(), -60)}`);
  $('waste-more').hidden = showAllWaste;
  renderWaste();
}
$('waste-show-older').addEventListener('click', () => { showAllWaste = true; loadWaste().catch(err => toast('Failed to load: ' + err.message, 'error')); });

function renderWaste() {
  const editing = window.isEditing && window.isEditing();
  $('waste-table').querySelector('tbody').innerHTML = wasteRows.length === 0
    ? '<tr><td colspan="6" class="table-empty">No waste logged yet.</td></tr>'
    : wasteRows.map(r => `
    <tr data-id="${r.id}"><td class="nowrap">${esc(dayLabel(r.occurred_at))}</td><td><span class="cell-title">${esc(r.item_name)}</span>${r.ood ? ' <span class="badge badge-warn">Out of date</span>' : ''}</td>
      <td class="num">${esc(fmtQty(r, r.qty))}</td><td>${r.shift === 'open' ? 'Opener' : 'Closer'}${r.created_by_name ? `<span class="cell-sub">by ${esc(r.created_by_name.split(' ')[0])}</span>` : ''}</td><td class="reason-cell" title="${esc(r.reason ?? '')}">${esc(r.reason ?? '')}</td>
      <td class="num">${editing ? '<span class="row-actions" style="justify-content:flex-end"><button type="button" class="edit-waste btn-secondary btn-sm">Correct</button><button type="button" class="delete-waste btn-danger btn-sm">Delete</button></span>' : ''}</td></tr>
  `).join('');
}

async function loadUnclaimed() {
  const rows = await window.api.get('/api/waste/expired-stock');
  $('unclaimed').innerHTML = rows.length === 0
    ? `<div class="card-body"><div class="callout ok">${window.icon('check')}<span>Nothing past its use-by is waiting to be logged.</span></div></div>`
    : '<ul class="list">' + rows.map(r => `<li>
        <span class="grow"><strong>${esc(r.item_name)}</strong><small>${esc(fmtQty(r, r.qty))} · use-by ${esc(dayLabel(r.oldest_use_by))}</small></span>
        <span class="badge badge-bad">Past use-by</span>
        <button type="button" class="btn-secondary btn-sm log-ood" data-item="${r.item_id}" data-qty="${r.qty}">Log as out-of-date</button></li>`).join('') + '</ul>';
}

$('unclaimed').addEventListener('click', (e) => {
  if (!e.target.classList.contains('log-ood')) return;
  const item = itemsById[Number(e.target.dataset.item)];
  if (item) setOod(item, Number(e.target.dataset.qty));
});

// ---- correct / delete ----
let editing = null;

$('waste-table').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const row = wasteRows.find(r => r.id === Number(tr.dataset.id));
  if (e.target.classList.contains('delete-waste')) {
    if (!confirm(`Delete this waste entry (${fmtQty(row, row.qty)} of ${row.item_name}, ${dayLabel(row.occurred_at)})? The stock goes back into inventory.`)) return;
    await busy(e.target, async () => {
      try { await window.api.del(`/api/waste/${row.id}`); toast('Waste entry deleted – stock put back.'); await loadWaste(); await loadUnclaimed(); }
      catch (err) { toast('Not deleted: ' + err.message, 'error'); }
    });
  } else if (e.target.classList.contains('edit-waste')) {
    editing = row;
    $('edit-title').textContent = `Correct waste: ${row.item_name}`;
    $('edit-date').value = row.occurred_at;
    $('edit-unit').innerHTML = unitOptions(row, 'native');
    $('edit-qty').value = round(toNative(row, row.qty), 4);
    $('edit-shift').value = row.shift;
    $('edit-reason').value = row.reason || '';
    $('edit-ood').checked = !!row.ood;
    $('edit-dialog').showModal();
  }
});

$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());
$('edit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('edit-save'), async () => {
    const qty = Number($('edit-qty').value);
    if (!(qty > 0)) { toast('Enter a quantity above 0 (or delete the entry).', 'warn'); return; }
    try {
      await window.api.put(`/api/waste/${editing.id}`, {
        qty, unit: $('edit-unit').value, occurredAt: $('edit-date').value, shift: $('edit-shift').value,
        reason: $('edit-reason').value || null, ood: $('edit-ood').checked,
      });
    } catch (err) {
      toast('Not saved: ' + err.message, 'error');
      return;
    }
    $('edit-dialog').close();
    toast('Waste entry corrected.');
    await loadWaste();
    await loadUnclaimed();
  });
});

window.addEventListener('editmodechange', renderWaste);

init().catch(err => toast('Failed to load: ' + err.message, 'error'));
