// Admin: stores (add, rename, archive, back up), the activity log and signing everyone out.
const { esc, dayLabel, busy, toast } = window.ui;
const $ = (id) => document.getElementById(id);
let stores = [];
let me = null;
let renaming = null;

const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  return `${esc(dayLabel(day))} ${time}`;
};

function renderStores() {
  const open = stores.filter(s => !s.archived_at);
  $('stores-table').querySelector('tbody').innerHTML = stores.map(s => {
    const archived = !!s.archived_at;
    const actions = archived
      ? '<button type="button" class="btn-secondary btn-sm store-restore">Restore</button>'
      : `<a class="btn btn-secondary btn-sm" href="/api/admin/stores/${s.id}/backup" download title="Download a copy of this store's data as it is now">Backup</a>
         <button type="button" class="btn-secondary btn-sm store-rename">Rename</button>
         ${open.length > 1 ? '<button type="button" class="btn-danger btn-sm store-archive">Archive</button>' : ''}`;
    return `<tr data-id="${s.id}"${archived ? ' class="muted"' : ''}>
      <td><span class="cell-title">${esc(s.name)}</span>${s.id === me.storeId ? '<span class="cell-sub">You\'re in this store</span>' : ''}${archived ? '<span class="cell-sub">Archived – hidden from everyone, data kept</span>' : ''}</td>
      <td class="num">${s.people}</td>
      <td class="muted nowrap">${s.created_at ? esc(dayLabel(s.created_at.slice(0, 10))) : ''}</td>
      <td class="num"><span class="row-actions" style="justify-content:flex-end">${actions}</span></td></tr>`;
  }).join('');
  $('store-copy').innerHTML = '<option value="">Empty – set it up from scratch</option>'
    + open.map(s => `<option value="${s.id}"${s.id === me.storeId ? ' selected' : ''}>Copy ${esc(s.name)}'s items and settings</option>`).join('');
  const current = Number($('activity-store').value) || me.storeId;
  $('activity-store').innerHTML = open.map(s => `<option value="${s.id}"${s.id === current ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
}

async function loadStores() {
  stores = await window.api.get('/api/admin/stores');
  renderStores();
}

async function loadActivity() {
  const tbody = $('activity-table').querySelector('tbody');
  try {
    const data = await window.api.get(`/api/admin/activity?store=${Number($('activity-store').value) || me.storeId}&days=${$('activity-days').value}`);
    tbody.innerHTML = data.rows.map(r => `<tr>
        <td class="when">${when(r.at)}</td><td>${esc(r.who)}</td><td class="what">${esc(r.action)}</td><td>${esc(r.detail || '')}</td></tr>`).join('')
      || '<tr><td colspan="4" class="table-empty">Nothing in this period.</td></tr>';
  } catch (err) {
    toast('Activity didn’t load: ' + err.message, 'error');
  }
}

$('stores-table').addEventListener('click', async (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;
  const s = stores.find(x => x.id === Number(btn.closest('tr').dataset.id));
  try {
    if (btn.classList.contains('store-rename')) {
      renaming = s;
      $('rename-name').value = s.name;
      $('rename-dialog').showModal();
      return;
    } else if (btn.classList.contains('store-archive')) {
      if (!confirm(`Archive ${s.name}? Nobody will see it (including you) until it's restored. Nothing is deleted.`)) return;
      await window.api.post(`/api/admin/stores/${s.id}/archive`);
      toast(`${s.name} archived.`);
      if (s.id === me.storeId) { location.reload(); return; }
    } else if (btn.classList.contains('store-restore')) {
      await window.api.post(`/api/admin/stores/${s.id}/restore`);
      toast(`${s.name} is open again.`);
    } else {
      return;
    }
  } catch (err) {
    toast('Not done: ' + err.message, 'error');
  }
  await loadStores();
});

$('rename-cancel').addEventListener('click', () => $('rename-dialog').close());
$('rename-form').addEventListener('submit', (event) => {
  event.preventDefault();
  busy($('rename-save'), async () => {
    try {
      await window.api.put(`/api/admin/stores/${renaming.id}`, { name: $('rename-name').value.trim() });
      $('rename-dialog').close();
      toast('Store renamed.');
      if (renaming.id === me.storeId) { location.reload(); return; }
      await loadStores();
    } catch (err) {
      toast('Not renamed: ' + err.message, 'error');
    }
  });
});

$('add-store-form').addEventListener('submit', (event) => {
  event.preventDefault();
  busy($('add-store-btn'), async () => {
    try {
      const created = await window.api.post('/api/admin/stores', {
        name: $('store-name-new').value.trim(), copyFrom: Number($('store-copy').value) || null,
      });
      $('add-store-form').reset();
      toast(`${created.name} added. Refresh to see it in the store switcher, and add its people on the Users page.`);
      await loadStores();
    } catch (err) {
      toast('Not added: ' + err.message, 'error');
    }
  });
});

$('activity-store').addEventListener('change', loadActivity);
$('activity-days').addEventListener('change', loadActivity);

$('signout-all').addEventListener('click', async () => {
  if (!confirm('Sign everyone else out on every device? They sign in again with their passwords.')) return;
  try {
    const { ended } = await window.api.post('/api/admin/signout-all');
    toast(`${ended} sign-in${ended === 1 ? '' : 's'} ended.`);
    await loadActivity();
  } catch (err) {
    toast('Not done: ' + err.message, 'error');
  }
});

(async () => {
  me = await window.ui.me();
  if (me.role !== 'admin') return;
  await loadStores();
  await loadActivity();
})().catch(err => toast('Failed to load: ' + err.message, 'error'));
