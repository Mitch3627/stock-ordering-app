// Shows who's signed in (and for which store) at the foot of the sidebar, with change-password and sign-out buttons.
window.addEventListener('DOMContentLoaded', async () => {
  const footer = document.getElementById('sidebar-footer');
  if (!footer) return;
  let me;
  try { me = await window.ui.me(); } catch (e) { return; } // a 401 already redirects to sign-in
  const esc = window.ui.esc;
  const icon = (name, fallback) => (window.icon ? window.icon(name) : fallback);
  const initials = String(me.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  // Crew don't see controls for things only a manager can do (the server refuses them anyway).
  document.body.classList.remove('role-admin', 'role-manager', 'role-crew');
  document.body.classList.add(...window.ui.roleClasses(me.role));
  try { sessionStorage.setItem('role', me.role); } catch (e) { /* fine */ }
  const storeName = document.getElementById('store-name');
  if (storeName) storeName.textContent = me.store || 'No store yet';
  // Someone who works at more than one store (or an admin) switches store here; every page then shows that store.
  if (storeName && me.stores && me.stores.length > 1) {
    const pick = document.createElement('select');
    pick.className = 'store-switch';
    pick.setAttribute('aria-label', 'Store');
    pick.innerHTML = me.stores.map(s => `<option value="${s.id}"${s.id === me.storeId ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    storeName.replaceWith(pick);
    pick.addEventListener('change', async () => {
      try {
        await window.api.post('/api/stores/select', { id: Number(pick.value) });
        location.reload();
      } catch (err) {
        window.ui.toast('Couldn’t switch store: ' + err.message, 'error');
      }
    });
  }
  if (!me.store) window.ui.toast("You haven't been given a store yet – ask an admin to add you to one.", 'warn');
  footer.innerHTML = `<div class="user-card">
      <span class="avatar" aria-hidden="true">${esc(initials)}</span>
      <span class="user-meta"><strong>${esc(me.name)}</strong><small title="${esc(me.email)}">${window.ui.ROLE_LABELS[me.role] || 'Crew'} · ${esc(me.email)}</small></span>
      <button type="button" class="icon-btn session-password" title="Change password" aria-label="Change password">${icon('key', 'Password')}</button>
      <button type="button" class="icon-btn session-logout" title="Sign out" aria-label="Sign out">${icon('logout', 'Sign out')}</button>
    </div>`;
  footer.querySelector('.session-logout').addEventListener('click', async () => {
    try { await window.api.post('/api/auth/logout'); } catch (e) { /* signing out anyway */ }
    try { sessionStorage.removeItem('role'); } catch (e) { /* fine */ }
    location.href = '/login.html';
  });

  // ---- change password ----
  const dialog = document.createElement('dialog');
  dialog.className = 'prompt-dialog';
  dialog.innerHTML = `<form method="dialog">
      <h2>Change password</h2>
      <p>At least 8 characters. You stay signed in here; any other devices are signed out.</p>
      <label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
      <label>New password <input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
      <label>New password again <input type="password" name="again" autocomplete="new-password" minlength="8" required></label>
      <div class="row"><button type="button" class="btn-secondary" data-close>Cancel</button><button type="submit">Change password</button></div>
    </form>`;
  document.body.appendChild(dialog);
  const form = dialog.querySelector('form');
  footer.querySelector('.session-password').addEventListener('click', () => { form.reset(); dialog.showModal(); });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { current, next, again } = form.elements;
    if (next.value !== again.value) { window.ui.toast('The new passwords don’t match.', 'warn'); return; }
    window.ui.busy(form.querySelector('[type="submit"]'), async () => {
      try {
        await window.api.post('/api/auth/change-password', { currentPassword: current.value, newPassword: next.value });
        dialog.close();
        window.ui.toast('Password changed.');
      } catch (err) {
        window.ui.toast('Not changed: ' + err.message, 'error');
      }
    });
  });
});
