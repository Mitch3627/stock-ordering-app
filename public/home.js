const { esc, fmtQty, dayLabel } = window.ui;
const icon = window.icon;
const money0 = (n) => '£' + Math.round(Number(n)).toLocaleString('en-GB');
const $ = (id) => document.getElementById(id);

function daysText(n) {
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} past`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}
const coverText = (n) => (n < 1 ? 'under a day' : `${n} day${n === 1 ? '' : 's'}`);

function kpi({ label, iconName, value, sub = '', extra = '', href, linkText, managerLink = false }) {
  return `<div class="kpi">
    <div class="kpi-label">${icon(iconName)}<span>${label}</span></div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    ${extra}
    ${href ? `<a class="kpi-link${managerLink ? ' manager-only' : ''}" href="${href}">${linkText} ${icon('arrow', 'icon-sm')}</a>` : ''}
  </div>`;
}

function renderKpis(d) {
  const nd = d.nextDelivery;
  let delivery;
  if (nd) {
    const pct = Math.min(100, Math.round(nd.cost / nd.targetCost * 100));
    const cls = nd.cost > nd.targetCost ? 'over' : pct > 90 ? 'near' : '';
    delivery = kpi({
      label: 'Next delivery', iconName: 'truck', value: esc(dayLabel(nd.date)),
      sub: `${nd.itemCount} items · order by ${esc(dayLabel(nd.orderBy))} · ${nd.confirmed ? '<span class="badge badge-ok">Confirmed</span>' : '<span class="badge badge-warn">Not confirmed</span>'}`,
      extra: `<div class="meter ${cls}" role="img" aria-label="${pct}% of the delivery target"><span style="width:${pct}%"></span></div>
        <div class="kpi-sub">${money0(nd.cost)} of ${money0(nd.targetCost)} target</div>`,
      href: 'orders.html', linkText: 'Open the order plan',
    });
  } else {
    delivery = kpi({ label: 'Next delivery', iconName: 'truck', value: '—', sub: 'No delivery planned' });
  }

  const s = d.sales;
  let salesSub = s.projected != null ? `forecast ${money0(s.projected)}` : 'no forecast entered';
  if (s.actual != null && s.projected) {
    const diff = (s.actual - s.projected) / s.projected * 100;
    salesSub = `<span class="delta ${diff >= 0 ? 'up' : 'down'}">${icon(diff >= 0 ? 'up' : 'down', 'icon-sm')}${Math.abs(diff).toFixed(1)}%</span> vs forecast ${money0(s.projected)}`;
  }
  const sales = kpi({
    label: `Sales yesterday · ${esc(dayLabel(s.yesterday))}`, iconName: 'chart',
    value: s.actual != null ? money0(s.actual) : '<span class="muted">Not logged</span>',
    sub: salesSub,
    href: s.unloggedDays > 0 ? 'orders.html' : null, linkText: `Log ${s.unloggedDays} day${s.unloggedDays === 1 ? '' : 's'} of sales`, managerLink: true,
  });

  const useBy = kpi({
    label: 'Use-by', iconName: 'timer', value: String(d.useBy.soonCount),
    sub: `batch${d.useBy.soonCount === 1 ? '' : 'es'} to use today or tomorrow${d.waste.expiredNotLogged ? ` · <span class="text-bad">${d.waste.expiredNotLogged} past use-by</span>` : ''}`,
    href: 'batches.html', linkText: 'Use-by dates',
  });

  const waste = kpi({
    label: 'Waste · last 7 days', iconName: 'waste', value: String(d.waste.entriesLast7Days),
    sub: `entr${d.waste.entriesLast7Days === 1 ? 'y' : 'ies'}${d.waste.oodLast7Days ? ` · ${d.waste.oodLast7Days} out of date` : ''}`,
    href: 'waste.html', linkText: 'Waste log',
  });

  $('kpis').innerHTML = delivery + sales + useBy + waste;
}

// "Slider Patty, Buns and 3 more" (bold names), for the to-do list.
function names(list, total, max = 6) {
  list = list || [];
  const shown = list.slice(0, max).map(n => `<strong>${esc(n)}</strong>`).join(', ');
  const more = Math.max(total, list.length) - Math.min(list.length, max);
  return shown + (more > 0 ? ` and ${more} more` : '');
}

function renderAttention(d) {
  const rows = [];
  const add = (level, text, href, action, managerOnly = false) => rows.push(`<li class="${level}${managerOnly ? ' manager-only' : ''}"><span class="dot"></span><span class="text">${text}</span><a class="btn btn-secondary btn-sm" href="${href}">${action}</a></li>`);
  if (d.nextDelivery && !d.nextDelivery.confirmed && d.nextDelivery.orderBy <= d.today) add('bad', `The order for ${esc(dayLabel(d.nextDelivery.date))} is due – it isn't confirmed yet`, 'orders.html', 'Review order', true);
  if (d.inventory.runningOut > 0) {
    const out = d.inventory.runningOutItems || [];
    add('bad', `${d.inventory.runningOut === 1 ? 'Will run out' : `${d.inventory.runningOut} items will run out`} before the next delivery: `
      + out.map(s => `<strong>${esc(s.name)}</strong> <span class="muted">(${s.daysLeft <= 0 ? 'none left' : s.daysLeft < 1 ? 'runs out today' : `runs out around ${esc(dayLabel(window.ui.addDays(d.today, Math.floor(s.daysLeft))))}`}, next one arrives ${esc(dayLabel(s.nextArrival))})</span>`).join(', '),
      'orders.html', 'Check plan');
  }
  if (d.inventory.atOrBelowZero > 0) add('bad', `At or below zero stock: ${names(d.inventory.atOrBelowZeroItems, d.inventory.atOrBelowZero)}`, 'inventory.html', 'View stock');
  if (d.waste.expiredNotLogged > 0) add('warn', `Past use-by, still in stock: ${names(d.waste.expiredItems, d.waste.expiredNotLogged)}`, 'waste.html', 'Log waste');
  if (d.useBy.soonCount > 0) add('warn', `${d.useBy.soonCount} batch${d.useBy.soonCount === 1 ? '' : 'es'} to use today or tomorrow: ${names(d.useBy.soonItems, d.useBy.soonItems ? d.useBy.soonItems.length : 0)}`, 'batches.html', 'Use-by dates');
  if (d.sales.unloggedDays > 0) add('warn', `${d.sales.unloggedDays} day${d.sales.unloggedDays === 1 ? '' : 's'} of real sales to log`, 'orders.html', 'Log sales', true);
  if (d.count.due) add('warn', 'The weekly stock count is due', 'counts.html', 'Start count');
  if (d.nextDelivery && d.nextDelivery.cost > d.nextDelivery.targetCost) add('warn', `The next delivery is over the ${money0(d.nextDelivery.targetCost)} target`, 'orders.html', 'Review order', true);
  if (rows.length === 0) rows.push(`<li class="good"><span class="dot"></span><span class="text">All caught up – nothing needs doing right now.</span></li>`);
  $('attention').innerHTML = rows.join('');
}

function renderLowest(d) {
  $('lowest').innerHTML = d.inventory.lowest.length === 0
    ? '<li class="muted">No items with a usage rate yet.</li>'
    : d.inventory.lowest.map(s => `<li>
        <span class="grow"><strong>${esc(s.name)}</strong><small>${esc(fmtQty(s, Math.max(0, s.onHand)))}</small></span>
        <span class="end">${s.runsOut ? `<span class="badge badge-bad">Runs out before ${esc(dayLabel(s.nextArrival))}</span>` : `<span class="badge badge-neutral no-dot">${coverText(s.daysLeft)}</span>`}</span>
      </li>`).join('');
}

function renderUseBy(d) {
  $('useby-list').innerHTML = d.useBy.next.length === 0
    ? '<li class="muted">No use-by tracked stock right now.</li>'
    : d.useBy.next.map(b => {
        const cls = b.daysLeft < 0 ? 'badge-bad' : b.daysLeft <= 1 ? 'badge-warn' : 'badge-neutral';
        return `<li><span class="grow"><strong>${esc(b.item_name)}</strong><small>${esc(fmtQty(b, b.qty_remaining))}</small></span>
          <span class="end"><span class="badge ${cls}">${esc(dayLabel(b.use_by_date))} · ${daysText(b.daysLeft)}</span></span></li>`;
      }).join('');
}

function renderRecords(d) {
  const c = d.count;
  $('records-list').innerHTML = `
    <li><span class="grow"><strong>Last stock count</strong><small>${c.last ? esc(dayLabel(c.last)) : 'No count yet'}</small></span>
      <span class="end">${c.due ? '<a class="btn btn-sm" href="counts.html">Count due</a>' : '<span class="badge badge-ok">Up to date</span>'}</span></li>
    <li><span class="grow"><strong>Item master</strong><small>${d.master.itemCount} items in ${d.master.categories.length} categories</small></span>
      <span class="end"><a class="btn btn-secondary btn-sm" href="index.html">Open</a></span></li>
    <li><span class="grow"><strong>Stock tracked</strong><small>${d.inventory.itemsTracked} active items</small></span>
      <span class="end"><a class="btn btn-secondary btn-sm" href="inventory.html">Stock on hand</a></span></li>`;
}

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name.split(' ')[0]}` : part;
}

async function load() {
  const [d, me] = await Promise.all([window.api.get('/api/dashboard'), window.ui.me().catch(() => null)]);
  $('greeting').textContent = greeting(me && me.name);
  const due = [d.inventory.runningOut, d.waste.expiredNotLogged, d.sales.unloggedDays, d.count.due ? 1 : 0].filter(Boolean).length;
  $('hero-sub').textContent = `${new Date(d.today + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}${me && me.store ? ' · ' + me.store : ''} · ${due ? 'a few things need attention' : 'everything is on track'}`;
  renderKpis(d);
  renderAttention(d);
  renderLowest(d);
  renderUseBy(d);
  renderRecords(d);
}

load().catch(err => {
  $('kpis').innerHTML = `<div class="callout bad">${icon('alert')}<span>Couldn't load the dashboard: ${esc(err.message)}</span></div>`;
});
