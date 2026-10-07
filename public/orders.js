const { esc, round, dayLabel, fmtQty, packSize, toPacks, nativeUnit, busy, toast } = window.ui;
const $ = (id) => document.getElementById(id);
const pounds = (n) => '£' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });

function todayStr() { return ui.todayStr(); }
function addDays(dateStr, n) { return ui.addDays(dateStr, n); }

// ---- sales forecast and real sales ----
// Last 7 days (real sales can be entered for these) plus today and the next 13 (projections).
async function initForecast() {
  const today = todayStr();
  const from = addDays(today, -7);
  const to = addDays(today, 13);
  const existing = await window.api.get(`/api/forecast?from=${from}&to=${to}`);
  const byDate = Object.fromEntries(existing.map(e => [e.date, e]));
  const dates = [];
  for (let i = -7; i <= 13; i++) dates.push(addDays(today, i));
  document.querySelector('#forecast-table tbody').innerHTML = dates.map(date => {
    const row = byDate[date] || {};
    const isPast = date < today;
    return `<tr data-date="${date}"${isPast ? ' class="past-day"' : ''}>
      <td class="nowrap"><span class="cell-title">${esc(dayLabel(date))}</span>${date === today ? ' <span class="badge badge-brand no-dot">Today</span>' : ''}</td>
      <td><input type="number" min="0" class="forecast-input" value="${row.forecasted_sales ?? ''}" aria-label="Projected sales ${esc(dayLabel(date))}"></td>
      <td>${isPast
        ? `<input type="number" min="0" class="actual-input" value="${row.actual_sales ?? ''}" data-orig="${row.actual_sales ?? ''}" aria-label="Real sales ${esc(dayLabel(date))}">`
        : '<span class="muted">After the day</span>'}</td>
    </tr>`;
  }).join('');
}

$('save-forecast').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  const entries = [];
  for (const tr of document.querySelectorAll('#forecast-table tbody tr')) {
    const date = tr.dataset.date;
    const entry = { date };
    const forecast = tr.querySelector('.forecast-input').value;
    if (forecast !== '') entry.forecastedSales = Number(forecast);
    const actualInput = tr.querySelector('.actual-input');
    if (actualInput && actualInput.value !== actualInput.dataset.orig) {
      if (actualInput.value === '') {
        if (!confirm(`Remove the real sales for ${dayLabel(date)} (${pounds(actualInput.dataset.orig)})? The stock used that day is put back and the day will be asked for again.`)) return;
        entry.clearActual = true;
      } else {
        const actual = Number(actualInput.value);
        const expected = Number(forecast) || null;
        // A figure far from the forecast is usually a typo (an extra 0) - and it decides how much stock is used.
        if (expected && (actual > expected * 2 || actual < expected / 2)) {
          const ratio = actual > expected ? `${round(actual / expected, 1)}× the` : `under half the`;
          if (!confirm(`${pounds(actual)} for ${dayLabel(date)} is ${ratio} forecast of ${pounds(expected)}. Is it right?`)) return;
        }
        entry.actualSales = actual;
      }
    }
    if (entry.forecastedSales !== undefined || entry.actualSales !== undefined || entry.clearActual) entries.push(entry);
  }
  let result;
  try {
    result = await window.api.put('/api/forecast', { entries });
  } catch (err) {
    toast('Not saved: ' + err.message, 'error');
    return;
  }
  const messages = ['Forecast saved.'];
  if (result.decayedDates.length) messages.push(`Real sales for ${result.decayedDates.map(dayLabel).join(', ')} applied to stock.`);
  for (const c of result.correctedDates || []) {
    messages.push(c.stockChanged
      ? `${dayLabel(c.date)} corrected from ${pounds(c.from)} to ${pounds(c.to)} – stock adjusted to match.`
      : `${dayLabel(c.date)} corrected to ${pounds(c.to)} (before the last count, so stock is unchanged).`);
  }
  if ((result.clearedDates || []).length) messages.push(`Real sales removed for ${result.clearedDates.map(dayLabel).join(', ')}.`);
  toast(messages.join(' '));
  await initForecast();
  await loadPlan();
}));

// ---- delivery plan ----
let lastPlan = null;
let view = 'next';
try { view = localStorage.getItem('ordersView') || 'next'; } catch (e) {}
let drafts = {}; // delivery date -> { itemId: qty } while that delivery's order is being edited
let compare = false; // show the plan's own suggestion next to confirmed and edited orders
try { compare = localStorage.getItem('ordersCompare') === '1'; } catch (e) {}

const money = (n) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function qtyFor(plan, item, c) {
  const draft = drafts[plan.deliveries[c]];
  return draft ? (draft[item.id] ?? 0) : item.qtys[c];
}

function draftCost(plan, date) {
  const draft = drafts[date];
  return plan.items.reduce((sum, it) => sum + (draft[it.id] || 0) * (it.price || 0), 0);
}

// "Supplier: 10 × 2.5 KG" for items the supplier sells in packs that differ from the app's case.
function supplierQty(item, qty) {
  const pack = packSize(item);
  if (!pack || !(qty > 0)) return '';
  return `<span class="nc-qty">Supplier: ${round(toPacks(item, qty), 2)} × ${round(pack, 3)} ${esc(nativeUnit(item))}</span>`;
}

// ---- compare with the plan's own suggestion ----
// For a confirmed order: what the plan would have ordered instead, from the stock expected when it arrives.
function suggestedQty(item, c) {
  const s = item.explain[c].suggested;
  return s ? s.order : item.qtys[c];
}

// Only deliveries whose quantities aren't the plan's own have anything to compare: confirmed or being edited.
function comparing(plan, c) {
  const date = plan.deliveries[c];
  return compare && (!!drafts[date] || plan.confirmedDates.includes(date));
}

function differs(ordered, suggested) { return Math.abs(ordered - suggested) > 1e-6; }

function suggCell(item, c, ordered) {
  const s = suggestedQty(item, c);
  const d = round(ordered - s, 2);
  const chip = d === 0 ? ''
    : `<span class="badge ${d > 0 ? 'badge-warn' : 'badge-info'} no-dot" title="Ordered ${d > 0 ? 'more' : 'less'} than suggested">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`;
  return `${s}${chip}`;
}

function compareSummary(plan, c) {
  let cost = 0;
  let lines = 0;
  for (const it of plan.items) {
    const s = suggestedQty(it, c);
    cost += s * (it.price || 0);
    if (differs(qtyFor(plan, it, c), s)) lines++;
  }
  return `Suggested order £${money(cost)} · ${lines ? `${lines} line${lines === 1 ? '' : 's'} differ` : 'same as the order'}`;
}

function costCellHtml(plan, c, cost) {
  const over = cost > plan.targetCost ? ' <span class="badge badge-bad">Over target</span>' : '';
  return `£${money(cost)}${over}${comparing(plan, c) ? `<span class="cell-sub sugg-line">${esc(compareSummary(plan, c))}</span>` : ''}`;
}

function statusBadge(plan, c) {
  const date = plan.deliveries[c];
  if (drafts[date]) return '<span class="badge badge-info">Editing</span>';
  return plan.confirmedDates.includes(date) ? '<span class="badge badge-ok">Confirmed</span>' : '<span class="badge badge-neutral">Planned</span>';
}

// compact: the narrow 4-week columns - short labels, Edit and Copy as icons
function actionButtons(plan, c, compact = false) {
  const date = plan.deliveries[c];
  const confirmed = plan.confirmedDates.includes(date);
  const confirmLabel = compact ? 'Confirm' : 'Confirm order';
  const secondary = (act, iconName, label, title) => compact
    ? `<button type="button" class="btn-secondary btn-square${act === 'edit' ? ' manager-only' : ''}" data-act="${act}" data-date="${date}" title="${title}" aria-label="${title}">${window.icon(iconName, 'icon-sm')}</button>`
    : `<button type="button" class="btn-secondary${act === 'edit' ? ' manager-only' : ''}" data-act="${act}" data-date="${date}" title="${title}">${iconName === 'copy' ? window.icon('copy', 'icon-sm') : ''}${label}</button>`;
  if (drafts[date]) {
    return `<button type="button" class="manager-only" data-act="confirm" data-date="${date}">${confirmLabel}</button><button type="button" class="btn-ghost manager-only" data-act="cancel" data-date="${date}">Cancel</button>`;
  }
  const main = confirmed
    ? `<button type="button" class="btn-secondary manager-only" data-act="unconfirm" data-date="${date}">Unconfirm</button>`
    : `<button type="button" class="manager-only" data-act="confirm" data-date="${date}">${confirmLabel}</button>`;
  return secondary('edit', 'edit', 'Edit', 'Edit this order') + main + secondary('copy', 'copy', 'Copy', 'Copy this order for the supplier');
}

function columnHeader(plan, c) {
  const date = plan.deliveries[c];
  return `<th data-col="${c}"><div class="row" style="gap:8px"><span class="col-date">${esc(dayLabel(date))}</span>${statusBadge(plan, c)}</div>
    <div class="col-sub">Order by ${esc(dayLabel(plan.orderBy[c]))}</div>
    <div class="col-actions">${actionButtons(plan, c, true)}</div></th>`;
}

// Cases, with the supplier's units underneath.
function casesCell(item, n) {
  const cases = round(n, 2);
  return ui.hasCases(item)
    ? `${cases}<span class="cell-sub">${round(ui.toNative(item, n))} ${esc(nativeUnit(item))}</span>`
    : `${cases}<span class="cell-sub">${esc(nativeUnit(item))}</span>`;
}

function costBlock(plan, cost) {
  const pct = Math.round(cost / plan.targetCost * 100);
  const cls = cost > plan.targetCost ? 'over' : pct > 90 ? 'near' : '';
  return `<div class="cost-line"><span>Estimated cost</span><strong id="sheet-cost">£${money(cost)}</strong></div>
    <div class="meter ${cls}" id="sheet-meter"><span style="width:${Math.min(100, pct)}%"></span></div>
    <div class="cost-line"><small>Target £${Number(plan.targetCost).toLocaleString('en-GB')}</small><small id="sheet-pct">${pct}%</small></div>`;
}

function addItemRow(dates, colspan) {
  if (dates.length === 0) return '';
  return `<tr class="add-row"><td colspan="${colspan}"><div class="row">` + dates.map(date =>
    `<label class="field" style="flex:0 1 360px"><span>Add an item to ${esc(dayLabel(date))}</span><span class="picker-wrap"><input type="text" class="add-item" data-date="${date}" placeholder="Type to search…"></span></label>`).join('') + '</div></td></tr>';
}

// Next delivery: an order sheet - stock expected when it arrives, what's needed, the order and its cost.
function renderSheet(plan) {
  const date = plan.deliveries[0];
  const draft = drafts[date];
  const cmp = comparing(plan, 0);
  const cost = draft ? draftCost(plan, date) : plan.costs[0];
  $('orders-bar').innerHTML = `<div class="delivery-bar">
      <div class="when"><strong>${esc(dayLabel(date))}</strong><small>Order by ${esc(dayLabel(plan.orderBy[0]))}${plan.cover && plan.cover[0] ? ` · lasts to ${esc(dayLabel(plan.cover[0].to))}` : ''}</small></div>
      ${statusBadge(plan, 0)}
      <div class="cost">${costBlock(plan, cost)}${cmp ? `<div class="compare-line" id="compare-summary">${esc(compareSummary(plan, 0))}</div>` : ''}</div>
      <div class="col-actions">${actionButtons(plan, 0)}</div>
    </div>`;
  // Comparing also lists what the plan would order that isn't on the order.
  const rows = plan.items.filter(it => (draft ? it.id in draft : it.qtys[0] > 0) || (cmp && suggestedQty(it, 0) > 0));
  const head = '<tr><th>Item</th><th class="num">Expected when it arrives</th><th class="num" title="Forecast use from when this delivery arrives until the next one does, plus the safety buffer">Needed until next delivery</th><th class="num">Order (cases)</th>'
    + (cmp ? '<th class="num" title="What the plan works out from the stock expected when this delivery arrives">Suggested</th>' : '')
    + '<th class="num">On hand after</th><th class="num">Cost</th></tr>';
  const body = rows.map(it => {
    const step = it.explain[0];
    const q = draft ? (draft[it.id] ?? 0) : it.qtys[0];
    const order = draft
      ? `<input type="number" min="0" step="1" class="draft-qty" data-date="${date}" data-item="${it.id}" value="${q}" aria-label="Cases of ${esc(it.name)}">`
      : `<button type="button" class="qty-link" data-item="${it.id}" data-col="0" title="How was this worked out?">${q}</button>`;
    return `<tr data-item="${it.id}"${cmp && differs(q, suggestedQty(it, 0)) ? ' class="differs"' : ''}><td><span class="cell-title">${esc(it.name)}</span><span class="cell-sub">${esc(it.category)}</span></td>
      <td class="num">${casesCell(it, step.before)}</td>
      <td class="num">${casesCell(it, step.target)}</td>
      <td class="num">${order}${supplierQty(it, q)}</td>
      ${cmp ? `<td class="num sugg-cell">${suggCell(it, 0, q)}</td>` : ''}
      <td class="num">${draft ? '<span class="muted">—</span>' : casesCell(it, it.stockAfter[0])}</td>
      <td class="num line-cost">${it.price ? '£' + money(q * it.price) : '<span class="badge badge-warn no-dot">No price</span>'}</td></tr>`;
  }).join('');
  const cols = cmp ? 7 : 6;
  const empty = rows.length ? '' : `<tr><td colspan="${cols}" class="table-empty">Nothing needs ordering for this delivery.</td></tr>`;
  const table = $('orders-table');
  table.className = 'order-sheet';
  table.innerHTML = `<thead>${head}</thead><tbody>${body}${empty}${addItemRow(draft ? [date] : [], cols)}</tbody>`;
}

// Next four weeks: every delivery side by side.
function renderMatrix(plan) {
  $('orders-bar').innerHTML = '';
  const cols = plan.deliveries.map((_, i) => i);
  const header = '<tr><th>Item</th>' + cols.map(c => columnHeader(plan, c)).join('') + '</tr>';
  const body = plan.items.map(item => {
    const cells = cols.map(c => {
      const date = plan.deliveries[c];
      const s = comparing(plan, c) ? suggestedQty(item, c) : null;
      if (drafts[date]) {
        const q = drafts[date][item.id] ?? 0;
        return `<td><input type="number" min="0" step="1" class="draft-qty" data-date="${date}" data-item="${item.id}" value="${q}" aria-label="${esc(item.name)} for ${esc(dayLabel(date))}">${supplierQty(item, q)}${s != null ? `<span class="proj sugg-line">suggested ${s}</span>` : ''}</td>`;
      }
      const q = item.qtys[c];
      const diff = s != null && differs(q, s);
      return `<td${diff ? ' class="differs"' : ''}><button type="button" class="qty-link${q > 0 ? '' : ' qty-zero'}" data-item="${item.id}" data-col="${c}" title="How was this worked out?">${q > 0 ? q : '–'}</button>${supplierQty(item, q)}${diff ? `<span class="proj sugg-line">suggested ${s}</span>` : ''}<span class="proj" title="Projected stock once this delivery has arrived">${item.stockAfter[c]} after</span></td>`;
    }).join('');
    return `<tr><td>${esc(item.name)}<span class="cell-sub">${esc(item.category)}</span></td>${cells}</tr>`;
  }).join('');
  const costCells = cols.map(c => {
    const date = plan.deliveries[c];
    const cost = drafts[date] ? draftCost(plan, date) : plan.costs[c];
    return `<td class="cost-cell${cost > plan.targetCost ? ' cost' : ''}" data-date="${date}">${costCellHtml(plan, c, cost)}</td>`;
  }).join('');
  const costRow = `<tr class="cost-row"><td>Estimated cost <span class="cell-sub">Target £${Number(plan.targetCost).toLocaleString('en-GB')} per delivery</span></td>${costCells}</tr>`;
  const table = $('orders-table');
  table.className = '';
  table.innerHTML = `<thead>${header}</thead><tbody>${body}${addItemRow(plan.deliveries.filter(d => drafts[d]), cols.length + 1)}${costRow}</tbody>`;
}

function renderPlan(plan) {
  if (view === 'next') renderSheet(plan); else renderMatrix(plan);
  // type-to-search pickers for adding items to an order being edited
  for (const input of document.querySelectorAll('#orders-table .add-item')) {
    const date = input.dataset.date;
    ui.itemPicker(input, plan.items.filter(it => !(it.id in drafts[date])), {
      onPick: (item) => { drafts[date][item.id] = 1; renderPlan(lastPlan); },
    });
  }
  renderBanner(plan);
  renderMoves(plan);
}

function renderBanner(plan) {
  const today = todayStr();
  const idx = plan.deliveries.findIndex((d, i) => plan.orderBy[i] <= today && d > today && !plan.confirmedDates.includes(d));
  const el = $('order-banner');
  el.hidden = idx < 0;
  if (idx >= 0) {
    el.innerHTML = `${window.icon('alert')}<span><strong>Order due.</strong> The order for ${esc(dayLabel(plan.deliveries[idx]))} should be placed now (order by ${esc(dayLabel(plan.orderBy[idx]))}). Check the quantities, place it in the supplier system, then press <em>Confirm order</em>.</span>`;
  }
}

function renderMoves(plan) {
  const movesEl = $('orders-moves');
  const itemsById = Object.fromEntries(plan.items.map(i => [i.id, i]));
  const moves = (plan.moves || []).filter(m => view === 'all' || m.fromIndex === 0 || m.toIndex === 0);
  if (moves.length === 0) {
    movesEl.innerHTML = 'No orders were moved between deliveries to balance costs.';
  } else {
    const lines = moves.map(m => {
      const name = itemsById[m.itemId] ? itemsById[m.itemId].name : `Item ${m.itemId}`;
      return `<li>${esc(name)} moved from ${esc(dayLabel(plan.deliveries[m.fromIndex]))} to ${esc(dayLabel(plan.deliveries[m.toIndex]))} (to keep delivery cost near the £${plan.targetCost} target)</li>`;
    });
    movesEl.innerHTML = `<strong>Moved to balance delivery costs:</strong><ul style="margin:6px 0 0;padding-left:18px">${lines.join('')}</ul>`;
  }
}

// ---- why this quantity ----
function explainHtml(plan, item, c) {
  const step = item.explain[c];
  const date = plan.deliveries[c];
  const cover = plan.cover[c];
  const q = (n) => esc(fmtQty(item, n));
  const rows = [];
  const add = (label, value, total = false) => rows.push(`<li${total ? ' class="total"' : ''}><span>${label}</span><span class="v">${value}</span></li>`);
  if (c === 0) {
    const s = item.start;
    add('Stock now', q(s.now));
    if (s.pending) add('+ confirmed orders not received yet', q(s.pending));
    if (plan.bridge.days) add(`&minus; usage until then (${plan.bridge.days} day${plan.bridge.days === 1 ? '' : 's'}, ${pounds(plan.bridge.sales)} sales)`, q(s.usage));
    if (s.expiry) add('&minus; going out of date before then', q(s.expiry));
  } else {
    if (step.expiryLoss) add('&minus; going out of date before then', q(step.expiryLoss));
  }
  add(`Expected on the morning of ${esc(dayLabel(date))}${c > 0 ? ' (after the earlier deliveries and usage)' : ''}`, q(step.before), true);
  add(`Needed ${esc(dayLabel(cover.from))}${cover.to !== cover.from ? '&ndash;' + esc(dayLabel(cover.to)) : ''} (${pounds(cover.sales)} forecast sales)`, q(step.usage));
  add('+ safety buffer', q(step.buffer));
  add('Target', q(step.target), true);

  const notes = [];
  const short = round(Math.max(0, step.target - step.before), 2);
  const limitNotes = (limits) => limits.map(l => (
    l.kind === 'shelf' ? `Use-by limit: deliveries stay good for about ${l.days} days, and only ${round(l.usable)} cases will be used in that time &rarr; at most <strong>${l.cap}</strong>.`
      : l.kind === 'max' ? `Max in store is ${l.max} cases &rarr; at most <strong>${l.cap}</strong>.`
        : `Ordered in multiples of ${l.size} &rarr; ${l.from} becomes <strong>${l.to}</strong>.`));
  if (step.fixed) {
    notes.push('This order has been confirmed, so the confirmed quantity is used as it is.');
    if (step.suggested) {
      notes.push(`The plan's own suggestion: short of the target by ${short} cases, rounded up to whole cases: <strong>${step.suggested.need}</strong>.`, ...limitNotes(step.suggested.limits));
    }
  } else {
    notes.push(`Short of the target by ${short} cases, rounded up to whole cases: <strong>${step.need}</strong>.`, ...limitNotes(step.limits));
  }
  if (step.movedTo) notes.push(`Moved to ${esc(dayLabel(step.movedTo))}'s delivery to keep delivery costs near the ${pounds(plan.targetCost)} target.`);
  if (step.movedFrom) notes.push(`Includes ${esc(dayLabel(step.movedFrom))}'s order, brought forward to keep delivery costs near the ${pounds(plan.targetCost)} target.`);
  if (item.start.shelfLife && c === 0 && !step.limits.some(l => l.kind === 'shelf')) notes.push(`Deliveries of this item stay good for about ${item.start.shelfLife} days – the order is within that.`);

  const order = item.qtys[c];
  return `<h2>${esc(item.name)} &mdash; ${esc(dayLabel(date))}</h2>
    <p class="tile-note">Order by ${esc(dayLabel(plan.orderBy[c]))}. Quantities in cases, with the supplier's unit alongside.</p>
    <ul class="explain-steps">${rows.join('')}</ul>
    <ul class="explain-limits">${notes.map(n => `<li>${n}</li>`).join('')}</ul>
    <ul class="explain-steps">
      <li class="total"><span>Order</span><span class="v">${q(order)}</span></li>
      ${step.suggested ? `<li><span>Suggested by the plan</span><span class="v">${q(step.suggested.order)}</span></li>` : ''}
      ${packSize(item) && order > 0 ? `<li><span>Supplier qty</span><span class="v">${round(toPacks(item, order), 2)} &times; ${round(packSize(item), 3)} ${esc(nativeUnit(item))}</span></li>` : ''}
      <li><span>On hand once it arrives</span><span class="v">${q(item.stockAfter[c])}</span></li>
    </ul>`;
}

$('explain-close').addEventListener('click', () => $('explain-dialog').close());

// ---- copy an order for the supplier ----
// A list to type from: the supplier's name first (what you look for on its order screen), ours beside it, in the
// same order as the supplier's order guide. Quantities are in the supplier's cases.
async function copyForSupplier(plan, date) {
  const c = plan.deliveries.indexOf(date);
  const byGuide = (a, b) => (a.supplier_sort ?? Infinity) - (b.supplier_sort ?? Infinity)
    || (a.supplier_name || a.name).localeCompare(b.supplier_name || b.name);
  const lines = plan.items
    .map(it => ({ it, qty: qtyFor(plan, it, c) }))
    .filter(({ qty }) => qty > 0)
    .sort((a, b) => byGuide(a.it, b.it))
    .map(({ it, qty }) => [it.supplier_name || '(not in supplier list)', it.name, round(toPacks(it, qty), 3)].join('\t'));
  const text = [`Supplier order for ${dayLabel(date)}`, 'Supplier name\tOur name\tCases'].concat(lines).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${lines.length} lines for ${dayLabel(date)}. Paste into Notepad and type the cases into the supplier system, top to bottom.`);
  } catch (e) {
    window.prompt('Copy this order (Ctrl+C):', text);
  }
}

// ---- view switch, column buttons, draft editing ----
function syncViewButtons() {
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  view = b.dataset.view;
  try { localStorage.setItem('ordersView', view); } catch (e) {}
  syncViewButtons();
  if (lastPlan) renderPlan(lastPlan);
}));

function syncCompareButton() { $('compare-toggle').setAttribute('aria-pressed', String(compare)); }

$('compare-toggle').addEventListener('click', () => {
  compare = !compare;
  try { localStorage.setItem('ordersCompare', compare ? '1' : '0'); } catch (e) {}
  syncCompareButton();
  if (lastPlan) renderPlan(lastPlan);
});

const planCard = $('plan-card'); // buttons live in the delivery bar as well as the table

planCard.addEventListener('click', async (event) => {
  const link = event.target.closest('.qty-link');
  if (link) {
    const item = lastPlan.items.find(i => i.id === Number(link.dataset.item));
    $('explain-body').innerHTML = explainHtml(lastPlan, item, Number(link.dataset.col));
    $('explain-dialog').showModal();
    return;
  }
  const actEl = event.target.closest('[data-act]'); // the click can land on the icon inside a button
  if (!actEl) return;
  const act = actEl.dataset.act;
  const date = actEl.dataset.date;
  const c = lastPlan.deliveries.indexOf(date);
  try {
    if (act === 'edit') {
      drafts[date] = {};
      for (const it of lastPlan.items) if (it.qtys[c] > 0) drafts[date][it.id] = it.qtys[c];
      renderPlan(lastPlan);
    } else if (act === 'cancel') {
      delete drafts[date];
      renderPlan(lastPlan);
    } else if (act === 'copy') {
      await copyForSupplier(lastPlan, date);
    } else if (act === 'confirm') {
      await busy(actEl, async () => {
        const source = drafts[date] || Object.fromEntries(lastPlan.items.filter(it => it.qtys[c] > 0).map(it => [it.id, it.qtys[c]]));
        const lines = Object.entries(source).map(([id, qty]) => ({ itemId: Number(id), qty: Number(qty) })).filter(l => l.qty > 0);
        await window.api.put('/api/orders/confirm', { date, lines });
        delete drafts[date];
        toast(`Order for ${dayLabel(date)} confirmed (${lines.length} lines).`);
        await loadPlan();
      });
    } else if (act === 'unconfirm') {
      if (!confirm(`Take the order for ${dayLabel(date)} back to the plan?`)) return;
      await window.api.del(`/api/orders/confirm/${date}`);
      await loadPlan();
    }
  } catch (err) {
    toast('Failed: ' + err.message, 'error');
  }
});

// Typing a quantity updates the draft and that column's cost without redrawing (keeps the cursor)
planCard.addEventListener('input', (event) => {
  if (!event.target.classList.contains('draft-qty')) return;
  const { date, item } = event.target.dataset;
  const v = Number(event.target.value);
  drafts[date][item] = Number.isNaN(v) || v < 0 ? 0 : v;
  const cost = draftCost(lastPlan, date);
  const c = lastPlan.deliveries.indexOf(date);
  const it = lastPlan.items.find(i => String(i.id) === String(item));
  const cell = planCard.querySelector(`.cost-cell[data-date="${date}"]`);
  if (cell) {
    cell.innerHTML = costCellHtml(lastPlan, c, cost);
    cell.classList.toggle('cost', cost > lastPlan.targetCost);
  }
  if ($('sheet-cost')) {
    const pct = Math.round(cost / lastPlan.targetCost * 100);
    $('sheet-cost').textContent = '£' + money(cost);
    $('sheet-pct').textContent = pct + '%';
    $('sheet-meter').className = 'meter' + (cost > lastPlan.targetCost ? ' over' : pct > 90 ? ' near' : '');
    $('sheet-meter').firstElementChild.style.width = Math.min(100, pct) + '%';
    const tr = event.target.closest('tr');
    const line = tr.querySelector('.line-cost');
    if (line && it && it.price) line.textContent = '£' + money(drafts[date][item] * it.price);
    const sugg = tr.querySelector('.sugg-cell');
    if (sugg && it) {
      sugg.innerHTML = suggCell(it, c, drafts[date][item]);
      tr.classList.toggle('differs', differs(drafts[date][item], suggestedQty(it, c)));
    }
    if ($('compare-summary')) $('compare-summary').textContent = compareSummary(lastPlan, c);
  }
});

async function loadPlan() {
  lastPlan = await window.api.get('/api/orders/plan');
  syncViewButtons();
  syncCompareButton();
  renderPlan(lastPlan);
}

initForecast().then(loadPlan).catch(err => toast('Failed to load: ' + err.message, 'error'));
