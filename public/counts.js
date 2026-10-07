// Weekly / baseline count. Every quantity is typed in the supplier's own inventory unit, exactly as
// the supplier's count sheet asks for it; the app converts to order units behind the scenes.
const { esc, round, dayLabel, perOrder, nativeUnit, busy, toast } = window.ui;
let items = [];
let activeCategory = null; // null = show every category
let searchTerm = '';
// The count sheet is shared: figures are saved on the server as they're typed, so two people can split a count
// (one in the freezer, one in dry store) and see each other's entries.
let draft = { values: {} };
const pending = {}; // item id -> figure typed but not saved yet
let saveTimer = null;
let me = null;

const unitOf = (i) => nativeUnit(i);
const $ = (id) => document.getElementById(id);
const enteredCount = () => Object.values(draft.values).filter(v => v !== '').length;

function showSync(text, cls = '') {
  $('count-sync').textContent = text;
  $('count-sync').className = 'sync-note' + (cls ? ' ' + cls : '');
}

function describeShared(server) {
  const others = (server.people || []).filter(p => !me || p !== me.name);
  if (Object.keys(pending).length) return;
  showSync(others.length ? `Saved · also counting: ${others.join(', ')}` : enteredCount() ? 'Saved' : '');
}

// Sends everything typed since the last save. A failed save keeps the figures and tries again shortly.
async function flush() {
  clearTimeout(saveTimer);
  const batch = { ...pending };
  if (!Object.keys(batch).length) return;
  showSync('Saving…');
  try {
    await window.api.put('/api/counts/draft/items', { entries: batch });
    for (const [id, v] of Object.entries(batch)) if (pending[id] === v) delete pending[id];
    if (!Object.keys(pending).length) showSync('Saved');
  } catch (err) {
    showSync('Not saved yet – retrying…', 'warn');
    saveTimer = setTimeout(flush, 5000);
  }
}
function queueSave(id, value) {
  pending[id] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

// Picks up figures other people have entered, leaving alone anything this page hasn't saved yet
// and the box being typed in.
async function refresh() {
  let server;
  try { server = await window.api.get('/api/counts/draft'); } catch (e) { return; }
  const focusedId = document.activeElement && document.activeElement.classList.contains('counted-qty')
    ? document.activeElement.closest('tr').dataset.itemId : null;
  const ids = new Set([...Object.keys(draft.values), ...Object.keys(server.entries)]);
  for (const id of ids) {
    if (id in pending || id === focusedId) continue;
    const v = server.entries[id] ?? '';
    if ((draft.values[id] ?? '') === v) continue;
    if (v === '') delete draft.values[id]; else draft.values[id] = v;
    const tr = document.querySelector(`#count-table tr[data-item-id="${id}"]`);
    if (tr) {
      tr.querySelector('.counted-qty').value = v;
      tr.classList.toggle('has-value', v !== '');
      tr.querySelector('.hint').textContent = orderUnitsHint(items.find(i => String(i.id) === id), v);
    }
  }
  if (server.countedAt && document.activeElement !== $('counted-at')) $('counted-at').value = server.countedAt;
  updateProgress();
  describeShared(server);
}

function orderUnitsHint(item, value) {
  if (value === '' || !(item.items_per_order_unit > 0) || item.items_per_order_unit === 1) return '';
  return `= ${round(Number(value) / item.items_per_order_unit)} cases`;
}

function visible() {
  return items.filter(i => {
    if (activeCategory && i.category !== activeCategory) return false;
    if (searchTerm && !i.name.toLowerCase().includes(searchTerm) && !(i.supplier_name || '').toLowerCase().includes(searchTerm)) return false;
    return true;
  });
}

function render() {
  const cats = [...new Set(items.map(i => i.category))].sort();
  $('count-filters').innerHTML =
    `<button type="button" class="filter-btn${activeCategory === null ? ' active' : ''}" data-category="">All</button>` +
    cats.map(c => `<button type="button" class="filter-btn${c === activeCategory ? ' active' : ''}" data-category="${esc(c)}">${esc(c)}</button>`).join('');

  let html = '';
  let lastCat = null;
  for (const i of visible()) {
    if (i.category !== lastCat) {
      html += `<tr class="cat-row"><td colspan="3">${esc(i.category)}</td></tr>`;
      lastCat = i.category;
    }
    const v = draft.values[i.id] ?? '';
    html += `<tr data-item-id="${i.id}"${v !== '' ? ' class="has-value"' : ''}${i.supplier_name && i.supplier_name !== i.name ? ` title="Official supplier name: ${esc(i.supplier_name)}"` : ''}>
      <td>${esc(i.name)}</td>
      <td><input type="number" step="0.01" min="0" class="counted-qty" value="${esc(v)}" aria-label="Counted ${esc(i.name)}"></td>
      <td><strong>${esc(unitOf(i))}</strong> <span class="tile-note hint">${orderUnitsHint(i, v)}</span></td></tr>`;
  }
  document.querySelector('#count-table tbody').innerHTML = html || '<tr><td colspan="3">No items match.</td></tr>';
  updateProgress();
}

function updateProgress() {
  const n = enteredCount();
  $('count-progress').textContent = `${n} of ${items.length} items counted`;
  $('count-meter').style.width = (items.length ? Math.round(n / items.length * 100) : 0) + '%';
}

// A count typed on this device before counts were shared: send it to the shared sheet once, if that's empty.
async function moveLocalDraft(server) {
  let local = null;
  try {
    local = JSON.parse(localStorage.getItem('count-draft-v2') || 'null');
    if (!local) { const v1 = JSON.parse(localStorage.getItem('count-draft-v1') || 'null'); if (v1) local = { values: v1 }; }
  } catch (e) { return server; }
  const values = local && local.values ? Object.fromEntries(Object.entries(local.values).filter(([, v]) => v !== '')) : {};
  if (Object.keys(values).length && !Object.keys(server.entries).length) {
    await window.api.put('/api/counts/draft/items', { entries: values });
    if (local.date) await window.api.put('/api/counts/draft', { countedAt: local.date });
    server = await window.api.get('/api/counts/draft');
  }
  try { localStorage.removeItem('count-draft-v2'); localStorage.removeItem('count-draft-v1'); } catch (e) { /* fine */ }
  return server;
}

async function init() {
  [items, me] = await Promise.all([window.api.get('/api/items'), window.ui.me().catch(() => null)]);
  items = items.filter(i => i.active !== 0).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  let server = await moveLocalDraft(await window.api.get('/api/counts/draft'));
  draft = { values: { ...server.entries } };
  $('counted-at').value = server.countedAt || ui.todayStr();
  const n = enteredCount();
  if (n > 0 && server.startedOn && server.startedOn !== ui.todayStr() && !ui.isManager(me)) {
    toast('Carrying on with the count started ' + dayLabel(server.startedOn) + '.');
  } else if (n > 0 && server.startedOn && server.startedOn !== ui.todayStr()) {
    // An unfinished count from another day would otherwise be saved as this week's figures.
    const from = server.countedAt ? dayLabel(server.countedAt) : dayLabel(server.startedOn);
    if (!confirm(`There's an unfinished count from ${from} with ${n} items entered.\n\nOK – carry on with it\nCancel – start a fresh count (clears those entries for everyone)`)) {
      await window.api.del('/api/counts/draft');
      draft = { values: {} };
      server = { entries: {}, people: [] };
      $('counted-at').value = ui.todayStr();
    }
  }
  render();
  describeShared(server);
  setInterval(refresh, 20000);
  window.addEventListener('focus', refresh);
}

$('count-filters').addEventListener('click', (e) => {
  if (e.target.dataset.category === undefined) return;
  activeCategory = e.target.dataset.category || null;
  render();
});
$('count-search').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  render();
});
$('counted-at').addEventListener('change', () => {
  if (!$('counted-at').value) return;
  window.api.put('/api/counts/draft', { countedAt: $('counted-at').value }).catch(err => toast('Count date not saved: ' + err.message, 'error'));
});

document.querySelector('#count-table tbody').addEventListener('input', (e) => {
  if (!e.target.classList.contains('counted-qty')) return;
  const tr = e.target.closest('tr');
  const id = tr.dataset.itemId;
  const v = e.target.value;
  if (v === '') delete draft.values[id]; else draft.values[id] = v;
  tr.classList.toggle('has-value', v !== '');
  if (v === '' || Number(v) >= 0) queueSave(id, v);
  const item = items.find(i => String(i.id) === id);
  tr.querySelector('.hint').textContent = orderUnitsHint(item, v);
  updateProgress();
});
// Nothing typed is lost when leaving the page.
window.addEventListener('pagehide', () => { if (Object.keys(pending).length) flush(); });

function collectLines() {
  return Object.entries(draft.values)
    .filter(([, v]) => v !== '' && !Number.isNaN(Number(v)))
    .map(([id, v]) => ({ itemId: Number(id), countedQty: Number(v), unit: 'native' }));
}

$('preview-btn').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  await flush();
  await refresh(); // include everything the others have entered
  const lines = collectLines();
  if (lines.length === 0) { toast('Enter at least one counted quantity.', 'warn'); return; }
  const countedAt = $('counted-at').value;
  if (!countedAt) { toast('Pick the count date.', 'warn'); return; }
  let preview;
  try {
    preview = await window.api.post('/api/counts/preview', { countedAt, lines });
  } catch (err) {
    toast('Could not check the count: ' + err.message, 'error');
    return;
  }
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const counted = Object.fromEntries(lines.map(l => [l.itemId, l.countedQty]));
  const signedMoney = (v) => (v > 0.005 ? '+' : v < -0.005 ? '−' : '') + '£' + Math.abs(round(v)).toFixed(2);
  let totalValue = 0;
  const rows = preview.map(v => {
    const it = byId[v.itemId];
    const change = v.variance * perOrder(it);
    const value = it.price_per_unit ? v.variance * it.price_per_unit : null;
    if (value != null) totalValue += value;
    return { it, v, change, value };
  }).sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
  document.querySelector('#variance-table tbody').innerHTML = rows.map(({ it, v, change, value }) => `
    <tr${Math.abs(change) > 0.005 ? '' : ' class="muted"'}><td><span class="cell-title">${esc(it.name)}</span></td>
      <td class="num">${counted[v.itemId]} ${esc(unitOf(it))}</td>
      <td class="num">${round(v.expectedQty * perOrder(it))} ${esc(unitOf(it))}</td>
      <td class="num ${change > 0.005 ? 'text-ok' : change < -0.005 ? 'text-bad' : ''}">${change > 0 ? '+' : ''}${round(change)} ${esc(unitOf(it))}</td>
      <td class="num">${value == null ? '<span class="muted">no price</span>' : signedMoney(value)}</td></tr>`).join('');
  document.querySelector('#variance-table tfoot').innerHTML =
    `<tr class="cost-row"><td colspan="4">Total change in stock value</td><td class="num">${signedMoney(totalValue)}</td></tr>`;

  const warnings = [];
  if (countedAt !== ui.todayStr()) {
    const later = preview.filter(v => Math.abs(v.laterChange) > 1e-6).length;
    warnings.push(`This count is dated <strong>${esc(dayLabel(countedAt))}</strong>. It is checked against the stock at the end of that day; anything logged for later days (deliveries, sales, waste${later ? ` – it affects ${later} of these items` : ''}) stays on top of it.`);
  }
  const countedIds = new Set(lines.map(l => l.itemId));
  const missing = items.filter(i => !countedIds.has(i.id));
  if (missing.length) {
    warnings.push(`<details><summary>${missing.length} item${missing.length === 1 ? '' : 's'} not counted – they keep their current figure</summary>${missing.map(i => esc(i.name)).join(', ')}</details>`);
  }
  $('count-warnings').innerHTML = warnings.length
    ? warnings.map(w => `<div class="note-box warn">${w}</div>`).join('')
    : `<div class="callout ok">${window.icon('check')}<span>Every active item has been counted.</span></div>`;
  $('variance-section').hidden = false;
  $('variance-section').scrollIntoView({ behavior: 'smooth' });
}));

// A copy of the count laid out for typing into Supplier: official name, supplier unit, quantity.
function showTransfer(lines, countedAt) {
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const rows = lines.map(l => {
    const it = byId[l.itemId];
    return { name: it.supplier_name || it.name, unit: unitOf(it), qty: l.countedQty };
  }).sort((a, b) => a.name.localeCompare(b.name));
  document.querySelector('#transfer-table tbody').innerHTML = rows.map(r =>
    `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td class="num">${r.qty}</td></tr>`).join('');
  const csv = ['Supplier name,Unit,Counted']
    .concat(rows.map(r => `"${r.name.replace(/"/g, '""')}","${r.unit.replace(/"/g, '""')}",${r.qty}`)).join('\n');
  const link = $('download-csv');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `count-${countedAt}-supplier.csv`;
  $('transfer-section').hidden = false;
}

$('commit-btn').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  const countedAt = $('counted-at').value;
  if (!countedAt) { toast('Pick the count date.', 'warn'); return; }
  await flush();
  await refresh(); // include everything the others have entered
  const lines = collectLines();
  try {
    await window.api.post('/api/counts', { countedAt, lines });
  } catch (err) {
    toast('The count was not saved: ' + err.message, 'error');
    return;
  }
  toast(`Count for ${dayLabel(countedAt)} saved (${lines.length} items).`);
  showTransfer(lines, countedAt);
  draft = { values: {} }; // the server has cleared the shared sheet
  showSync('');
  $('variance-section').hidden = true;
  render();
  $('transfer-section').scrollIntoView();
}));

init().catch(err => toast('Failed to load: ' + err.message, 'error'));
