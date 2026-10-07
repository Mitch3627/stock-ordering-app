// Shared page helpers: escaping, units, saving state, messages and the type-to-search item picker.
// Stock is stored in order units ("cases"); people count and type in the supplier's unit (Each, KG, Slice...).
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round = (n, dp = 2) => { const f = 10 ** dp; return Math.round(Number(n) * f) / f; };
  // Today in the UK, whatever time zone the device is set to (UTC would still be yesterday until 1am in summer).
  const ukDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = () => ukDate.format(new Date());
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00Z');
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  // ---- units ----
  const perOrder = (i) => (i && i.items_per_order_unit > 0 ? i.items_per_order_unit : 1);
  const nativeUnit = (i) => (i && (i.supplier_unit || i.unit_label)) || 'units';
  const hasCases = (i) => perOrder(i) !== 1;
  const cases = (n) => `${round(n)} ${Math.abs(round(n)) === 1 ? 'case' : 'cases'}`;
  // the supplier sells some items in packs that differ from the app's case (Hashbrowns: packs of 2.5 KG).
  const packSize = (i) => {
    const p = i && i.supplier_order_pack;
    return p > 0 && Math.abs(p / perOrder(i) - 1) > 0.02 ? p : null;
  };
  const toOrder = (i, qty, unit) => (unit === 'order' ? qty : unit === 'pack' ? qty * packSize(i) / perOrder(i) : qty / perOrder(i));
  const toNative = (i, orderQty) => orderQty * perOrder(i);
  // Cases -> supplier order units (packs) for an item the supplier sells in different packs.
  const toPacks = (i, orderQty) => (packSize(i) ? orderQty * perOrder(i) / packSize(i) : orderQty);
  // "360 Each (2 cases)" - the supplier's unit first, cases alongside when they differ.
  function fmtQty(i, orderQty) {
    const native = `${round(toNative(i, orderQty))} ${nativeUnit(i)}`;
    return hasCases(i) ? `${native} (${cases(orderQty)})` : native;
  }
  // Options for a unit picker: the supplier's unit, cases when a case holds more than one, and the supplier's packs
  // when it sells the item in a different pack (only offered where it makes sense, e.g. receiving deliveries).
  function unitOptions(i, selected = 'native', { packs = false } = {}) {
    const opt = (v, label) => `<option value="${v}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`;
    return opt('native', nativeUnit(i))
      + (hasCases(i) ? opt('order', `cases of ${round(perOrder(i), 3)}`) : '')
      + (packs && packSize(i) ? opt('pack', `Supplier packs of ${round(packSize(i), 3)}`) : '');
  }
  // What a typed quantity means in another unit: "= 0.09 cases" / "= 16 Each".
  function conversionText(i, qty, unit) {
    if (qty === '' || qty == null || Number.isNaN(Number(qty))) return '';
    const orderQty = toOrder(i, Number(qty), unit);
    if (unit === 'native') return hasCases(i) ? `= ${cases(orderQty)}` : '';
    return `= ${round(toNative(i, orderQty))} ${nativeUnit(i)}`;
  }
  // Asks before saving a stock change that looks like a slip: a big jump, or a number that would make more sense
  // in the other unit (16 typed as patties when 16 cases was meant). Returns true to go ahead.
  function confirmStockChange(i, beforeOrder, afterOrder, typed, unit, what = 'the stock') {
    const before = Math.max(0, Number(beforeOrder) || 0);
    const after = Number(afterOrder) || 0;
    if (before === after) return true;
    const big = before > 0 ? Math.abs(after - before) / before > 0.5 : after > 0 && hasCases(i) && after >= 5;
    if (!big) return true;
    let hint = '';
    if (hasCases(i)) {
      const otherOrder = unit === 'order' ? typed / perOrder(i) : typed;
      if (before > 0 && Math.abs(otherOrder - before) / before <= 0.5) {
        hint = unit === 'order'
          ? `\n\nDid you mean ${typed} ${nativeUnit(i)}? If so, press Cancel and pick ${nativeUnit(i)}.`
          : `\n\nDid you mean ${typed} cases? If so, press Cancel and pick cases.`;
      }
    }
    return confirm(`${i.name}: this changes ${what} from ${fmtQty(i, before)} to ${fmtQty(i, after)}.${hint}\n\nSave it?`);
  }

  // ---- saving state and messages ----
  // Runs a save with its button disabled, so a double click can't save twice.
  async function busy(button, fn) {
    if (!button || button.disabled) return undefined;
    const label = button.textContent;
    button.disabled = true;
    button.classList.add('is-busy');
    button.textContent = 'Saving…';
    try {
      return await fn();
    } finally {
      button.disabled = false;
      button.classList.remove('is-busy');
      button.textContent = label;
    }
  }

  let toastBox;
  function toast(message, kind = 'ok') {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'toast-box';
      toastBox.setAttribute('role', 'status');
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    const t = document.createElement('div');
    t.className = 'toast toast-' + kind;
    t.textContent = message;
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 8000 : 4000);
  }

  // ---- type-to-search item picker ----
  // Turns a text input into a searchable list of items (matching the name or the supplier's name).
  // picker.value is the chosen item's id (or null); onPick(item) runs when one is chosen.
  function itemPicker(input, allItems, { onPick, filter } = {}) {
    let items = allItems;
    const list = document.createElement('ul');
    list.className = 'picker-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    input.insertAdjacentElement('afterend', list);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    const wrap = input.parentElement;
    if (wrap) wrap.classList.add('picker-wrap');
    let matches = [];
    let active = -1;
    let chosen = null;

    function search() {
      const q = input.value.trim().toLowerCase();
      const pool = items.filter(i => i.active !== 0 && (!filter || filter(i)));
      matches = (q ? pool.filter(i => i.name.toLowerCase().includes(q) || (i.supplier_name || '').toLowerCase().includes(q)) : pool).slice(0, 40);
      active = matches.length ? 0 : -1;
      render();
    }
    function render() {
      list.innerHTML = matches.length
        ? matches.map((i, n) => `<li role="option" data-n="${n}" class="${n === active ? 'active' : ''}">${esc(i.name)}${i.supplier_name && i.supplier_name !== i.name ? ` <small>${esc(i.supplier_name)}</small>` : ''}</li>`).join('')
        : '<li class="empty">No items match</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      const el = list.querySelector('.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }
    function pick(item) {
      chosen = item;
      input.value = item.name;
      close();
      if (onPick) onPick(item);
    }
    input.addEventListener('focus', search);
    input.addEventListener('input', () => { chosen = null; search(); });
    input.addEventListener('keydown', (e) => {
      if (list.hidden && e.key === 'ArrowDown') { search(); return; }
      if (e.key === 'ArrowDown') { active = Math.min(matches.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (!list.hidden && matches[active]) { pick(matches[active]); e.preventDefault(); } }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-n]');
      if (!li) return;
      e.preventDefault(); // keep focus in the input
      pick(matches[Number(li.dataset.n)]);
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    return {
      get value() { return chosen ? chosen.id : null; },
      get item() { return chosen; },
      clear() { chosen = null; input.value = ''; close(); },
      set(item) { if (item) pick(item); },
      setItems(next) { items = next; },
    };
  }

  // Who is signed in - asked once per page however many scripts want it.
  let mePromise = null;
  const me = () => (mePromise = mePromise || window.api.get('/api/auth/me'));
  // Admins can do everything a manager can.
  const isManager = (m) => !!m && (m.role === 'manager' || m.role === 'admin');
  const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', crew: 'Crew' };
  // Page classes for an access level: admins get the manager controls too.
  const roleClasses = (role) => (role === 'admin' ? ['role-admin', 'role-manager'] : ['role-' + role]);

  window.ui = {
    esc, round, todayStr, dayLabel, addDays, me, isManager, ROLE_LABELS, roleClasses,
    perOrder, nativeUnit, hasCases, cases, packSize, toOrder, toNative, toPacks, fmtQty, unitOptions, conversionText, confirmStockChange,
    busy, toast, itemPicker,
  };
})();
