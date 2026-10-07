const { esc, round, dayLabel, perOrder, nativeUnit, confirmStockChange, toast } = window.ui;

let items = [];
let incoming = {};
let activeCategory = null;
let searchTerm = '';

async function loadItems() {
  items = (await window.api.get('/api/items')).filter(i => i.active !== 0);
  try { incoming = await window.api.get('/api/orders/incoming'); } catch (e) { incoming = {}; }
  renderStats();
  renderFilters();
  renderTable();
}

function renderStats() {
  const zero = items.filter(i => i.on_hand_qty <= 0).length;
  const incomingCount = Object.keys(incoming).length;
  const categories = new Set(items.map(i => i.category)).size;
  const stat = (label, value, sub, cls = '') => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  document.getElementById('inventory-stats').innerHTML =
    stat('Items tracked', items.length, `in ${categories} categories`) +
    stat('At or below zero', zero, zero ? 'need counting or ordering' : 'nothing has run out', zero ? 'text-bad' : '') +
    stat('On confirmed orders', incomingCount, 'items on their way');
}

function renderFilters() {
  const categories = [...new Set(items.map(i => i.category))].sort();
  const container = document.getElementById('category-filters');
  container.innerHTML = categories.map(cat => `
    <button type="button" class="filter-btn${cat === activeCategory ? ' active' : ''}" data-category="${esc(cat)}">${esc(cat)}</button>
  `).join('');
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.category;
      activeCategory = activeCategory === cat ? null : cat;
      renderFilters();
      renderTable();
    });
  });
}

function visibleItems() {
  return items.filter(item => {
    if (activeCategory && item.category !== activeCategory) return false;
    if (searchTerm && !item.name.toLowerCase().includes(searchTerm) && !(item.supplier_name || '').toLowerCase().includes(searchTerm)) return false;
    return true;
  });
}

function renderTable() {
  const editing = window.isEditing && window.isEditing();
  const ce = editing ? ' contenteditable="true"' : '';
  const tbody = document.querySelector('#inventory-table tbody');
  const rows = visibleItems();
  tbody.innerHTML = rows.length === 0 ? '<tr><td colspan="6" class="table-empty">No items match.</td></tr>' : rows.map(item => `
    <tr data-id="${item.id}"${item.on_hand_qty <= 0 ? ' class="row-bad"' : ''}>
      <td${ce} data-field="name" class="cell-title">${esc(item.name)}</td>
      <td class="muted">${esc(item.category)}</td>
      <td${ce} data-field="on_hand" class="num cell-title">${round(item.on_hand_qty * perOrder(item))}</td>
      <td class="muted">${esc(nativeUnit(item))}</td>
      <td class="num muted">${perOrder(item) !== 1 ? round(item.on_hand_qty) : ''}</td>
      <td>${incoming[item.id] ? `<span class="badge badge-info no-dot">${round(incoming[item.id].qty * perOrder(item))} ${esc(nativeUnit(item))} · ${esc(dayLabel(incoming[item.id].date))}</span>` : ''}</td>
    </tr>
  `).join('');
}

document.getElementById('item-search').addEventListener('input', (event) => {
  searchTerm = event.target.value.trim().toLowerCase();
  renderTable();
});

window.addEventListener('editmodechange', renderTable);

// Enter saves an edited cell instead of starting a new line in it
document.querySelector('#inventory-table tbody').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.isContentEditable) { event.preventDefault(); event.target.blur(); }
});

// Save an edited cell when you click away from it
document.querySelector('#inventory-table tbody').addEventListener('blur', async (event) => {
  const td = event.target;
  const field = td.dataset && td.dataset.field;
  if (!field) return;
  const id = Number(td.closest('tr').dataset.id);
  const item = items.find(i => i.id === id);
  const raw = td.textContent.trim();

  try {
    if (field === 'name') {
      if (raw === item.name) return;
      if (!raw) { toast('An item needs a name.', 'warn'); td.textContent = item.name; return; }
      const updated = await window.api.put(`/api/items/${id}`, { name: raw });
      item.name = updated.name;
      toast('Name saved');
    } else if (field === 'on_hand') {
      const qty = Number(raw);
      if (raw === '' || Number.isNaN(qty) || qty < 0) { toast('Enter a number of 0 or more.', 'warn'); td.textContent = round(item.on_hand_qty * perOrder(item)); return; }
      if (round(qty) === round(item.on_hand_qty * perOrder(item))) return;
      if (!confirmStockChange(item, item.on_hand_qty, qty / perOrder(item), qty, 'native')) { td.textContent = round(item.on_hand_qty * perOrder(item)); return; }
      await window.api.post('/api/inventory/adjust', { itemId: id, qty });
      toast(`${item.name} set to ${round(qty)} ${nativeUnit(item)}`);
      await loadItems();
    }
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
    await loadItems();
  }
}, true);

loadItems().catch(err => toast('Failed to load inventory: ' + err.message, 'error'));
