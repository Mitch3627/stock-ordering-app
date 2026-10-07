const { esc, round, nativeUnit, perOrder, busy, toast } = window.ui;

let items = [];
let activeCategory = null; // null = no category selected -> list stays collapsed
let searchTerm = '';
let showRetired = false;
let missingPrice = false;
const $ = (id) => document.getElementById(id);

// Numeric columns edited in place; blank means "not set" where that's allowed.
const NUMBER_FIELDS = ['items_per_order_unit', 'supplier_order_pack', 'usage_per_100_sales', 'buffer_value', 'max_boxes', 'case_multiple', 'price_per_unit'];
const TEXT_FIELDS = ['name', 'supplier_unit'];

async function loadItems() {
  items = await window.api.get('/api/items');
  renderFilters();
  renderItems();
  $('category-list').innerHTML = categories().map(c => `<option value="${esc(c)}">`).join('');
}

const categories = () => [...new Set(items.map(i => i.category))].sort();

function renderFilters() {
  const container = $('category-filters');
  container.innerHTML = `<button type="button" class="filter-btn${activeCategory === null ? ' active' : ''}" data-category="">All</button>` + categories().map(cat => `
    <button type="button" class="filter-btn${cat === activeCategory ? ' active' : ''}" data-category="${esc(cat)}">${esc(cat)}</button>
  `).join('');
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.category || null;
      activeCategory = activeCategory === cat ? null : cat;
      renderFilters();
      renderItems();
    });
  });
}

function visibleItems() {
  return items.filter(item => {
    if (!showRetired && item.active === 0) return false;
    if (missingPrice && (item.price_per_unit > 0 || !(item.usage_per_100_sales > 0))) return false;
    if (activeCategory && item.category !== activeCategory) return false;
    if (searchTerm && !item.name.toLowerCase().includes(searchTerm) &&
        !(item.supplier_name || '').toLowerCase().includes(searchTerm)) return false;
    return true;
  });
}

// One setting for use-by dates (stored as track_use_by + shelf_life_days, which the rest of the app reads):
//  - not dated
//  - date from the pack: typed in when a delivery arrives, and the app asks for any that are missing; a usual
//    number of days is optional (it pre-fills the date and helps plan how much can be used in time)
//  - days after delivery: every delivery is dated automatically that many days after it arrives
// Either way, stock past its date stays until someone logs it as out-of-date waste.
function useByMode(item) {
  if (item.track_use_by) return 'pack';
  return item.shelf_life_days != null ? 'days' : 'none';
}

function useByCell(item, editing) {
  const mode = useByMode(item);
  const days = item.shelf_life_days;
  if (!editing) {
    if (mode === 'none') return '<td class="muted">—</td>';
    if (mode === 'days') return `<td class="nowrap" title="Dated automatically this many days after each delivery">${esc(round(days, 1))} days</td>`;
    return `<td class="nowrap" title="Date typed in from the pack when it arrives"><span class="badge badge-info no-dot">Pack date</span>${days != null ? `<span class="cell-sub">usually ${esc(round(days, 1))} days</span>` : ''}</td>`;
  }
  const opt = (v, label) => `<option value="${v}"${v === mode ? ' selected' : ''}>${label}</option>`;
  return `<td class="useby-cell"><span class="useby-edit">
      <select class="useby-mode" aria-label="Use-by dates for ${esc(item.name)}">${opt('none', 'Not dated')}${opt('pack', 'Date from the pack')}${opt('days', 'Days after delivery')}</select>
      <input type="number" class="useby-days" min="1" step="1" value="${days ?? ''}" placeholder="${mode === 'pack' ? 'usual days' : 'days'}" aria-label="Days"${mode === 'none' ? ' hidden' : ''}>
    </span></td>`;
}

function renderItems() {
  const tbody = $('items-table').querySelector('tbody');
  // With no category picked and no search typed, keep the list collapsed rather than
  // dumping every row - pick a category or start typing to see items.
  const editing = window.isEditing && window.isEditing();
  const shown = (field, value) => {
    if (editing || value == null || typeof value !== 'number') return value;
    if (field === 'usage_per_100_sales') return Number(value.toPrecision(4));
    return ['buffer_value', 'max_boxes'].includes(field) ? round(value, 3) : value;
  };
  const ce = (field, value, cls = 'num') => `<td class="${cls}"${editing ? ` contenteditable="true"` : ''} data-field="${field}">${esc(shown(field, value) ?? '')}</td>`;
  const catOptions = (current) => categories().map(c => `<option${c === current ? ' selected' : ''}>${esc(c)}</option>`).join('');
  tbody.innerHTML = visibleItems().map(item => `
    <tr data-id="${item.id}"${item.active === 0 ? ' class="retired"' : ''}>
      <td class="cell-title"${editing ? ' contenteditable="true"' : ''} data-field="name"${item.supplier_name && item.supplier_name !== item.name ? ` title="Official supplier name: ${esc(item.supplier_name)}"` : ''}>${esc(item.name)}</td>
      <td class="muted">${editing ? `<select class="edit-category" aria-label="Category">${catOptions(item.category)}</select>` : esc(item.category)}</td>
      ${ce('supplier_unit', item.supplier_unit, 'muted')}
      ${ce('items_per_order_unit', item.items_per_order_unit)}
      ${ce('supplier_order_pack', item.supplier_order_pack)}
      ${ce('usage_per_100_sales', item.usage_per_100_sales)}
      ${ce('buffer_value', item.buffer_value)}
      ${ce('max_boxes', item.max_boxes)}
      ${ce('case_multiple', item.case_multiple)}
      ${!editing && item.usage_per_100_sales > 0 && !(item.price_per_unit > 0) ? '<td class="num" data-field="price_per_unit"><span class="badge badge-warn">Missing</span></td>' : ce('price_per_unit', item.price_per_unit)}
      ${useByCell(item, editing)}
      <td><input type="checkbox" class="active-toggle"${item.active !== 0 ? ' checked' : ''}${editing ? '' : ' disabled'} aria-label="Active"></td>
    </tr>
  `).join('') || '<tr><td colspan="12" class="table-empty">No items match.</td></tr>';
}

$('item-search').addEventListener('input', (event) => {
  searchTerm = event.target.value.trim().toLowerCase();
  renderItems();
});
$('show-retired').addEventListener('change', (e) => { showRetired = e.target.checked; renderItems(); });
$('missing-price').addEventListener('change', (e) => { missingPrice = e.target.checked; renderItems(); });
window.addEventListener('editmodechange', renderItems);

async function save(item, changes, message = 'Saved') {
  const updated = await window.api.put(`/api/items/${item.id}`, changes);
  Object.assign(item, updated);
  toast(message);
}

const tbody = $('items-table').querySelector('tbody');

// Enter saves the cell instead of starting a new line in it
tbody.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.isContentEditable) { event.preventDefault(); event.target.blur(); }
});

tbody.addEventListener('blur', async (event) => {
  const td = event.target;
  const field = td.dataset && td.dataset.field;
  if (!field || !td.isContentEditable) return;
  const item = items.find(i => i.id === Number(td.closest('tr').dataset.id));
  if (!item) return;
  const raw = td.textContent.trim();
  const reset = () => { td.textContent = item[field] ?? ''; };

  let value;
  if (TEXT_FIELDS.includes(field)) {
    if (field === 'name' && raw === '') { toast('An item needs a name.', 'warn'); reset(); return; }
    value = raw === '' ? null : raw;
  } else if (NUMBER_FIELDS.includes(field)) {
    value = raw === '' ? null : Number(raw);
    if (raw !== '' && (Number.isNaN(value) || value < 0)) { toast(`"${raw}" is not a valid number.`, 'warn'); reset(); return; }
  } else {
    return;
  }
  if (value === (item[field] ?? null)) return;

  const changes = { [field]: value };
  if (field === 'items_per_order_unit' && value > 0 && item.on_hand_qty) {
    // Stock is stored in cases, so changing the case size would silently change the physical stock.
    const now = round(item.on_hand_qty * perOrder(item));
    changes.convertStock = confirm(
      `${item.name}: a case now holds ${value} ${nativeUnit(item)} instead of ${item.items_per_order_unit}.\n\n` +
      `OK – keep the physical stock the same (${now} ${nativeUnit(item)} = ${round(now / value)} cases)\n` +
      `Cancel – keep ${round(item.on_hand_qty)} cases (= ${round(item.on_hand_qty * value)} ${nativeUnit(item)})\n\n` +
      `Usage, buffer and max are per case too – check them after.`);
  }
  try {
    await save(item, changes);
    if (changes.convertStock) await loadItems();
    else reset();
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
    reset();
  }
}, true);

tbody.addEventListener('change', async (event) => {
  const tr = event.target.closest('tr');
  if (!tr) return;
  const item = items.find(i => i.id === Number(tr.dataset.id));
  try {
    if (event.target.closest('.useby-cell')) {
      const cell = event.target.closest('.useby-cell');
      const mode = cell.querySelector('.useby-mode').value;
      const daysInput = cell.querySelector('.useby-days');
      daysInput.hidden = mode === 'none';
      daysInput.placeholder = mode === 'pack' ? 'usual days' : 'days';
      const days = daysInput.value === '' ? null : Number(daysInput.value);
      if (mode !== 'none' && days != null && !(days > 0)) { toast('Days must be more than 0.', 'warn'); return; }
      if (mode === 'days' && days == null) { daysInput.focus(); toast('Enter how many days after delivery it keeps.', 'warn'); return; }
      await save(item, mode === 'none'
        ? { track_use_by: 0, shelf_life_days: null }
        : { track_use_by: mode === 'pack' ? 1 : 0, shelf_life_days: days });
    } else if (event.target.classList.contains('active-toggle')) {
      const on = event.target.checked;
      if (!on && !confirm(`Retire ${item.name}? It stops being ordered, counted and offered in lists. You can bring it back with "Show retired items".`)) {
        event.target.checked = true;
        return;
      }
      await save(item, { active: on ? 1 : 0 }, on ? `${item.name} is active again` : `${item.name} retired`);
      renderItems();
    } else if (event.target.classList.contains('edit-category')) {
      await save(item, { category: event.target.value });
      renderFilters();
    }
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
    await loadItems();
  }
});

$('add-item-form').addEventListener('submit', (event) => {
  event.preventDefault();
  busy($('add-item-btn'), async () => {
    const num = (id) => ($(id).value === '' ? null : Number($(id).value));
    const unit = $('new-unit').value.trim();
    try {
      const created = await window.api.post('/api/items', {
        name: $('new-name').value.trim(), category: $('new-category').value.trim(),
        unit_label: unit, supplier_unit: unit, items_per_order_unit: num('new-ipou'),
        price_per_unit: num('new-price'), usage_per_100_sales: num('new-usage') ?? 0, buffer_value: num('new-buffer') ?? 0,
        max_boxes: num('new-max'),
      });
      toast(`${created.name} added.`);
      $('add-item-form').reset();
      activeCategory = created.category;
      await loadItems();
    } catch (err) {
      toast('Not added: ' + err.message, 'error');
    }
  });
});

$('import-csv-btn').addEventListener('click', async () => {
  const csv = $('import-csv').value;
  if (!csv.trim()) return;
  try {
    const result = await window.api.post('/api/items/import', { csv });
    $('import-csv').value = '';
    await loadItems();
    toast(`Imported ${result.imported} row(s).`);
  } catch (err) {
    toast('Failed to import: ' + err.message, 'error');
  }
});

loadItems().catch(err => toast('Failed to load items: ' + err.message, 'error'));
