// Users: admins manage everyone and choose where people work; managers look after the crew at their stores.
const { esc, dayLabel, busy, toast, ROLE_LABELS } = window.ui;
const $ = (id) => document.getElementById(id);
let users = [];
let me = null;
let stores = []; // every store (admins), or just the ones this manager can open
let resetting = null;
let placing = null;

const storeName = (id) => (stores.find(s => s.id === id) || {}).name || '';
const badge = (role) => `<span class="badge ${role === 'crew' ? 'badge-neutral' : 'badge-brand'} no-dot">${ROLE_LABELS[role] || role}</span>`;
const checks = (selected) => stores.filter(s => !s.archived_at).map(s =>
  `<label class="check"><input type="checkbox" value="${s.id}"${selected.includes(s.id) ? ' checked' : ''}> ${esc(s.name)}</label>`).join('') || '<p class="muted">No stores yet.</p>';
const checked = (box) => [...box.querySelectorAll('input:checked')].map(i => Number(i.value));

function render() {
  const admin = me.role === 'admin';
  $('users-table').querySelector('tbody').innerHTML = users.map(u => {
    const removed = !!u.removed_at;
    const self = u.id === me.id;
    const access = admin && u.canManage && !removed
      ? `<select class="user-role" aria-label="Access for ${esc(u.name)}">${['crew', 'manager', 'admin'].map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}</select>`
      : badge(u.role) + (self ? ' <span class="muted">(you)</span>' : '');
    const where = u.role === 'admin' ? '<span class="muted">All stores</span>'
      : esc(u.stores.map(storeName).filter(Boolean).join(', ') || 'None yet');
    const storesCell = admin && u.canManage && !removed && u.role !== 'admin'
      ? `<button type="button" class="btn-secondary btn-sm user-stores" title="Choose which stores they work at">${where}</button>` : where;
    const actions = !u.canManage ? ''
      : removed
        ? '<button type="button" class="btn-secondary btn-sm user-restore">Restore</button>'
        : `<span class="row-actions" style="justify-content:flex-end">
            <button type="button" class="btn-secondary btn-sm user-reset">New password</button>
            <button type="button" class="btn-secondary btn-sm user-signout" title="Ends their sign-in on every device">Sign out</button>
            <button type="button" class="btn-danger btn-sm user-remove">Remove</button></span>`;
    return `<tr data-id="${u.id}"${removed ? ' class="muted"' : ''}>
      <td><span class="cell-title">${esc(u.name)}</span>${removed ? '<span class="cell-sub">Removed – can\'t sign in</span>' : ''}</td>
      <td>${esc(u.email)}</td><td>${access}</td><td>${storesCell}</td>
      <td class="muted nowrap">${u.created_at ? esc(dayLabel(u.created_at.slice(0, 10))) : ''}</td>
      <td class="num">${actions}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="table-empty">No users.</td></tr>';
}

async function load() {
  users = await window.api.get('/api/users');
  render();
}

async function start() {
  me = await window.ui.me();
  if (!window.ui.isManager(me)) return;
  if (me.role === 'admin') {
    stores = await window.api.get('/api/admin/stores');
    $('new-stores').innerHTML = checks(me.storeId ? [me.storeId] : []);
  } else {
    stores = me.stores;
    // Managers add crew, who start at the store they're in.
    [...$('new-role').options].forEach(o => { if (o.value !== 'crew') o.remove(); });
    $('new-store-note').textContent = `They'll be added to ${me.store} as crew. Only an admin can add managers or move people between stores.`;
  }
  syncRoleFields();
  await load();
}

function syncRoleFields() {
  $('new-stores-field').hidden = $('new-role').value === 'admin';
}
$('new-role').addEventListener('change', syncRoleFields);

const userOf = (el) => users.find(u => u.id === Number(el.closest('tr').dataset.id));
const tbody = $('users-table').querySelector('tbody');

tbody.addEventListener('change', async (event) => {
  if (!event.target.classList.contains('user-role')) return;
  const u = userOf(event.target);
  const role = event.target.value;
  if (role === 'admin' && !confirm(`Make ${u.name} an admin? Admins can open every store and manage managers, stores and backups.`)) {
    event.target.value = u.role;
    return;
  }
  try {
    const body = { role };
    // Someone stepping down from admin keeps the store you're in, so they aren't left with none.
    if (u.role === 'admin' && !u.stores.length && me.storeId) body.stores = [me.storeId];
    await window.api.put(`/api/users/${u.id}`, body);
    toast(`${u.name} is now ${role === 'crew' ? 'crew' : 'a' + (role === 'admin' ? 'n admin' : ' manager')}.`);
  } catch (err) {
    toast('Not changed: ' + err.message, 'error');
  }
  await load();
});

tbody.addEventListener('click', async (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;
  const u = userOf(btn);
  try {
    if (btn.classList.contains('user-remove')) {
      if (!confirm(`Remove ${u.name}? They're signed out and can't sign in any more. What they logged keeps their name, and you can restore them later.`)) return;
      await window.api.post(`/api/users/${u.id}/remove`);
      toast(`${u.name} removed.`);
    } else if (btn.classList.contains('user-restore')) {
      await window.api.post(`/api/users/${u.id}/restore`);
      toast(`${u.name} can sign in again.`);
    } else if (btn.classList.contains('user-signout')) {
      await window.api.post(`/api/users/${u.id}/signout`);
      toast(`${u.name} is signed out on every device.`);
      return;
    } else if (btn.classList.contains('user-reset')) {
      resetting = u;
      $('reset-title').textContent = `New password for ${u.name}`;
      $('reset-password').value = '';
      $('password-reset').showModal();
      return;
    } else if (btn.classList.contains('user-stores')) {
      placing = u;
      $('stores-title').textContent = `Where ${u.name} works`;
      $('stores-checks').innerHTML = checks(u.stores);
      $('stores-dialog').showModal();
      return;
    } else {
      return;
    }
  } catch (err) {
    toast('Not done: ' + err.message, 'error');
  }
  await load();
});

$('reset-cancel').addEventListener('click', () => $('password-reset').close());
$('reset-form').addEventListener('submit', (event) => {
  event.preventDefault();
  busy($('reset-save'), async () => {
    try {
      await window.api.post(`/api/users/${resetting.id}/password`, { password: $('reset-password').value });
      $('password-reset').close();
      toast(`New password set for ${resetting.name} – they're signed out everywhere.`);
    } catch (err) {
      toast('Not set: ' + err.message, 'error');
    }
  });
});

$('stores-cancel').addEventListener('click', () => $('stores-dialog').close());
$('stores-form').addEventListener('submit', (event) => {
  event.preventDefault();
  busy($('stores-save'), async () => {
    try {
      await window.api.put(`/api/users/${placing.id}`, { stores: checked($('stores-checks')) });
      $('stores-dialog').close();
      toast(`Stores saved for ${placing.name}.`);
      await load();
    } catch (err) {
      toast('Not saved: ' + err.message, 'error');
    }
  });
});

$('add-user-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const role = $('new-role').value;
  const body = {
    name: $('new-name').value.trim(), email: $('new-email').value.trim(), password: $('new-password').value, role,
  };
  if (me.role === 'admin' && role !== 'admin') {
    body.stores = checked($('new-stores'));
    if (!body.stores.length) { toast('Tick at least one store they work at.', 'warn'); return; }
  }
  busy($('add-user-btn'), async () => {
    try {
      const added = await window.api.post('/api/users', body);
      $('add-user-form').reset();
      if (me.role === 'admin') $('new-stores').innerHTML = checks(me.storeId ? [me.storeId] : []);
      syncRoleFields();
      toast(`${added.name} added as ${ROLE_LABELS[added.role].toLowerCase()}.`);
      await load();
    } catch (err) {
      toast('Not added: ' + err.message, 'error');
    }
  });
});

start().catch(err => toast('Failed to load: ' + err.message, 'error'));
