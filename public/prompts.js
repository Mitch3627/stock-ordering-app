// Open-app catch-up prompts: runs on every page, shows only what is outstanding.
(function () {
  const today = window.ui.todayStr();

  // "Later" lasts for today, for this store (each store has its own reminders).
  let storeKey = '';
  function dismissed(type) {
    try { return localStorage.getItem(`prompt-dismissed:${storeKey}${type}`) === today; } catch (e) { return false; }
  }
  function dismiss(type) {
    try { localStorage.setItem(`prompt-dismissed:${storeKey}${type}`, today); } catch (e) {}
  }
  const esc = window.ui.esc;
  let anyShown = false; // a pop-up was answered, so the bell may need updating

  // Shows a dialog and resolves with the name of the button pressed ('save' / 'skip' / 'later').
  // onSave may return false to keep the dialog open (e.g. a failed request).
  function show(html, { onSave, onAction, onInput } = {}) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'prompt-dialog';
      dialog.innerHTML = html;
      document.body.appendChild(dialog);
      const finish = (result) => { dialog.close(); dialog.remove(); resolve(result); };
      let saving = false;
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); if (!saving) finish('later'); });
      dialog.addEventListener('click', async (e) => {
        const action = e.target.dataset && e.target.dataset.action;
        if (!action || saving) return; // a second click while saving must not save twice
        if (onAction && onAction(action, e.target, dialog)) return;
        if (action === 'save') {
          const form = dialog.querySelector('form');
          if (form && !form.reportValidity()) return;
          if (onSave) {
            saving = true;
            e.target.disabled = true;
            const ok = await onSave(dialog);
            saving = false;
            e.target.disabled = false;
            if (ok === false) return;
          }
        }
        finish(action);
      });
      if (onInput) dialog.addEventListener('input', (e) => onInput(e, dialog));
      dialog.addEventListener('submit', (e) => e.preventDefault()); // Enter in a box mustn't reload the page
      anyShown = true;
      dialog.showModal();
    });
  }

  const label = (d) => (window.ui ? window.ui.dayLabel(d) : d);
  const pounds = (n) => '£' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });

  async function salesPrompt(days, forecasts = {}) {
    const rows = days.map(d => `<label>${esc(label(d))}${forecasts[d] ? ` <small class="muted">(forecast ${pounds(forecasts[d])})</small>` : ''}
      <input type="number" step="0.01" min="0" data-date="${d}" placeholder="Real sales (£)" aria-label="Real sales ${esc(label(d))}"></label>`).join('');
    const result = await show(`
      <form><h2>Real sales</h2>
      <p>Enter the real sales for the days below. Leave a day blank to skip it for now.</p>${rows}</form>
      <div class="row"><button type="button" class="btn-secondary" data-action="later">Not now</button><button type="button" data-action="save">Save sales</button></div>`, {
      onSave: async (dialog) => {
        const entries = [...dialog.querySelectorAll('input[data-date]')]
          .filter(i => i.value !== '').map(i => ({ date: i.dataset.date, actualSales: Number(i.value) }));
        if (entries.length === 0) return true;
        // A figure far from the forecast is usually a typo (an extra 0), and it decides how much stock is used.
        for (const e of entries) {
          const f = forecasts[e.date];
          if (f && (e.actualSales > f * 2 || e.actualSales < f / 2) &&
              !confirm(`${pounds(e.actualSales)} for ${label(e.date)} is a long way from the forecast of ${pounds(f)}. Is it right?`)) return false;
        }
        try { await window.api.put('/api/forecast', { entries }); return true; }
        catch (err) { alert('Failed to save: ' + err.message); return false; }
      },
    });
    if (result === 'later') dismiss('sales');
    return result === 'save';
  }

  async function deliveryPrompt(delivery) {
    const lines = delivery.lines.map((l, i) => `<tr>
      <td>${esc(l.name)}</td>
      <td><input type="number" step="0.01" min="0" value="${l.qty}" data-i="${i}" class="p-qty" aria-label="Cases of ${esc(l.name)}"></td>
      <td>${l.trackUseBy ? `<input type="date" data-i="${i}" class="p-useby" aria-label="Use-by date (optional)">` : ''}</td></tr>`).join('');
    const source = delivery.confirmed
      ? 'These are the quantities on the confirmed order.'
      : '<strong>There was no confirmed order for this delivery – these are only the plan\'s suggestions.</strong> Check each line against the delivery note.';
    const result = await show(`
      <form><h2>Delivery ${esc(label(delivery.date))}</h2>
      <p>Did this delivery arrive? ${source} Correct the cases received (0 for anything that didn't come). Use-by dates can be left blank and added later.</p>
      <label>Arrived on <input type="date" class="p-arrived" value="${esc(delivery.date)}"></label>
      <table><thead><tr><th>Item</th><th>Cases</th><th>Use by</th></tr></thead><tbody>${lines}</tbody></table></form>
      <div class="row"><button type="button" class="btn-secondary" data-action="later">Not now</button>
      ${isManager ? '<button type="button" class="btn-secondary" data-action="skip">Didn\'t arrive</button>' : ''}
      <button type="button" data-action="save">Confirm delivery</button></div>`, {
      onSave: async (dialog) => {
        const out = [];
        delivery.lines.forEach((l, i) => {
          const qty = Number(dialog.querySelector(`.p-qty[data-i="${i}"]`).value);
          if (!(qty > 0)) return;
          const useBy = dialog.querySelector(`.p-useby[data-i="${i}"]`);
          const line = { itemId: l.itemId, qty };
          if (useBy && useBy.value) line.useByDate = useBy.value;
          out.push(line);
        });
        if (out.length === 0) return true;
        const arrived = dialog.querySelector('.p-arrived').value;
        try {
          await window.api.post('/api/deliveries', {
            deliveredAt: delivery.date, arrivedAt: arrived && arrived !== delivery.date ? arrived : undefined, lines: out,
          });
          return true;
        } catch (err) { alert('Failed to save: ' + err.message); return false; }
      },
    });
    if (result === 'skip') {
      await window.api.post('/api/prompts/skip-delivery', { date: delivery.date });
    } else if (result === 'later') {
      dismiss('delivery:' + delivery.date);
    }
    return result === 'save' || result === 'skip';
  }

  async function firstCountPrompt() {
    const result = await show(`
      <h2>First count needed</h2>
      <p>Do a full stock count to set the starting inventory. This count becomes the baseline, not a check against the old figures.</p>
      <div class="row"><button type="button" class="btn-secondary" data-action="later">Not now</button>
      <button type="button" data-action="save">Go to Count</button></div>`);
    if (result === 'later') dismiss('firstcount');
    if (result === 'save') location.href = 'counts.html';
    return false;
  }

  // Batches are typed in the supplier's unit by default (what you actually count); the app converts to order units.
  const perOrder = (n) => (n.items_per_order_unit > 0 ? n.items_per_order_unit : 1);
  const nativeUnit = (n) => n.supplier_unit || n.unit_label || 'units';
  const inNative = (n, orderUnits) => Math.round(orderUnits * perOrder(n) * 100) / 100;

  function batchRow(n, qty) {
    const opts = perOrder(n) !== 1
      ? `<option value="native">${esc(nativeUnit(n))}</option><option value="order">cases of ${perOrder(n)}</option>`
      : `<option value="native">${esc(nativeUnit(n))}</option>`;
    return `<div class="batch-row"><input type="number" step="0.01" min="0" class="b-qty" value="${qty}" aria-label="Quantity">
      <select class="b-unit" aria-label="Unit">${opts}</select>
      <input type="date" class="b-date" aria-label="Use-by date"></div>`;
  }

  async function useByPrompt(needed) {
    // "Total in stock" is everything on hand (dated or not), so typing the real total never adds the dated part twice.
    const blocks = needed.map((n, i) => {
      const dated = n.dated || 0;
      return `<div class="useby-item" data-i="${i}">
        <div class="useby-head"><strong>${esc(n.name)}</strong>
          <label class="stock-edit">Total in stock <input type="number" step="0.01" min="0" class="s-qty" value="${inNative(n, n.onHand)}" data-orig="${inNative(n, n.onHand)}" aria-label="Total ${esc(n.name)} in stock"> <span class="tile-note">${esc(nativeUnit(n))}${dated > 0 ? `, of which ${inNative(n, dated)} already dated` : ''}</span></label></div>
        <div class="batch-labels"><span>Quantity without a date</span><span>Unit</span><span>Use-by date</span></div>
        <div class="batch-rows">${batchRow(n, inNative(n, n.missing))}</div>
        <button type="button" class="btn-link" data-action="addrow" data-i="${i}">+ Add another batch</button></div>`;
    }).join('');
    const result = await show(`
      <form><h2>Use-by dates</h2>
      <p class="tile-note">Enter the quantity and use-by date for each batch that doesn't have a date yet. Use "Add another batch" when stock has more than one date. Leave the date empty to skip an item for now.</p>${blocks}</form>
      <div class="row"><button type="button" class="btn-secondary" data-action="later">Not now</button><button type="button" data-action="save">Save dates</button></div>`, {
      // Correcting the total also updates the first batch row (the stock without a date) so the two stay in step
      onInput: (e, dialog) => {
        if (!e.target.classList.contains('s-qty')) return;
        const box = e.target.closest('.useby-item');
        const n = needed[Number(box.dataset.i)];
        const rows = box.querySelectorAll('.batch-row');
        if (rows.length === 1 && rows[0].querySelector('.b-unit').value === 'native' && e.target.value !== '') {
          rows[0].querySelector('.b-qty').value = Math.max(0, Math.round((Number(e.target.value) - inNative(n, n.dated || 0)) * 100) / 100);
        }
      },
      onAction: (action, target, dialog) => {
        if (action !== 'addrow') return false;
        dialog.querySelector(`.useby-item[data-i="${target.dataset.i}"] .batch-rows`).insertAdjacentHTML('beforeend', batchRow(needed[Number(target.dataset.i)], ''));
        return true;
      },
      onSave: async (dialog) => {
        for (const box of dialog.querySelectorAll('.useby-item')) {
          const item = needed[Number(box.dataset.i)];
          const stock = box.querySelector('.s-qty');
          if (stock && stock.value !== stock.dataset.orig) {
            const qty = Number(stock.value);
            if (stock.value === '' || Number.isNaN(qty) || qty < 0) { alert('Enter the stock for ' + item.name + ' as 0 or more'); return false; }
            try { await window.api.post('/api/batches/undated-stock', { itemId: item.itemId, total: Math.round(qty / perOrder(item) * 1e6) / 1e6 }); stock.dataset.orig = stock.value; }
            catch (err) { alert('Failed to update the stock for ' + item.name + ': ' + err.message); return false; }
          }
          const lines = [...box.querySelectorAll('.batch-row')]
            .map(r => {
              const raw = Number(r.querySelector('.b-qty').value);
              const qty = r.querySelector('.b-unit').value === 'native' ? raw / perOrder(item) : raw;
              return { qty: Math.round(qty * 1e6) / 1e6, useByDate: r.querySelector('.b-date').value };
            })
            .filter(l => l.qty > 0 && l.useByDate);
          if (lines.length === 0) continue;
          try { await window.api.post('/api/batches', { itemId: item.itemId, lines }); }
          catch (err) { alert('Failed to save ' + item.name + ': ' + err.message); return false; }
        }
        return true;
      },
    });
    if (result === 'later') dismiss('useby');
    return result === 'save';
  }

  async function countPrompt() {
    const result = await show(`
      <h2>Weekly count</h2><p>It's count day. Do the weekly stock count so the running inventory can be checked.</p>
      <div class="row"><button type="button" class="btn-secondary" data-action="later">Not now</button>
      <button type="button" data-action="save">Go to Count</button></div>`);
    if (result === 'later') dismiss('count');
    if (result === 'save') location.href = 'counts.html';
  }

  // ---- Notification bell: everything currently due, whether or not it was dismissed today ----
  let bell, badge, panel, latest = null;

  function items(due) {
    const list = [];
    if (due.firstCount && due.firstCount.due) list.push({ label: 'First count needed', open: () => firstCountPrompt() });
    if (due.salesDays.length > 0) {
      list.push({ label: 'Real sales: ' + due.salesDays.length + ' day' + (due.salesDays.length === 1 ? '' : 's'), open: () => salesPrompt(due.salesDays, due.salesForecasts) });
    }
    for (const d of due.deliveries) {
      if (d.lines.length > 0) list.push({ label: 'Delivery ' + window.ui.dayLabel(d.date), open: () => deliveryPrompt(d) });
    }
    if (due.useByNeeded && due.useByNeeded.length > 0) {
      list.push({ label: 'Use-by dates: ' + due.useByNeeded.length + ' item' + (due.useByNeeded.length === 1 ? '' : 's'), open: () => useByPrompt(due.useByNeeded) });
    }
    for (const o of (due.ordersDue || [])) {
      list.push({ label: 'Order due: ' + window.ui.dayLabel(o.deliveryDate), open: async () => { location.href = 'orders.html'; return false; } });
    }
    if (due.weeklyCount.due) list.push({ label: 'Weekly count due', open: () => countPrompt() });
    return list;
  }

  function buildBell() {
    const wrap = document.createElement('span');
    wrap.className = 'menu-wrap';
    bell = document.createElement('button');
    bell.type = 'button';
    bell.className = 'icon-btn bell-btn';
    bell.title = 'Things to do';
    bell.setAttribute('aria-label', 'Things to do');
    bell.setAttribute('aria-expanded', 'false');
    bell.innerHTML = (window.icon ? window.icon('bell') : '&#128276;') + '<span class="bell-badge" hidden></span>';
    badge = bell.querySelector('.bell-badge');
    panel = document.createElement('div');
    panel.className = 'bell-panel';
    panel.hidden = true;
    wrap.appendChild(bell);
    wrap.appendChild(panel);
    (document.getElementById('slot-bell') || document.body).appendChild(wrap);
    const setOpen = (open) => { panel.hidden = !open; bell.setAttribute('aria-expanded', String(open)); };
    bell.addEventListener('click', (e) => { e.stopPropagation(); setOpen(panel.hidden); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    panel.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-idx]');
      if (!btn || !latest) return;
      setOpen(false);
      const changed = await items(latest)[Number(btn.dataset.idx)].open();
      if (changed) location.reload(); else refreshBell();
    });
  }

  function renderBell(due) {
    latest = due;
    const list = items(due);
    badge.hidden = list.length === 0;
    badge.textContent = list.length;
    const arrow = window.icon ? window.icon('arrow', 'icon-sm') : '';
    panel.innerHTML = '<div class="menu-title">Things to do</div>' + (list.length === 0
      ? '<p class="bell-empty">Nothing to do right now.</p>'
      : list.map((it, i) => '<button type="button" class="menu-item" data-idx="' + i + '"><span style="flex:1">' + esc(it.label) + '</span>' + arrow + '</button>').join(''));
  }

  async function refreshBell() {
    try { renderBell(forRole(await window.api.get('/api/prompts'), await window.ui.me().catch(() => null))); } catch (e) {}
  }

  // Crew aren't asked for things only a manager can do: real sales, the first count, placing orders.
  function forRole(due, me) {
    if (window.ui.isManager(me)) return due;
    return { ...due, firstCount: { due: false }, salesDays: [], ordersDue: [] };
  }
  let isManager = false;
  window.ui.me().then(me => { isManager = window.ui.isManager(me); }).catch(() => {});

  async function run() {
    storeKey = await window.ui.me().then(m => (m.storeId && m.stores && m.stores.length > 1 ? m.storeId + ':' : '')).catch(() => '');
    if (!window.api) return;
    buildBell();
    const due = forRole(await window.api.get('/api/prompts'), await window.ui.me().catch(() => null));
    renderBell(due);
    let changed = false;
    if (due.firstCount && due.firstCount.due && !dismissed('firstcount')) await firstCountPrompt();
    if (due.salesDays.length > 0 && !dismissed('sales')) changed = (await salesPrompt(due.salesDays, due.salesForecasts)) || changed;
    for (const d of due.deliveries) {
      if (d.lines.length > 0 && !dismissed('delivery:' + d.date)) changed = (await deliveryPrompt(d)) || changed;
    }
    if (due.useByNeeded && due.useByNeeded.length > 0 && !dismissed('useby')) changed = (await useByPrompt(due.useByNeeded)) || changed;
    if (due.weeklyCount.due && !dismissed('count')) await countPrompt();
    if (changed) location.reload(); // pages show fresh numbers after a catch-up save
    else if (anyShown) refreshBell();
    setInterval(refreshBell, 5 * 60 * 1000);
  }

  window.addEventListener('DOMContentLoaded', () => {
    run().catch(() => {});
  });
})();
