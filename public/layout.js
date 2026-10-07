// App shell shared by every page: icon set, sidebar navigation and top bar. A page only provides
// <body data-page data-title data-subtitle> and its content in <main id="page">; this builds the rest,
// so navigation lives in one place.
(function () {
  // 24x24 stroke icons (drawn in the style of the Lucide set).
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6"/><rect x="3" y="15" width="7.5" height="6" rx="1.6"/>',
    stock: '<path d="M21 8.2 12 3.5 3 8.2v7.6l9 4.7 9-4.7z"/><path d="m3.4 8.1 8.6 4.6 8.6-4.6"/><path d="M12 12.7v7.6"/>',
    truck: '<path d="M2.5 6.5h11.5v9.5H2.5z"/><path d="M14 9.5h4l3.5 3.7v2.8H14"/><circle cx="7" cy="17.6" r="1.9"/><circle cx="17.5" cy="17.6" r="1.9"/>',
    waste: '<path d="M3.5 6.5h17"/><path d="M8.5 6.5V4.8c0-.9.7-1.6 1.6-1.6h3.8c.9 0 1.6.7 1.6 1.6v1.7"/><path d="m5.8 6.5.9 12.8c.1 1 .9 1.8 1.9 1.8h6.8c1 0 1.8-.8 1.9-1.8l.9-12.8"/><path d="M10 10.5v6M14 10.5v6"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 1.6"/><path d="M9.5 2.8h5"/><path d="m18.6 6.9 1.3-1.3"/>',
    count: '<rect x="7.5" y="3" width="9" height="4" rx="1.1"/><path d="M7.5 5H6.2A2.2 2.2 0 0 0 4 7.2v11.6A2.2 2.2 0 0 0 6.2 21h11.6a2.2 2.2 0 0 0 2.2-2.2V7.2A2.2 2.2 0 0 0 17.8 5h-1.3"/><path d="m8.8 13.8 2.3 2.3 4.2-4.6"/>',
    cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2.5 3.5h2.7l2.4 11.4a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.6-1.2L21 7.5H6.1"/>',
    chart: '<path d="M3.5 3.5v17h17"/><path d="m7.5 14.5 3.8-4 3.2 3 5-6"/>',
    list: '<path d="M9 6h11.5M9 12h11.5M9 18h11.5"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    bell: '<path d="M6.2 9a5.8 5.8 0 0 1 11.6 0c0 6.4 2.7 8.2 2.7 8.2h-17S6.2 15.4 6.2 9z"/><path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    moon: '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.6 6.6 0 0 0 10.7 10.7z"/>',
    logout: '<path d="M9.5 20.5H6a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 6 3.5h3.5"/><path d="m15.5 16.5 4.5-4.5-4.5-4.5"/><path d="M20 12H9.5"/>',
    settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18.5 15.3c1.7.8 2.8 2.6 3 5.2"/>',
    key: '<circle cx="7.5" cy="15.5" r="4"/><path d="m10.5 12.5 9-9"/><path d="m16.5 6.5 3 3"/><path d="m14 9 2 2"/>',
    edit: '<path d="M12.5 20.5h8"/><path d="M16.8 3.6a2.1 2.1 0 0 1 3 3L7.5 18.9l-4 1 1-4z"/>',
    check: '<path d="M20 6.5 9 17.5l-5-5"/>',
    menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
    store: '<path d="M4.5 10.5V20h15v-9.5"/><path d="M3 7.5 5 3.5h14l2 4v1a3 3 0 0 1-5.4 1.8A3 3 0 0 1 12 11.5a3 3 0 0 1-3.6-1.2A3 3 0 0 1 3 8.5z"/><path d="M9.5 20v-5h5v5"/>',
    alert: '<path d="M10.4 4.1 2.2 18a1.9 1.9 0 0 0 1.6 2.8h16.4a1.9 1.9 0 0 0 1.6-2.8L13.6 4.1a1.9 1.9 0 0 0-3.2 0z"/><path d="M12 9.5v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16.5v-5M12 7.8h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.2"/><path d="M15.5 8.5V5.7a2.2 2.2 0 0 0-2.2-2.2H5.7a2.2 2.2 0 0 0-2.2 2.2v7.6a2.2 2.2 0 0 0 2.2 2.2h2.8"/>',
    arrow: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
    calendar: '<rect x="3.5" y="4.8" width="17" height="15.7" rx="2.2"/><path d="M3.5 9.5h17M8 3v3.4M16 3v3.4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    up: '<path d="m3.5 16.5 6-6 4 4 7-7"/><path d="M14.5 7.5h6v6"/>',
    down: '<path d="m3.5 7.5 6 6 4-4 7 7"/><path d="M14.5 16.5h6v-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    download: '<path d="M12 3.5v11.5M7 10.5l5 5 5-5"/><path d="M4.5 20.5h15"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    print: '<path d="M6.5 9V3.5h11V9"/><rect x="3.5" y="9" width="17" height="7.5" rx="2"/><path d="M6.5 14h11v6.5h-11z"/>',
  };
  const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.icon = icon;
  if (window.ui) window.ui.icon = icon;

  const sprite = document.createElement('div');
  sprite.style.display = 'none';
  sprite.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${Object.entries(ICONS).map(([k, v]) =>
    `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`).join('')}</svg>`;
  document.body.insertBefore(sprite, document.body.firstChild);

  const body = document.body;
  // Access level from the last page, so manager-only controls don't flicker in (session.js confirms it).
  try {
    const role = sessionStorage.getItem('role');
    if (role) body.classList.add(...(role === 'admin' ? ['role-admin', 'role-manager'] : ['role-' + role]));
  } catch (e) { /* fine */ }
  const main = document.getElementById('page');
  if (!main || !body.dataset.page) return; // e.g. the sign-in page draws its own layout

  const NAV = [
    { items: [{ page: 'home', href: 'home.html', label: 'Dashboard', icon: 'dashboard' }] },
    { group: 'Stock', items: [
      { page: 'inventory', href: 'inventory.html', label: 'Stock on hand', icon: 'stock' },
      { page: 'deliveries', href: 'deliveries.html', label: 'Deliveries', icon: 'truck' },
      { page: 'waste', href: 'waste.html', label: 'Waste', icon: 'waste' },
      { page: 'batches', href: 'batches.html', label: 'Use-by dates', icon: 'timer' },
      { page: 'counts', href: 'counts.html', label: 'Stock count', icon: 'count' },
    ] },
    { group: 'Ordering', items: [
      { page: 'orders', href: 'orders.html', label: 'Order plan', icon: 'cart' },
      { page: 'usage', href: 'usage.html', label: 'Usage rates', icon: 'chart' },
    ] },
    { group: 'Setup', items: [
      { page: 'items', href: 'index.html', label: 'Item master', icon: 'list' },
      { page: 'settings', href: 'settings.html', label: 'Settings', icon: 'settings', manager: true },
      { page: 'users', href: 'users.html', label: 'Users', icon: 'users', manager: true },
      { page: 'admin', href: 'admin.html', label: 'Admin', icon: 'shield', admin: true },
    ] },
  ];
  const current = body.dataset.page;
  const navHtml = NAV.map(g => (g.group ? `<div class="nav-group">${esc(g.group)}</div>` : '') + g.items.map(it =>
    `<a class="nav-link${it.page === current ? ' active' : ''}${it.manager ? ' manager-only' : ''}${it.admin ? ' admin-only' : ''}" href="${it.href}"${it.page === current ? ' aria-current="page"' : ''}>${icon(it.icon)}<span>${esc(it.label)}</span></a>`).join('')).join('');

  const todayIso = window.ui ? window.ui.todayStr() : new Date().toISOString().slice(0, 10);
  const today = (window.ui ? window.ui.dayLabel(todayIso) : todayIso) + ' ' + todayIso.slice(0, 4);
  const title = body.dataset.title || document.title;
  const subtitle = body.dataset.subtitle || '';

  const app = document.createElement('div');
  app.className = 'app';
  app.innerHTML = `
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <a class="brand" href="home.html" aria-label="Stock & Ordering – dashboard">
        <span class="brand-mark">S</span>
        <span class="brand-text"><strong>Stock &amp; Ordering</strong><small>Restaurant stock tool</small></span>
      </a>
      <div class="store-chip">${icon('store')}<div class="store-chip-text"><span id="store-name">Your restaurant</span><small>Current store</small></div></div>
      <nav class="nav">${navHtml}</nav>
      <div class="sidebar-footer" id="sidebar-footer"></div>
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim"></div>
    <div class="main-col">
      <header class="topbar">
        <button type="button" class="icon-btn nav-toggle" id="nav-toggle" aria-label="Open the menu" aria-controls="sidebar">${icon('menu')}</button>
        <div class="page-heading"><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        <div class="topbar-actions">
          <span id="slot-edit"></span>
          <span class="date-chip">${icon('calendar')}<span>${esc(today)}</span></span>
          <span id="slot-bell"></span>
          <span id="slot-theme"></span>
        </div>
      </header>
      <div class="edit-banner" role="status">${icon('edit', 'icon-sm')}<span>Editing – changes save as you make them. Press Done when you've finished.</span></div>
      <div class="content" id="content"></div>
    </div>`;
  body.insertBefore(app, sprite.nextSibling);
  app.querySelector('#content').appendChild(main);
  document.title = `${title} · Stock & Ordering`;

  const toggle = app.querySelector('#nav-toggle');
  const setOpen = (open) => {
    body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(!body.classList.contains('nav-open')));
  app.querySelector('#sidebar-scrim').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
})();
