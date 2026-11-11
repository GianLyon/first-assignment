// Hearth & Key PMS: staff web app (talks to the JSON API under /api).
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const ugx = (n) => 'UGX ' + num(n);
  const fdate = (d) => d ? new Date(d.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  const fdateLong = (d) => d ? new Date(d.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const ftime = (t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const nights = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
  const guestName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim();
  const DEPT = { rooms: 'Rooms', fnb: 'Food & beverage', amenities: 'Amenities', events: 'Events', other: 'Other' };
  const METHOD = { cash: 'Cash', card: 'Card', mobile_money: 'Mobile money', bank_transfer: 'Bank transfer', company_account: 'Company account' };
  const STATUS = { reserved: ['Reserved', 'info'], in_house: ['In-house', 'ink'], checked_out: ['Checked out', ''], cancelled: ['Cancelled', 'bad'], no_show: ['No-show', 'bad'] };
  const ROLE = { admin: 'Administrator', manager: 'Manager', front_office: 'Front office', housekeeping: 'Housekeeping', accountant: 'Accountant', night_auditor: 'Night auditor', waiter: 'Waiter / cashier', kitchen: 'Kitchen / bar', storekeeper: 'Storekeeper', hr_officer: 'HR officer', maintenance: 'Maintenance' };
  const HK = { clean: 'Clean', dirty: 'Dirty', out_of_order: 'Out of order' };

  let ME = null, CAN = {}, SETTINGS = null;
  const ui = { tab: {}, q: {} };

  /* ---------- API ---------- */
  async function api(method, path, body) {
    const res = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {}, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/auth/login') { ME = null; renderLogin('Your session has ended. Please sign in again.'); throw new Error('Signed out'); }
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.details = data.details; e.status = res.status; throw e; }
    return data;
  }
  const GET = (p) => api('GET', p), POST = (p, b) => api('POST', p, b), PUT = (p, b) => api('PUT', p, b), PATCH = (p, b) => api('PATCH', p, b);

  /* ---------- UI helpers ---------- */
  function toast(html, bad = false) { const t = document.createElement('div'); t.className = 'toast'; if (bad) t.classList.add('toast-bad'); t.innerHTML = html; $('#toasts').appendChild(t); while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove(); setTimeout(() => t.remove(), 5000); }
  let modalSubmit = null;
  function modal(title, body, onSubmit) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = body; modalSubmit = onSubmit || null; $('#modal').hidden = false; const f = $('#modal-body input:not([type=hidden]), #modal-body select, #modal-body textarea'); if (f) f.focus(); }
  const closeModal = () => { $('#modal').hidden = true; modalSubmit = null; };
  const pill = (t, c = '') => `<span class="pill ${c}">${esc(t)}</span>`;
  const statusPill = (s) => pill(...(STATUS[s] || [s, '']));
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const table = (head, rows, empty = 'Nothing to show.') => `<div class="tbl-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith('#') ? 'num' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="empty">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  const tabs = (key, list, def) => { const cur = ui.tab[key] || def || list[0][0]; return `<div class="tabs" role="tablist">${list.map(([v, l]) => `<button type="button" role="tab" aria-selected="${v === cur}" class="${v === cur ? 'on' : ''}" data-action="tab" data-key="${key}" data-val="${v}">${esc(l)}</button>`).join('')}</div>`; };
  const cur = (key, def) => ui.tab[key] || def;
  const formErr = (form, msg) => { let n = form.querySelector('.form-err'); if (!n) { n = document.createElement('p'); n.className = 'note err form-err'; form.prepend(n); } n.textContent = msg; };
  const cancelBtn = '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>';

  /* ---------- login ---------- */
  function renderLogin(msg = '') {
    closeModal();
    $('#root').innerHTML = `<div class="login-wrap"><form class="login form" data-form="login">
      <div class="brand"><span class="mark">H</span><span>Hearth &amp; Key <em>PMS</em></span></div>
      <h1>Sign in</h1><p class="muted mt0">Use the account your administrator gave you.</p>
      ${msg ? `<p class="note err">${esc(msg)}</p>` : ''}
      <label>Username<input name="username" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-gold">Sign in</button></form></div>`;
  }

  /* ---------- shell ---------- */
  const NAV = [
    ['Front office', [['dashboard', 'Dashboard', 'reservations.view'], ['board', 'Room board', 'reservations.view'], ['reservations', 'Reservations', 'reservations.view'], ['availability', 'Availability', 'reservations.view'], ['audit', 'Night audit', 'audit.run']]],
    ['Distribution', [['rates', 'Rates & availability', 'reservations.view'], ['plans', 'Rate plans', 'distribution.manage'], ['channels', 'Channels (OTAs)', 'distribution.manage'], ['bookingengine', 'Booking engine', 'settings.manage']]],
    ['Food & beverage', [['pos', 'Point of sale', 'pos.use'], ['kitchen', 'Kitchen & bar screen', 'pos.kitchen'], ['menu', 'Menu & tables', 'pos.manage'], ['possales', 'F&B sales', 'reports.view']]],
    ['Stores & purchasing', [['stock', 'Stock', 'inventory.view'], ['requisitions', 'Requisitions', 'requisition.create'], ['purchasing', 'Purchasing', 'inventory.receive'], ['counts', 'Stock counts', 'stock.count'], ['stockitems', 'Items & recipes', 'inventory.manage'], ['invreports', 'Inventory reports', 'inventory.view']]],
    ['Finance', [['reports', 'Reports', 'reports.view'], ['companies', 'Company accounts', 'finance.view'], ['payables', 'Suppliers & bills', 'finance.view'], ['money', 'Expenses & transfers', 'finance.view'], ['bankrec', 'Bank reconciliation', 'finance.view'], ['statements', 'Financial statements', 'finance.view'], ['accounts', 'Trial balance & journal', 'accounts.view'], ['chart', 'Chart of accounts', 'accounts.journal']]],
    ['People', [['myhr', 'My HR', 'staff.self'], ['employees', 'Employees', 'hr.view'], ['roster', 'Rosters', 'roster.manage'], ['attendance', 'Attendance', 'attendance.record'], ['leave', 'Leave', 'hr.view'], ['payroll', 'Payroll', 'hr.view']]],
    ['Operations', [['amenities', 'Amenities & services', 'amenities.sell'], ['events', 'Events & banqueting', 'events.view'], ['maintenance', 'Maintenance', 'maintenance.report'], ['assets', 'Assets', 'assets.manage']]],
    ['Administration', [['settings', 'Settings', 'settings.manage'], ['users', 'Users', 'users.manage'], ['log', 'Audit log', 'auditlog.view']]],
  ];
  const VIEW_PERM = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, , perm]) => [id, perm])));
  const route = () => { const [r, id] = (location.hash.replace('#', '') || 'dashboard').split('/'); return { r, id }; };
  function shell() {
    $('#root').innerHTML = `<div class="app">
      <aside class="side" aria-label="Modules"><div class="brand"><span class="mark">H</span><span>Hearth &amp; Key <em>PMS</em></span></div><nav id="side-nav"></nav></aside>
      <div class="main"><header class="topbar">
        <button class="menu-btn" type="button" data-action="toggle-nav" aria-label="Show menu">☰</button>
        <div class="prop"><b id="prop-name"></b><span id="biz-date"></span></div>
        <div class="top-actions user-menu"><span class="user">${esc(ME.full_name)} · ${esc(ROLE[ME.role])}</span>
          <button class="btn btn-ghost btn-sm" data-action="change-password">Password</button><button class="btn btn-ghost btn-sm" data-action="logout">Sign out</button></div>
      </header><main id="view" tabindex="-1"></main></div></div>`;
  }
  function renderNav() {
    const { r } = route();
    $('#side-nav').innerHTML = NAV.map(([g, items]) => { const vis = items.filter(([, , p]) => CAN[p]); return vis.length ? `<div class="grp">${g}</div>` + vis.map(([id, l]) => `<a href="#${id}" class="${r === id || (r === 'res' && id === 'reservations') || ({ event: 'events', eventedit: 'events', beo: 'events', asset: 'assets' }[r] === id) ? 'on' : ''}">${l}</a>`).join('') : ''; }).join('');
    $('#prop-name').textContent = SETTINGS.property_name;
    $('#biz-date').textContent = 'Business date: ' + fdateLong(SETTINGS.business_date);
  }
  async function refreshSettings() { const me = await GET('/auth/me'); SETTINGS = me.settings; }

  const VIEWS = {};
  let renderSeq = 0;
  async function render() {
    if (!ME) return;
    const { r, id } = route();
    const need = VIEW_PERM[r] || { res: 'reservations.view', check: 'pos.use', count: 'stock.count', company: 'finance.view', supplier: 'finance.view', invoice: 'finance.view', rec: 'finance.view', employee: 'hr.view', payrun: 'hr.view', payslip: 'staff.self', event: 'events.view', eventedit: 'events.manage', beo: 'events.view', asset: 'assets.manage' }[r] || null;
    const home = NAV.flatMap(([, items]) => items).find(([, , p]) => CAN[p])?.[0] || 'dashboard';
    const view = VIEWS[r] && (!need || CAN[need]) ? r : home;
    if (view !== r) history.replaceState(null, '', '#' + view);
    clearInterval(ui.timer);
    if (view === 'kitchen') ui.timer = setInterval(() => { if (route().r === 'kitchen' && $('#modal').hidden) render(); }, 15000);
    renderNav(); document.body.classList.remove('nav-open');
    const seq = ++renderSeq;
    try {
      const html = await VIEWS[view](id);
      if (seq === renderSeq) $('#view').innerHTML = html;
    } catch (e) { if (e.message !== 'Signed out' && seq === renderSeq) $('#view').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  }
  const refresh = async () => { await refreshSettings(); await render(); };

  /* ---------- views ---------- */
  VIEWS.dashboard = async () => {
    const d = await GET('/dashboard');
    const occPct = d.rooms.sellable ? Math.round((d.in_house / d.rooms.sellable) * 100) : 0;
    return `<div class="page-head"><div><h1 class="page">Today at ${esc(d.property_name)}</h1><p class="sub">${fdateLong(d.business_date)}</p></div>
      <div class="row">${CAN['reservations.manage'] ? '<button class="btn btn-gold" data-action="new-res">+ New reservation</button>' : ''}<a class="btn btn-ghost" href="#board">Room board</a></div></div>
      <div class="grid g4">
        <div class="card kpi"><span>In-house</span><b>${d.in_house}</b><small>${occPct}% of ${d.rooms.sellable} sellable rooms</small></div>
        <div class="card kpi"><span>Arrivals</span><b>${d.arrivals.length}</b><small>still to check in</small></div>
        <div class="card kpi"><span>Departures</span><b>${d.departures.length}</b><small>still to check out</small></div>
        <div class="card kpi"><span>Rooms to clean</span><b>${d.rooms.dirty}</b><small>${d.rooms.ooo} out of order</small></div>
      </div>
      ${d.overbooked.length ? `<div class="card mt"><h2 class="sec err">Overbooked channel bookings</h2>${table(['Guest', 'Room type', 'Dates', 'Channel'], d.overbooked.map((o) => `<tr><td><a href="#res/${o.id}">${esc(guestName(o))}</a></td><td>${esc(o.room_type_name)}</td><td>${fdate(o.arrival)} → ${fdate(o.departure)}</td><td>${esc(o.source)}</td></tr>`))}</div>` : ''}
      <div class="grid g2 mt">
        <div class="card"><h2 class="sec">Arrivals</h2>${table(['Guest', 'Room type', 'Source', ''], d.arrivals.map((a) => `<tr><td><a href="#res/${a.id}">${esc(guestName(a))}</a><br><span class="small muted">${esc(a.code)}</span></td><td>${esc(a.room_type_name)}</td><td>${esc(a.source)}</td><td class="right">${CAN['frontdesk.checkin'] ? `<button class="btn btn-sm btn-gold" data-action="check-in" data-id="${a.id}">Check in</button>` : ''}</td></tr>`), 'No arrivals waiting.')}</div>
        <div class="card"><h2 class="sec">Departures</h2>${table(['Room', 'Guest', '#Balance', ''], d.departures.map((x) => `<tr><td>${esc(x.room_number)}</td><td><a href="#res/${x.id}">${esc(guestName(x))}</a></td><td class="num">${num(x.balance)}</td><td class="right"><a class="btn btn-sm" href="#res/${x.id}">Open bill</a></td></tr>`), 'No departures waiting.')}</div>
      </div>
      <p class="muted small mt">${d.last_audit ? `Last night audit: ${fdate(d.last_audit.business_date)} · ${d.last_audit.room_charges_posted} room charges · ${ugx(d.last_audit.room_revenue)}` : 'No night audit has been run yet.'}</p>`;
  };

  VIEWS.board = async () => {
    const d = await GET('/room-board');
    const floors = [...new Set(d.rooms.map((r) => r.floor || '–'))];
    const cls = (r) => r.reservation_id ? (r.departure <= d.business_date ? 'dep' : 'occ') : { clean: 'vc', dirty: 'dirty', out_of_order: 'ooo' }[r.hk_status];
    return `<div class="page-head"><div><h1 class="page">Room board</h1><p class="sub">Click a room to open the guest's bill or update housekeeping.</p></div></div>
      <div class="legend"><span><i class="lg occ"></i>Occupied</span><span><i class="lg dep"></i>Due out</span><span><i class="lg vc"></i>Vacant clean</span><span><i class="lg dirty"></i>Vacant dirty</span><span><i class="lg ooo"></i>Out of order</span></div>
      ${floors.map((f) => `<div class="card mt"><h2 class="sec">Floor ${esc(f)}</h2><div class="rack">${d.rooms.filter((r) => (r.floor || '–') === f).map((r) => `
        <button class="room ${cls(r)}" data-action="room" data-id="${r.id}" data-res="${r.reservation_id || ''}" data-number="${esc(r.number)}" data-hk="${r.hk_status}" data-type="${esc(r.type_code)}">
          <b>${esc(r.number)}</b><small>${esc(r.type_name)}</small><span class="g">${r.reservation_id ? esc(guestName(r)) : HK[r.hk_status]}</span>${r.reservation_id ? `<small>Until ${fdate(r.departure)}${r.hk_status === 'dirty' ? ' · service' : ''}</small>` : ''}</button>`).join('')}</div></div>`).join('')}`;
  };

  VIEWS.reservations = async () => {
    const v = cur('res', 'active'), q = ui.q.res || '';
    const list = await GET(`/reservations?view=${v}&q=${encodeURIComponent(q)}`);
    return `<div class="page-head"><div><h1 class="page">Reservations</h1><p class="sub">Search by guest name, phone or booking code.</p></div>
      <div class="row"><form data-form="res-search" class="row"><input class="search" type="search" name="q" value="${esc(q)}" placeholder="Search…" aria-label="Search reservations"></form>${CAN['reservations.manage'] ? '<button class="btn btn-gold" data-action="new-res">+ New reservation</button>' : ''}</div></div>
      ${tabs('res', [['active', 'All active'], ['arrivals', 'Arrivals'], ['inhouse', 'In-house'], ['departures', 'Departures'], ['upcoming', 'Upcoming'], ['past', 'Past & cancelled']], 'active')}
      <div class="card">${table(['Guest', 'Room', 'Arrive', 'Depart', 'Source', 'Status', '#Balance'], list.map((r) => `<tr>
        <td><a href="#res/${r.id}"><b>${esc(guestName(r))}</b></a><br><span class="small muted">${esc(r.code)} · ${esc(r.room_type_name)}${r.phone ? ' · ' + esc(r.phone) : ''}</span></td>
        <td>${esc(r.room_number || '–')}</td><td class="nowrap">${fdate(r.arrival)}</td><td class="nowrap">${fdate(r.departure)}</td><td>${esc(r.source)}</td><td>${statusPill(r.status)}</td><td class="num">${num(r.balance)}</td></tr>`), 'No reservations found.')}</div>`;
  };

  VIEWS.res = async (id) => {
    const f = await GET(`/reservations/${id}`);
    const r = f.reservation, t = f.totals, bd = SETTINGS.business_date;
    const acts = [];
    if (r.status === 'reserved' && CAN['frontdesk.checkin'] && r.arrival <= bd) acts.push(`<button class="btn btn-gold" data-action="check-in" data-id="${r.id}">Check in</button>`);
    if (r.status === 'in_house' && CAN['frontdesk.checkout']) acts.push(`<button class="btn" data-action="check-out" data-id="${r.id}" data-bal="${t.balance}">Check out</button>`);
    if (r.status === 'in_house' && CAN['folio.post']) acts.push(`<button class="btn btn-ghost" data-action="post-charge" data-id="${r.id}">Post charge</button>`);
    if (['reserved', 'in_house', 'checked_out'].includes(r.status) && CAN['payments.post'] && (r.status !== 'checked_out' || t.balance > 0)) acts.push(`<button class="btn btn-ghost" data-action="take-payment" data-id="${r.id}" data-bal="${t.balance}" data-company="${esc(r.company_name || '')}">Take payment</button>`);
    if (['reserved', 'in_house'].includes(r.status) && CAN['reservations.manage']) acts.push(`<button class="btn btn-ghost" data-action="edit-res" data-id="${r.id}">Edit stay</button>`);
    if (r.status === 'reserved' && CAN['reservations.manage']) acts.push(`<button class="btn btn-ghost" data-action="cancel-res" data-id="${r.id}">Cancel booking</button>`);
    acts.push('<button class="btn btn-ghost" data-action="print">Print invoice</button>');
    const voidBtn = (kind, x) => !x.voided && CAN['folio.void'] ? `<button class="link small" data-action="void" data-kind="${kind}" data-id="${x.id}">Void</button>` : (x.voided ? `<span class="small muted" title="${esc(x.void_reason)}">void</span>` : '');
    return `<div class="page-head no-print"><div><p class="sub"><a href="#reservations">← Reservations</a></p><h1 class="page">${esc(guestName(r))}</h1><p class="sub">${esc(r.code)} · ${statusPill(r.status)}</p></div><div class="row">${acts.join('')}</div></div>
      <div class="card"><div class="inv-head"><div><div class="only-print"><h2>${esc(SETTINGS.property_name)}</h2><p class="muted">Guest invoice · printed ${fdateLong(bd)}</p></div>
        <dl class="kv"><dt>Guest</dt><dd>${esc(guestName(r))}</dd><dt>Phone</dt><dd>${esc(r.phone || '–')}</dd><dt>Email</dt><dd>${esc(r.email || '–')}</dd><dt>ID</dt><dd>${esc([r.id_type, r.id_number].filter(Boolean).join(' ') || '–')}</dd>${r.company_name ? `<dt>Company</dt><dd>${esc(r.company_name)}</dd>` : ''}</dl></div>
        <dl class="kv"><dt>Room</dt><dd>${esc(r.room_number || 'Not assigned')} · ${esc(r.room_type_name)}</dd><dt>Stay</dt><dd>${fdate(r.arrival)} → ${fdate(r.departure)} (${nights(r.arrival, r.departure)} nights)</dd><dt>Rate</dt><dd>${f.nights.length ? ugx(f.nights.reduce((a, n) => a + n.rate, 0)) + ' total' : ugx(r.rate) + ' / night'}${r.rate_plan_name ? ' · ' + esc(r.rate_plan_name) : ''}</dd><dt>Guests</dt><dd>${r.adults} adult(s)${r.children ? `, ${r.children} child(ren)` : ''}</dd><dt>Source</dt><dd>${esc(r.source)}${r.external_ref ? ` · ref ${esc(r.external_ref)}` : ''}${r.commission_pct != null ? ` · ${num(r.commission_pct)}% commission` : ''}</dd></dl></div>
        ${r.overbooked && r.status === 'reserved' ? '<p class="note err">Overbooked: this channel booking arrived when no room of this type was free. Move or upgrade another booking before arrival.</p>' : ''}
        ${f.nights.length ? `<p class="small muted">Nightly prices: ${f.nights.map((n) => `${fdate(n.night)} ${num(n.rate)}`).join(' · ')}</p>` : ''}
        ${r.notes ? `<p class="note">${esc(r.notes)}</p>` : ''}
        <h2 class="sec mt">Charges</h2>
        ${table(['Date', 'Description', 'Department', '#Amount', ''], f.charges.map((c) => `<tr class="${c.voided ? 'void' : ''}"><td class="nowrap">${fdate(c.business_date)}</td><td>${esc(c.description)}</td><td>${DEPT[c.department]}</td><td class="num">${num(c.amount)}</td><td class="right no-print">${voidBtn('charge', c)}</td></tr>`), 'No charges yet.')}
        <h2 class="sec mt">Payments</h2>
        ${table(['Date', 'Method', 'Reference', '#Amount', ''], f.payments.map((p) => `<tr class="${p.voided ? 'void' : ''}"><td class="nowrap">${fdate(p.business_date)}</td><td>${METHOD[p.method]}</td><td>${esc(p.reference || '')}</td><td class="num">${num(p.amount)}</td><td class="right no-print">${voidBtn('payment', p)}</td></tr>`), 'No payments yet.')}
        ${table(['Summary', '#UGX'], [`<tr><td>Total charges</td><td class="num">${num(t.charges)}</td></tr>`, `<tr><td>Total paid</td><td class="num">${num(t.payments)}</td></tr>`, `<tr class="total"><td>${t.balance < 0 ? 'Credit due to guest' : 'Balance due'}</td><td class="num">${num(Math.abs(t.balance))}</td></tr>`])}
        <p class="small muted">Prices include VAT at ${num(SETTINGS.vat_rate)}%.</p></div>`;
  };

  VIEWS.availability = async () => {
    const from = ui.q.availFrom || SETTINGS.business_date;
    const grid = await GET(`/availability?from=${from}&days=14`);
    const days = grid[0]?.nights.map((n) => n.night) || [];
    return `<div class="page-head"><div><h1 class="page">Availability</h1><p class="sub">Rooms still free each night, after bookings and out-of-order rooms.</p></div>
      <form data-form="avail" class="row"><label class="row small">From <input class="search" type="date" name="from" value="${from}"></label><button class="btn btn-ghost">Show</button></form></div>
      <div class="card avail">${table(['Room type', 'Rate', ...days.map(fdate)], grid.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${num(t.base_rate)}</td>${t.nights.map((n) => `<td class="${n.free <= 0 ? 'free0' : n.free === 1 ? 'free1' : ''}">${n.free}</td>`).join('')}</tr>`))}</div>`;
  };

  VIEWS.audit = async () => {
    const { preview: p, history } = await GET('/night-audit');
    const blocked = p.pending_departures.length > 0;
    return `<div class="page-head"><div><h1 class="page">Night audit</h1><p class="sub">Closes ${fdateLong(p.business_date)}: posts tonight's room charges, marks no-shows and moves to the next business day.</p></div></div>
      <div class="grid g3">
        <div class="card kpi"><span>Room charges to post</span><b>${p.room_charges}</b><small>${ugx(p.room_revenue)}</small></div>
        <div class="card kpi"><span>Will become no-shows</span><b>${p.no_shows.length}</b><small>${p.no_shows.map((x) => esc(guestName(x))).join(', ') || 'none'}</small></div>
        <div class="card kpi"><span>Guests still due out</span><b>${p.pending_departures.length}</b><small>${blocked ? 'must check out or extend first' : 'all clear'}</small></div>
      </div>
      ${blocked ? `<div class="card mt"><h2 class="sec">Check out or extend these guests first</h2>${table(['Room', 'Guest', ''], p.pending_departures.map((x) => `<tr><td>${esc(x.room)}</td><td>${esc(guestName(x))}</td><td class="right"><a class="btn btn-sm" href="#res/${x.id}">Open</a></td></tr>`))}</div>` : ''}
      <div class="row mt"><button class="btn btn-gold" data-action="run-audit" ${blocked ? 'disabled' : ''}>Run night audit for ${fdate(p.business_date)}</button></div>
      <div class="card mt"><h2 class="sec">History</h2>${table(['Date', 'Run by', 'Run at', '#Room charges', '#Room revenue', '#No-shows'], history.map((h) => `<tr><td>${fdate(h.business_date)}</td><td>${esc(h.run_by_name || '')}</td><td>${ftime(h.run_at)}</td><td class="num">${h.room_charges_posted}</td><td class="num">${num(h.room_revenue)}</td><td class="num">${h.no_shows}</td></tr>`), 'No audits yet.')}</div>`;
  };

  VIEWS.reports = async () => {
    const date = ui.q.repDate || addDays(SETTINGS.business_date, -1);
    const d = await GET(`/reports/daily?date=${date}`);
    return `<div class="page-head"><div><h1 class="page">Daily manager's report</h1><p class="sub">${fdateLong(d.date)}${d.audited ? '' : ' · not yet closed by the night audit'}</p></div>
      <div class="row no-print"><form data-form="rep" class="row"><input class="search" type="date" name="date" value="${d.date}" aria-label="Report date"><button class="btn btn-ghost">Show</button></form><button class="btn btn-ghost" data-action="print">Print</button></div></div>
      <div class="grid g4">${[['Occupancy', Math.round(d.occupancy * 100) + '%', `${d.occupied_rooms} of ${d.sellable_rooms} rooms`], ['ADR', num(d.adr), 'UGX average rate'], ['RevPAR', num(d.revpar), 'UGX per available room'], ['Revenue', num(d.revenue_total), `incl. VAT ${num(d.vat_included)}`]].map(([l, v, s]) => `<div class="card kpi"><span>${l}</span><b>${v}</b><small>${s}</small></div>`).join('')}</div>
      <div class="grid g2 mt">
        <div class="card"><h2 class="sec">Revenue by department</h2>${table(['Department', '#UGX'], Object.entries(d.revenue).map(([k, v]) => `<tr><td>${DEPT[k]}</td><td class="num">${num(v)}</td></tr>`).concat([`<tr class="total"><td>Total</td><td class="num">${num(d.revenue_total)}</td></tr>`]))}</div>
        <div class="card"><h2 class="sec">Collections</h2>${table(['Method', '#UGX'], Object.entries(d.payments).map(([k, v]) => `<tr><td>${METHOD[k]}</td><td class="num">${num(v)}</td></tr>`).concat([`<tr class="total"><td>Total</td><td class="num">${num(Object.values(d.payments).reduce((a, b) => a + b, 0))}</td></tr>`]))}</div>
      </div>`;
  };

  VIEWS.accounts = async () => {
    const t = cur('acc', 'tb');
    let body;
    if (t === 'tb') {
      const tb = await GET('/accounts/trial-balance');
      const ok = tb.total_debit === tb.total_credit;
      body = `<div class="card">${table(['Code', 'Account', 'Type', '#Debit', '#Credit'], tb.lines.filter((l) => l.debit || l.credit).map((l) => `<tr><td>${l.code}</td><td>${esc(l.name)}</td><td>${esc(l.type)}</td><td class="num">${l.debit ? num(l.debit) : ''}</td><td class="num">${l.credit ? num(l.credit) : ''}</td></tr>`).concat([`<tr class="total"><td colspan="3">Totals ${ok ? pill('Balanced', 'ok') : pill('Out of balance', 'bad')}</td><td class="num">${num(tb.total_debit)}</td><td class="num">${num(tb.total_credit)}</td></tr>`]), 'No postings yet.')}</div>`;
    } else {
      const j = await GET('/accounts/journal?limit=100');
      body = `<div class="card">${table(['Date', 'Description', 'Account', '#Debit', '#Credit'], j.flatMap((e) => e.lines.map((l, i) => `<tr><td class="nowrap">${i ? '' : fdate(e.business_date)}</td><td>${i ? '' : esc(e.description) + `<br><span class="small muted">${esc(e.created_by_name || 'System')}</span>`}</td><td>${l.account} ${esc(l.name)}</td><td class="num">${l.debit ? num(l.debit) : ''}</td><td class="num">${l.credit ? num(l.credit) : ''}</td></tr>`)), 'No postings yet.')}</div>`;
    }
    return `<div class="page-head"><div><h1 class="page">Accounts</h1><p class="sub">Every charge, payment and void is posted automatically as a balanced double entry.</p></div></div>${tabs('acc', [['tb', 'Trial balance'], ['journal', 'Journal']], 'tb')}${body}`;
  };

  VIEWS.settings = async () => {
    const [types, rooms] = await Promise.all([GET('/room-types'), GET('/rooms')]);
    return `<div class="page-head"><div><h1 class="page">Settings</h1><p class="sub">Property details, room types and rooms.</p></div></div>
      <div class="card"><h2 class="sec">Property</h2><form class="form" data-form="settings"><div class="two"><label>Property name<input name="property_name" value="${esc(SETTINGS.property_name)}" required></label><label>VAT rate (%)<input name="vat_rate" type="number" step="0.01" min="0" max="99" value="${SETTINGS.vat_rate}" required></label></div><div class="actions"><button class="btn btn-gold">Save</button></div></form></div>
      <div class="card mt"><div class="row between"><h2 class="sec">Room types</h2><button class="btn btn-sm btn-gold" data-action="room-type">+ Room type</button></div>
        ${table(['Code', 'Name', '#Rate (UGX)', '#Max guests', 'Active', ''], types.map((t) => `<tr><td>${esc(t.code)}</td><td>${esc(t.name)}</td><td class="num">${num(t.base_rate)}</td><td class="num">${t.max_occupancy}</td><td>${t.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="room-type" data-id="${t.id}">Edit</button></td></tr>`))}</div>
      <div class="card mt"><div class="row between"><h2 class="sec">Rooms</h2><button class="btn btn-sm btn-gold" data-action="room-edit">+ Room</button></div>
        ${table(['Room', 'Type', 'Floor', 'Housekeeping', 'Active', ''], rooms.map((r) => `<tr><td><b>${esc(r.number)}</b></td><td>${esc(r.type_name)}</td><td>${esc(r.floor || '')}</td><td>${HK[r.hk_status]}</td><td>${r.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="room-edit" data-id="${r.id}">Edit</button></td></tr>`))}</div>`;
  };

  VIEWS.users = async () => {
    const users = await GET('/users');
    return `<div class="page-head"><div><h1 class="page">Users</h1><p class="sub">Each person gets their own account. Roles control what they can see and do.</p></div><button class="btn btn-gold" data-action="user-edit">+ New user</button></div>
      <div class="card">${table(['Name', 'Username', 'Role', 'Status', ''], users.map((u) => `<tr><td><b>${esc(u.full_name)}</b></td><td>${esc(u.username)}</td><td>${ROLE[u.role]}</td><td>${u.active ? pill('Active', 'ok') : pill('Disabled', 'bad')}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="user-edit" data-id="${u.id}">Edit</button></td></tr>`))}</div>
      <div class="card mt"><h2 class="sec">What each role can do</h2>${table(['Role', 'Access'], [['Administrator', 'Everything, including users'], ['Manager', 'All operations, voids, night audit, accounts, settings'], ['Front office', 'Reservations, check-in/out, charges and payments'], ['Night auditor', 'Front office plus the night audit and accounts'], ['Housekeeping', 'Room status only'], ['Accountant', 'Accounts, reports, voids and the audit log'], ['Waiter / cashier', 'Point of sale only: bills, sending orders, payments, own shift'], ['Kitchen / bar', 'Kitchen and bar ticket screen, stock levels, requisitions'], ['Storekeeper', 'Stock, deliveries, purchase orders (not approval), issuing requisitions, stock counts'], ['HR officer', 'Employees, rosters, attendance, leave records, payroll preparation (managers approve)']].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`))}</div>`;
  };

  VIEWS.log = async () => {
    const rows = await GET('/audit-log?limit=200');
    return `<div class="page-head"><div><h1 class="page">Audit log</h1><p class="sub">Who did what, and when. Entries cannot be edited.</p></div></div>
      <div class="card">${table(['When', 'User', 'Action', 'Record', 'Details'], rows.map((a) => `<tr><td class="nowrap">${ftime(a.at)}</td><td>${esc(a.full_name || '–')}</td><td>${esc(a.action)}</td><td>${esc(a.entity || '')} ${esc(a.entity_id || '')}</td><td class="small muted">${esc(JSON.stringify(a.details)).slice(0, 160)}</td></tr>`))}</div>`;
  };


  /* ================= FOOD & BEVERAGE ================= */
  const PMETHOD = { cash: 'Cash', card: 'Card', mobile_money: 'Mobile money', room: 'Charge to room' };
  const since = (t) => { const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  let POS = null; // cached menu & floor setup
  const posSetup = async (force) => (POS && !force ? POS : (POS = await GET('/pos/setup')));

  VIEWS.pos = async () => {
    const [shift, setup] = await Promise.all([GET('/pos/shift'), posSetup(true)]);
    if (!shift) {
      return `<div class="page-head"><div><h1 class="page">Point of sale</h1><p class="sub">Open your shift to start taking orders.</p></div></div>
        <div class="card"><form class="form" data-form="open-shift"><div class="two">
          <label>Outlet<select name="outlet_id">${opts(setup.outlets.filter((o) => o.active).map((o) => [o.id, o.name]))}</select></label>
          <label>Opening cash float (UGX)<input name="opening_float" type="number" min="0" step="1" value="0" required></label></div>
          <div class="actions"><button class="btn btn-gold">Open shift</button></div></form></div>`;
    }
    const outletId = ui.posOutlet && setup.outlets.some((o) => o.id === ui.posOutlet) ? ui.posOutlet : shift.outlet_id;
    const outlet = setup.outlets.find((o) => o.id === outletId);
    const floor = await GET(`/pos/floor?outlet_id=${outletId}`);
    return `<div class="page-head"><div><h1 class="page">${esc(outlet.name)}</h1><p class="sub">Shift opened ${ftime(shift.opened_at)} · float ${ugx(shift.opening_float)} · cash taken ${ugx(shift.takings.cash)}</p></div>
        <div class="row"><button class="btn btn-gold" data-action="quick-check">+ Bill without table</button><button class="btn btn-ghost" data-action="room-service">Room service</button><button class="btn btn-ghost" data-action="close-shift">Close shift</button></div></div>
      <div class="tabs">${setup.outlets.filter((o) => o.active).map((o) => `<button class="${o.id === outletId ? 'on' : ''}" data-action="pos-outlet" data-id="${o.id}">${esc(o.name)}</button>`).join('')}</div>
      ${floor.tables.length ? `<div class="card"><h2 class="sec">Tables</h2><div class="rack">${floor.tables.map((t) => t.check_id
        ? `<a class="room occ" href="#check/${t.check_id}"><b>${esc(t.name)}</b><small>${esc(t.code)} · ${t.covers} guest(s)</small><span class="g">${ugx(t.total)}</span><small>${since(t.opened_at)} · ${esc(t.opened_by_name || '')}</small></a>`
        : `<button class="room vc" data-action="new-check" data-table="${t.id}" data-name="${esc(t.name)}"><b>${esc(t.name)}</b><small>${t.seats} seats</small><span class="g">Free</span></button>`).join('')}</div></div>` : ''}
      <div class="card mt"><h2 class="sec">Other open bills</h2>${table(['Bill', 'For', 'Open', '#Total', ''], floor.other.map((c) => `<tr><td>${esc(c.code)}</td><td>${c.room_number ? `Room ${esc(c.room_number)} · ${esc(c.last_name)}` : 'Walk-in / takeaway'}</td><td>${since(c.opened_at)}</td><td class="num">${num(c.total)}</td><td class="right"><a class="btn btn-sm" href="#check/${c.check_id}">Open</a></td></tr>`), 'None.')}</div>`;
  };

  VIEWS.check = async (id) => {
    const [d, setup] = await Promise.all([GET(`/pos/checks/${id}`), posSetup()]);
    const c = d.check, open = c.status === 'open';
    const cats = setup.categories.filter((x) => x.active);
    const cat = cats.find((x) => x.id === ui.posCat) || cats[0];
    const items = setup.items.filter((i) => i.active && i.category_id === cat?.id);
    const pending = d.lines.filter((l) => l.status === 'pending').length;
    const who = c.table_name ? `Table ${esc(c.table_name)}` : c.room_number ? `Room ${esc(c.room_number)} · ${esc(c.last_name)}` : 'Walk-in';
    const lineRow = (l) => `<div class="cart-line ${l.status === 'voided' ? 'void-line' : ''}"><span>${esc(l.name)}${l.note ? `<br><small class="muted">${esc(l.note)}</small>` : ''}<br><small class="muted">${{ pending: 'not sent', sent: l.station === 'bar' ? 'sent to bar' : 'sent to kitchen', voided: 'void: ' + esc(l.void_reason || '') }[l.status]}</small></span>
      ${open && l.status === 'pending' ? `<span class="qty"><button class="link small" data-action="line-note" data-id="${l.id}" data-note="${esc(l.note || '')}">note</button> <button data-action="line-qty" data-id="${l.id}" data-qty="${l.qty - 1}" aria-label="Less">−</button>${l.qty}<button data-action="line-qty" data-id="${l.id}" data-qty="${l.qty + 1}" aria-label="More">+</button></span>`
        : `<span class="qty">${l.qty}${open && l.status === 'sent' && CAN['pos.void'] ? ` <button class="link small" data-action="line-void" data-id="${l.id}">void</button>` : ''}</span>`}
      <b>${num(l.unit_price * l.qty)}</b></div>`;
    return `<div class="page-head"><div><p class="sub"><a href="#pos">← Floor</a></p><h1 class="page">${who}</h1><p class="sub">${esc(c.code)} · ${esc(c.outlet_name)} · ${c.covers} guest(s) · ${open ? 'open ' + since(c.opened_at) : statusPillPos(c.status)}</p></div>
        ${open ? `<div class="row">${c.table_id ? `<button class="btn btn-ghost" data-action="move-check" data-id="${c.id}">Move table</button>` : ''}<button class="btn btn-ghost" data-action="void-check" data-id="${c.id}">Void bill</button></div>` : ''}</div>
      <div class="pos">
        <div>${open ? `<div class="tabs">${cats.map((x) => `<button class="${x.id === cat?.id ? 'on' : ''}" data-action="pos-cat" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
          <div class="items">${items.map((i) => `<button class="item" data-action="add-item" data-check="${c.id}" data-id="${i.id}"><b>${esc(i.name)}</b><span>${num(i.price)}</span></button>`).join('') || '<p class="muted">No items in this category.</p>'}</div>
          <p class="small muted mt">Tap “note” on an item in the bill to add instructions for the kitchen or bar (e.g. “no onions”).</p>` : `<div class="card">${table(['Paid by', 'Reference', '#Amount'], d.payments.map((p) => `<tr><td>${PMETHOD[p.method]}${p.room_number ? ' · room ' + esc(p.room_number) : ''}</td><td>${esc(p.reference || '')}</td><td class="num">${num(p.amount)}</td></tr>`), 'No payments.')}</div>`}</div>
        <div class="card cart"><h2 class="sec">Bill ${esc(c.code)}</h2>
          ${d.lines.length ? d.lines.map(lineRow).join('') : '<p class="empty">Tap items to add them.</p>'}
          <div class="cart-total"><span>Total</span><span>${ugx(d.total)}</span></div>
          ${open ? `<div class="pay-btns"><button class="btn" data-action="send-check" data-id="${c.id}" ${pending ? '' : 'disabled'}>Send ${pending ? `(${pending})` : ''}</button><button class="btn btn-gold" data-action="pay-check" data-id="${c.id}" data-total="${d.total}" data-res="${c.reservation_id || ''}" ${d.total ? '' : 'disabled'}>Pay</button></div>
          <p class="note mt">“Send” prints the order to the kitchen or bar screen. Paying sends anything not yet sent.</p>` : '<div class="row"><button class="btn btn-ghost" data-action="print">Print receipt</button></div>'}
        </div></div>`;
  };
  const statusPillPos = (s) => pill({ settled: 'Paid', voided: 'Void', open: 'Open' }[s] || s, { settled: 'ok', voided: 'bad' }[s] || '');

  VIEWS.kitchen = async () => {
    const station = cur('station', 'kitchen');
    const list = await GET(`/pos/tickets?station=${station}`);
    return `<div class="page-head"><div><h1 class="page">${station === 'bar' ? 'Bar' : 'Kitchen'} tickets</h1><p class="sub">Refreshes every 15 seconds. Oldest first.</p></div></div>
      ${tabs('station', [['kitchen', 'Kitchen'], ['bar', 'Bar']], 'kitchen')}
      <div class="tickets">${list.map((t) => `<div class="card ticket t-${t.status}"><div class="row between"><b>${t.table_name ? 'Table ' + esc(t.table_name) : t.room_number ? 'Room ' + esc(t.room_number) : 'Walk-in'}</b><span class="small muted">${esc(t.code)} · ${esc(t.outlet_name)}</span></div>
        <p class="small muted mt0">${since(t.created_at)} ago · ${t.status}</p>
        <ul class="ticket-items">${t.items.map((i) => `<li class="${i.voided ? 'void-line' : ''}"><b>${i.qty}×</b> ${esc(i.name)}${i.note ? `<br><em>${esc(i.note)}</em>` : ''}${i.voided ? ' <span class="pill bad">VOID</span>' : ''}</li>`).join('')}</ul>
        ${t.status === 'new' ? `<button class="btn btn-gold" data-action="ticket" data-id="${t.id}" data-status="ready">Ready</button>` : t.status === 'ready' ? `<button class="btn" data-action="ticket" data-id="${t.id}" data-status="served">Served</button>` : '<span class="pill ok">Served</span>'}</div>`).join('') || '<div class="card"><p class="empty">No tickets right now.</p></div>'}</div>`;
  };

  VIEWS.menu = async () => {
    const setup = await posSetup(true);
    const catName = (id) => setup.categories.find((c) => c.id === id)?.name || '';
    const t = cur('menu', 'items');
    const body = {
      items: () => `<div class="row between mb"><span class="muted">Prices include VAT.</span><button class="btn btn-gold btn-sm" data-action="item-edit">+ Menu item</button></div>${table(['Item', 'Category', '#Price', 'On sale', ''], setup.items.map((i) => `<tr><td><b>${esc(i.name)}</b></td><td>${esc(catName(i.category_id))}</td><td class="num">${num(i.price)}</td><td>${i.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="item-edit" data-id="${i.id}">Edit</button></td></tr>`))}`,
      categories: () => `<div class="row between mb"><span class="muted">The station decides whether tickets go to the kitchen or the bar.</span><button class="btn btn-gold btn-sm" data-action="cat-edit">+ Category</button></div>${table(['Category', 'Station', '#Order', 'Active', ''], setup.categories.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${c.station === 'bar' ? 'Bar' : 'Kitchen'}</td><td class="num">${c.sort}</td><td>${c.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="cat-edit" data-id="${c.id}">Edit</button></td></tr>`))}`,
      tables: () => `<div class="row between mb"><span></span><button class="btn btn-gold btn-sm" data-action="table-edit">+ Table</button></div>${table(['Table', 'Outlet', '#Seats', 'Active', ''], setup.tables.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(setup.outlets.find((o) => o.id === x.outlet_id)?.name)}</td><td class="num">${x.seats}</td><td>${x.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="table-edit" data-id="${x.id}">Edit</button></td></tr>`))}`,
      outlets: () => `<div class="row between mb"><span></span><button class="btn btn-gold btn-sm" data-action="outlet-edit">+ Outlet</button></div>${table(['Outlet', 'Type', 'Active', ''], setup.outlets.map((o) => `<tr><td><b>${esc(o.name)}</b></td><td>${esc(o.kind.replace('_', ' '))}</td><td>${o.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="outlet-edit" data-id="${o.id}">Edit</button></td></tr>`))}`,
    }[t]();
    return `<div class="page-head"><div><h1 class="page">Menu &amp; tables</h1><p class="sub">Menu items, categories, tables and outlets for the point of sale.</p></div></div>
      ${tabs('menu', [['items', 'Menu items'], ['categories', 'Categories'], ['tables', 'Tables'], ['outlets', 'Outlets']], 'items')}<div class="card">${body}</div>`;
  };

  VIEWS.possales = async () => {
    const date = ui.q.posDate || SETTINGS.business_date;
    const d = await GET(`/pos/reports/sales?date=${date}`);
    return `<div class="page-head"><div><h1 class="page">Food &amp; beverage sales</h1><p class="sub">${fdateLong(d.date)}</p></div>
      <div class="row no-print"><form data-form="possales" class="row"><input class="search" type="date" name="date" value="${d.date}" aria-label="Date"><button class="btn btn-ghost">Show</button></form><button class="btn btn-ghost" data-action="print">Print</button></div></div>
      <div class="grid g4">${[['Total sales', num(d.total)], ['Cash', num(d.by_method.cash)], ['Card + mobile money', num(d.by_method.card + d.by_method.mobile_money)], ['Charged to rooms', num(d.by_method.room)]].map(([l, v]) => `<div class="card kpi"><span>${l}</span><b>${v}</b><small>UGX</small></div>`).join('')}</div>
      <div class="grid g2 mt"><div class="card"><h2 class="sec">By outlet</h2>${table(['Outlet', '#Bills', '#Guests', '#Sales'], d.by_outlet.map((o) => `<tr><td>${esc(o.outlet)}</td><td class="num">${o.bills}</td><td class="num">${o.covers}</td><td class="num">${num(o.amount)}</td></tr>`), 'No sales.')}</div>
        <div class="card"><h2 class="sec">Best sellers</h2>${table(['Item', '#Qty', '#Sales'], d.items.slice(0, 12).map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${num(i.amount)}</td></tr>`), 'No sales.')}</div></div>
      <div class="card mt"><h2 class="sec">Cashier shifts</h2>${table(['Cashier', 'Outlet', 'Opened', 'Closed', '#Expected cash', '#Counted', '#Variance'], d.shifts.map((s) => `<tr><td>${esc(s.full_name)}</td><td>${esc(s.outlet_name)}</td><td>${ftime(s.opened_at)}</td><td>${s.closed_at ? ftime(s.closed_at) : pill('Open', 'warn')}</td><td class="num">${num(s.expected_cash)}</td><td class="num">${s.closed_at ? num(s.counted_cash) : ''}</td><td class="num ${s.variance < 0 ? 'err' : ''}">${s.closed_at ? num(s.variance) : ''}</td></tr>`), 'No shifts.')}</div>
      <div class="card mt"><h2 class="sec">Voided items</h2>${table(['Bill', 'Item', '#Qty', '#Value', 'Reason', 'By'], d.voids.map((v) => `<tr><td>${esc(v.code)}</td><td>${esc(v.name)}</td><td class="num">${v.qty}</td><td class="num">${num(v.amount)}</td><td>${esc(v.void_reason || '')}</td><td>${esc(v.voided_by || '')}</td></tr>`), 'No voids.')}</div>`;
  };

  async function payForm(id, total, resId) {
    const rooms = await GET('/pos/rooms');
    const roomOpts = rooms.map((r) => [r.reservation_id, `Room ${r.room_number} · ${guestName(r)}`]);
    const row = (n, method, amount) => `<div class="two tender"><label>Payment ${n}<select name="m${n}">${opts([['', '–'], ...Object.entries(PMETHOD)], method)}</select></label><label>Amount<input name="a${n}" type="number" min="0" step="1" value="${amount}" data-calc="tender"></label></div>`;
    modal(`Pay ${ugx(total)}`, `<form class="form" data-form="pay-check">
      ${row(1, resId ? 'room' : 'cash', total)}${row(2, '', '')}${row(3, '', '')}
      <label>Room (for charge to room)<select name="res">${opts([['', '–'], ...roomOpts], resId)}</select></label>
      <div class="two"><label>Reference (card / mobile money)<input name="reference" maxlength="80"></label><label>Cash received (to work out change)<input name="tendered" type="number" min="0" step="1" data-calc="tender"></label></div>
      <p class="note" id="pay-calc" data-total="${total}">Remaining: UGX 0</p>
      <div class="actions">${cancelBtn}<button class="btn btn-gold">Complete payment</button></div></form>`,
      async (v) => {
        const payments = [1, 2, 3].map((n) => ({ method: v['m' + n], amount: Number(v['a' + n]) })).filter((p) => p.method && p.amount > 0)
          .map((p) => ({ ...p, reservation_id: p.method === 'room' ? Number(v.res) || null : undefined, reference: p.method === 'card' || p.method === 'mobile_money' ? v.reference : undefined }));
        if (payments.some((p) => p.method === 'room' && !p.reservation_id)) throw new Error('Choose the guest room to charge.');
        await POST(`/pos/checks/${id}/settle`, { payments });
        return 'Bill paid.';
      });
    updatePayCalc();
  }
  function updatePayCalc() {
    const f = $('#modal-body form[data-form=pay-check]'); const out = $('#pay-calc'); if (!f || !out) return;
    const v = Object.fromEntries(new FormData(f)); const total = Number(out.dataset.total);
    const paid = [1, 2, 3].reduce((a, n) => a + (v['m' + n] ? Number(v['a' + n]) || 0 : 0), 0);
    const cash = [1, 2, 3].reduce((a, n) => a + (v['m' + n] === 'cash' ? Number(v['a' + n]) || 0 : 0), 0);
    const tendered = Number(v.tendered) || 0;
    out.textContent = `Remaining: ${ugx(total - paid)}` + (tendered && cash ? ` · Change to give: ${ugx(Math.max(0, tendered - cash))}` : '');
    out.classList.toggle('err', total !== paid);
  }


  /* ================= STORES & PURCHASING ================= */
  const qn = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? num(v) : v.toLocaleString('en-US', { maximumFractionDigits: 3 }); };
  let INVS = null;
  const invSetup = async (force) => (INVS && !force ? INVS : (INVS = await GET('/inventory/setup')));
  const RQ_STATUS = { pending: ['Waiting approval', 'warn'], approved: ['Approved', 'info'], issued: ['Issued', 'ok'], rejected: ['Rejected', 'bad'], cancelled: ['Cancelled', ''] };
  const PO_STATUS = { draft: ['Draft', 'warn'], approved: ['Approved', 'info'], partly_received: ['Part received', 'info'], received: ['Received', 'ok'], cancelled: ['Cancelled', ''] };
  const MV = { receipt: 'Delivery', opening: 'Opening stock', transfer_in: 'Transfer in', transfer_out: 'Transfer out', issue: 'Issued to department', sale: 'Sold (recipe)', count: 'Stock count', write_off: 'Write-off' };
  const itemOpts = (items, sel) => opts([['', 'Choose item…'], ...items.filter((i) => i.active).map((i) => [i.id, `${i.name} (${i.unit})`])], sel);
  const lineRows = (n, items, { cost = false, pre = [] } = {}) => [...Array(n)].map((_, k) => `<div class="${cost ? 'three' : 'two'} line-row">
      <label>${k ? '' : 'Item'}<select name="item_${k}">${itemOpts(items, pre[k]?.item_id)}</select></label>
      <label>${k ? '' : 'Quantity'}<input name="qty_${k}" type="number" min="0" step="0.001" value="${pre[k]?.qty ?? ''}"></label>
      ${cost ? `<label>${k ? '' : 'Unit cost (UGX)'}<input name="cost_${k}" type="number" min="0" step="1" value="${pre[k]?.unit_cost ?? ''}"></label>` : ''}</div>`).join('');
  const readLines = (v, n, cost = false) => [...Array(n)].map((_, k) => ({ item_id: Number(v['item_' + k]), qty: Number(v['qty_' + k]), unit_cost: cost ? Number(v['cost_' + k]) : undefined })).filter((l) => l.item_id && l.qty > 0);

  VIEWS.stock = async () => {
    const S = await invSetup(true);
    const storeId = cur('stockStore', 'all');
    const list = await GET(`/inventory/stock${storeId === 'all' ? '' : '?store_id=' + storeId}`);
    const total = list.reduce((a, i) => a + i.value, 0);
    const shown = storeId === 'all' ? list : list.filter((i) => i.qty !== 0);
    return `<div class="page-head"><div><h1 class="page">Stock</h1><p class="sub">Quantities on hand, valued at weighted average cost.</p></div>
      <div class="row">${CAN['requisition.create'] ? '<button class="btn btn-gold" data-action="new-req">+ Requisition</button>' : ''}${CAN['inventory.receive'] ? '<button class="btn btn-ghost" data-action="write-off">Write-off</button>' : ''}</div></div>
      ${tabs('stockStore', [['all', 'All stores'], ...S.stores.filter((x) => x.active).map((x) => [String(x.id), x.name])], 'all')}
      <div class="grid g3 mb"><div class="card kpi"><span>Stock value</span><b>${num(total)}</b><small>UGX at average cost</small></div>
        <div class="card kpi"><span>At or below re-order level</span><b>${list.filter((i) => i.active && i.low).length}</b><small>items${storeId === 'all' ? ' (all stores)' : ' in this store'}</small></div>
        <div class="card kpi"><span>Below zero</span><b>${list.filter((i) => i.qty < 0).length}</b><small>sold before the delivery was entered</small></div></div>
      <div class="card">${table(['Item', 'Category', '#On hand', '#Re-order at', '#Avg cost', '#Value', ''], shown.map((i) => `<tr><td><b>${esc(i.name)}</b><br><span class="small muted">${esc(i.code)}</span></td><td>${esc(i.category)}</td>
        <td class="num ${i.qty < 0 ? 'err' : ''}">${qn(i.qty)} ${esc(i.unit)}</td><td class="num">${qn(i.reorder_level)}</td><td class="num">${num(i.avg_cost)}</td><td class="num">${num(i.value)}</td>
        <td class="right nowrap">${i.low && storeId === 'all' && i.active ? pill('Re-order', 'bad') + ' ' : ''}<button class="btn btn-sm btn-ghost" data-action="movements" data-id="${i.id}" data-name="${esc(i.name)}">History</button></td></tr>`), 'No stock in this store.')}</div>`;
  };

  VIEWS.requisitions = async () => {
    const v = cur('rq', CAN['requisition.approve'] ? 'pending' : CAN['requisition.issue'] ? 'approved' : 'mine');
    const list = await GET(`/inventory/requisitions?view=${v}`);
    return `<div class="page-head"><div><h1 class="page">Requisitions</h1><p class="sub">Departments request stock, a manager approves, the store issues it.</p></div><button class="btn btn-gold" data-action="new-req">+ New requisition</button></div>
      ${tabs('rq', [['pending', 'Waiting approval'], ['approved', 'Ready to issue'], ['done', 'Completed'], ['mine', 'Raised by me']], v)}
      <div class="card">${table(['Code', 'Department', 'From → to', 'Requested', '#Items', 'Status', '#Cost', ''], list.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.department)}</td><td>${esc(r.from_store)} → ${esc(r.to_store || 'used by department')}</td>
        <td>${ftime(r.requested_at)}<br><span class="small muted">${esc(r.requested_by_name || '')}</span></td><td class="num">${r.lines}</td><td>${pill(...RQ_STATUS[r.status])}</td><td class="num">${r.total_cost != null ? num(r.total_cost) : ''}</td>
        <td class="right"><button class="btn btn-sm" data-action="open-req" data-id="${r.id}">Open</button></td></tr>`), 'Nothing here.')}</div>`;
  };

  VIEWS.purchasing = async () => {
    const t = cur('po', 'open');
    let body;
    if (t === 'receipts') {
      const g = await GET('/inventory/receipts');
      body = table(['GRN', 'Date', 'Supplier', 'Store', 'Order', 'Invoice', '#Value', 'Received by'], g.map((x) => `<tr><td>${esc(x.code)}</td><td>${fdate(x.business_date)}</td><td>${x.is_opening ? pill('Opening stock') : esc(x.supplier_name)}</td><td>${esc(x.store_name)}</td><td>${esc(x.po_code || '–')}</td><td>${esc(x.invoice_ref || '')}</td><td class="num">${num(x.total)}</td><td>${esc(x.received_by_name || '')}</td></tr>`), 'No deliveries yet.');
    } else {
      const list = await GET(`/inventory/purchase-orders?view=${t}`);
      body = table(['Order', 'Supplier', 'Deliver to', 'Raised', 'Status', '#Value', ''], list.map((p) => `<tr><td>${esc(p.code)}</td><td>${esc(p.supplier_name)}</td><td>${esc(p.store_name)}</td><td>${ftime(p.created_at)}</td><td>${pill(...PO_STATUS[p.status])}</td><td class="num">${num(p.total)}</td><td class="right"><button class="btn btn-sm" data-action="open-po" data-id="${p.id}">Open</button></td></tr>`), 'No orders.');
    }
    return `<div class="page-head"><div><h1 class="page">Purchasing</h1><p class="sub">Purchase orders, deliveries (goods received) and opening stock.</p></div>
      <div class="row"><button class="btn btn-gold" data-action="new-po">+ Purchase order</button><button class="btn btn-ghost" data-action="receive" data-mode="direct">Delivery without order</button><button class="btn btn-ghost" data-action="receive" data-mode="opening">Opening stock</button></div></div>
      ${tabs('po', [['open', 'Open orders'], ['closed', 'Closed orders'], ['receipts', 'Deliveries']], 'open')}<div class="card">${body}</div>`;
  };

  VIEWS.counts = async () => {
    const [list, S] = await Promise.all([GET('/inventory/counts'), invSetup()]);
    return `<div class="page-head"><div><h1 class="page">Stock counts</h1><p class="sub">Count a store, then post: differences adjust stock and post to the accounts.</p></div>
      <form class="row" data-form="start-count"><select class="search" name="store_id" aria-label="Store">${opts(S.stores.filter((x) => x.active).map((x) => [x.id, x.name]))}</select><button class="btn btn-gold">Start count</button></form></div>
      <div class="card">${table(['#', 'Store', 'Started', 'Status', 'Progress', '#Variance (UGX)', ''], list.map((c) => `<tr><td>${c.id}</td><td>${esc(c.store_name)}</td><td>${ftime(c.created_at)}<br><span class="small muted">${esc(c.created_by_name || '')}</span></td>
        <td>${pill({ open: 'Open', posted: 'Posted', cancelled: 'Cancelled' }[c.status], { open: 'warn', posted: 'ok' }[c.status] || '')}</td><td>${c.counted} of ${c.lines} counted</td><td class="num ${c.variance_value < 0 ? 'err' : ''}">${c.variance_value != null ? num(c.variance_value) : ''}</td>
        <td class="right"><a class="btn btn-sm" href="#count/${c.id}">${c.status === 'open' ? 'Continue' : 'View'}</a></td></tr>`), 'No counts yet.')}</div>`;
  };

  VIEWS.count = async (id) => {
    const c = await GET(`/inventory/counts/${id}`);
    const open = c.status === 'open';
    return `<div class="page-head"><div><p class="sub"><a href="#counts">← Stock counts</a></p><h1 class="page">Count: ${esc(c.store_name)}</h1><p class="sub">Started ${fdateLong(c.business_date)}. Leave a line empty if you did not count it; it will not change.</p></div>
      ${open ? '<div class="row"><button class="btn btn-ghost" data-action="cancel-count" data-id="' + c.id + '">Cancel count</button></div>' : ''}</div>
      <form class="card" data-form="count-sheet" data-id="${c.id}">${table(['Item', 'Unit', ...(open ? [] : ['#System', '#Counted', '#Difference']), ...(open ? ['Counted'] : [])], c.lines.map((l) => open
        ? `<tr><td>${esc(l.name)}<br><span class="small muted">${esc(l.category)}</span></td><td>${esc(l.unit)}</td><td><input class="search count-input" name="c_${l.item_id}" type="number" min="0" step="0.001" value="${l.counted_qty ?? ''}" aria-label="Counted ${esc(l.name)}"></td></tr>`
        : `<tr><td>${esc(l.name)}</td><td>${esc(l.unit)}</td><td class="num">${l.posted_qty != null ? qn(l.posted_qty) : qn(l.expected_qty)}</td><td class="num">${l.counted_qty != null ? qn(l.counted_qty) : '–'}</td><td class="num ${l.counted_qty != null && l.counted_qty - l.posted_qty < 0 ? 'err' : ''}">${l.counted_qty != null && l.posted_qty != null ? qn(l.counted_qty - l.posted_qty) : ''}</td></tr>`))}
      ${open ? `<div class="row mt"><button class="btn btn-ghost" name="do" value="save">Save progress</button><button class="btn btn-gold" name="do" value="post">Post count</button></div>` : `<p class="mt">Net variance: <b>${ugx(c.variance_value)}</b></p>`}</form>`;
  };

  VIEWS.stockitems = async () => {
    const S = await invSetup(true);
    const t = cur('si', 'items');
    let body;
    if (t === 'items') body = `<div class="row between mb"><span class="muted">${S.items.length} items</span><button class="btn btn-gold btn-sm" data-action="stock-item">+ Item</button></div>${table(['Code', 'Item', 'Unit', 'Category', '#Re-order at', 'Active', ''], S.items.map((i) => `<tr><td>${esc(i.code)}</td><td><b>${esc(i.name)}</b></td><td>${esc(i.unit)}</td><td>${esc(i.category)}</td><td class="num">${qn(i.reorder_level)}</td><td>${i.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="stock-item" data-id="${i.id}">Edit</button></td></tr>`))}`;
    else if (t === 'suppliers') body = `<div class="row between mb"><span></span><button class="btn btn-gold btn-sm" data-action="supplier">+ Supplier</button></div>${table(['Supplier', 'Contact', 'Phone', 'Email', 'TIN', ''], S.suppliers.map((x) => `<tr><td><b>${esc(x.name)}</b>${x.active ? '' : ' ' + pill('Inactive')}</td><td>${esc(x.contact || '')}</td><td>${esc(x.phone || '')}</td><td>${esc(x.email || '')}</td><td>${esc(x.tin || '')}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="supplier" data-id="${x.id}">Edit</button></td></tr>`))}`;
    else if (t === 'stores') body = `<div class="row between mb"><span class="muted">Each sales outlet takes its recipe ingredients from one store.</span><button class="btn btn-gold btn-sm" data-action="store-edit">+ Store</button></div>${table(['Store', 'Type', 'Active', ''], S.stores.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.kind)}</td><td>${x.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="store-edit" data-id="${x.id}">Edit</button></td></tr>`))}
      <h2 class="sec mt">Outlets</h2>${table(['Outlet', 'Takes stock from'], S.outlets.map((o) => `<tr><td>${esc(o.name)}</td><td><select class="search" data-action="outlet-store" data-id="${o.id}" aria-label="Store for ${esc(o.name)}">${opts([['', 'No stock deduction'], ...S.stores.map((x) => [x.id, x.name])], o.stock_store_id || '')}</select></td></tr>`))}`;
    else {
      const rec = await GET('/inventory/recipes');
      body = `<p class="muted">Ingredients used per portion. When the POS sells an item, these quantities come out of the outlet's store.</p>${table(['Menu item', 'Category', '#Ingredients', '#Cost per portion', '#Price', '#Cost %', ''], rec.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.category)}</td><td class="num">${r.ingredients}</td><td class="num">${num(r.cost)}</td><td class="num">${num(r.price)}</td>
        <td class="num ${r.price && r.cost / (r.price * 100 / (100 + Number(SETTINGS.vat_rate))) > 0.4 ? 'err' : ''}">${r.price && r.ingredients && r.cost ? Math.round((r.cost / (r.price * 100 / (100 + Number(SETTINGS.vat_rate)))) * 100) + '%' : r.ingredients ? '<span class="small muted">not costed yet</span>' : ''}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="recipe" data-id="${r.id}" data-name="${esc(r.name)}">Edit recipe</button></td></tr>`))}
        <p class="small muted">Cost % compares ingredient cost with the price before VAT. Above 40% is highlighted.</p>`;
    }
    return `<div class="page-head"><div><h1 class="page">Items &amp; recipes</h1><p class="sub">Stock items, suppliers, stores and recipes.</p></div></div>
      ${tabs('si', [['items', 'Stock items'], ['suppliers', 'Suppliers'], ['stores', 'Stores & outlets'], ['recipes', 'Recipes']], 'items')}<div class="card">${body}</div>`;
  };

  VIEWS.invreports = async () => {
    const qs = ui.q.invFrom ? `?from=${ui.q.invFrom}&to=${ui.q.invTo}` : '';
    const d = await GET(`/inventory/reports/summary${qs}`);
    const fc = d.food_cost;
    return `<div class="page-head"><div><h1 class="page">Inventory reports</h1><p class="sub">${fdate(d.from)} to ${fdate(d.to)}</p></div>
      <form class="row no-print" data-form="invrep"><input class="search" type="date" name="from" value="${d.from}" aria-label="From"><input class="search" type="date" name="to" value="${d.to}" aria-label="To"><button class="btn btn-ghost">Show</button><button type="button" class="btn btn-ghost" data-action="print">Print</button></form></div>
      <div class="grid g4">${[['Stock value', num(d.stores.reduce((a, x) => a + x.value, 0)), 'UGX, all stores'], ['F&B sales (net of VAT)', num(fc.revenue_net), 'UGX'], ['Cost of sales', num(fc.cost_of_sales), 'UGX, from recipes'], ['Food & beverage cost', Math.round(fc.food_cost_pct * 100) + '%', 'cost ÷ net sales']].map(([l, v, s]) => `<div class="card kpi"><span>${l}</span><b>${v}</b><small>${s}</small></div>`).join('')}</div>
      <div class="grid g2 mt"><div class="card"><h2 class="sec">Stock value by store</h2>${table(['Store', '#UGX'], d.stores.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${num(x.value)}</td></tr>`))}</div>
        <div class="card"><h2 class="sec">Issued to departments</h2>${table(['Department', '#Requisitions', '#Value', '#Expensed'], d.consumption.map((x) => `<tr><td>${esc(x.department)}</td><td class="num">${x.requisitions}</td><td class="num">${num(x.value)}</td><td class="num">${num(x.expensed)}</td></tr>`), 'Nothing issued in this period.')}
        <p class="small muted">“Expensed” is stock used up by the department. The rest was moved into a department store (e.g. the kitchen).</p></div></div>
      <div class="grid g2 mt"><div class="card"><h2 class="sec">To re-order</h2>${table(['Item', '#On hand', '#Re-order at'], d.low_stock.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${qn(i.qty)} ${esc(i.unit)}</td><td class="num">${qn(i.reorder_level)}</td></tr>`), 'Nothing to re-order.')}</div>
        <div class="card"><h2 class="sec">Below zero (enter missing deliveries)</h2>${table(['Item', 'Store', '#Qty'], d.negative.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.store_name)}</td><td class="num err">${qn(i.qty)} ${esc(i.unit)}</td></tr>`), 'None.')}</div></div>`;
  };


  /* ================= DISTRIBUTION ================= */
  VIEWS.rates = async () => {
    const from = ui.q.rateFrom || SETTINGS.business_date;
    const cal = await GET(`/distribution/calendar?from=${from}&days=14`);
    const days = cal[0]?.nights.map((n) => n.night) || [];
    const canEdit = CAN['distribution.manage'];
    return `<div class="page-head"><div><h1 class="page">Rates &amp; availability</h1><p class="sub">Standard price per night (before rate-plan discounts), rooms left, and restrictions. Changes go to the booking engine and every channel.</p></div>
      <div class="row"><form class="row" data-form="rate-from"><input class="search" type="date" name="from" value="${from}" aria-label="From date"><button class="btn btn-ghost">Show</button></form>${canEdit ? '<button class="btn btn-gold" data-action="rate-edit">Change rates / restrictions</button>' : ''}</div></div>
      <div class="card rates-grid">${table(['Room type', ...days.map(fdate)], cal.map((t) => `<tr><td><b>${esc(t.name)}</b><br><span class="small muted">standard ${num(t.base_rate)}</span></td>${t.nights.map((n) => `<td class="rc ${n.stop_sell ? 'closed' : ''} ${n.free <= 0 ? 'full' : ''}">
        <b class="${n.custom ? 'custom' : ''}">${num(n.rate)}</b><span>${n.free} left</span>${n.min_stay ? `<span>min ${n.min_stay}</span>` : ''}${n.stop_sell ? '<span class="pill bad">closed</span>' : ''}</td>`).join('')}</tr>`))}
      <p class="small muted">Gold price = set for that date. “Closed” = stop-sell (not sold online or on channels; the front desk can still book).</p></div>`;
  };

  VIEWS.plans = async () => {
    const plans = await GET('/distribution/rate-plans');
    return `<div class="page-head"><div><h1 class="page">Rate plans</h1><p class="sub">Ways to sell each room: flexible, non-refundable, long stay… Prices are the standard rate minus the plan discount.</p></div><button class="btn btn-gold" data-action="plan-edit">+ Rate plan</button></div>
      <div class="card">${table(['Code', 'Plan', '#Discount', 'Breakfast', 'Cancellation', '#Min stay', 'Sold on', 'Active', ''], plans.map((p) => `<tr><td>${esc(p.code)}</td><td><b>${esc(p.name)}</b><br><span class="small muted">${esc(p.description || '')}</span></td><td class="num">${num(p.discount_pct)}%</td><td>${p.breakfast ? 'Included' : '–'}</td><td>${p.refundable ? 'Free cancellation' : pill('Non-refundable', 'warn')}</td><td class="num">${p.min_stay}</td><td>${[p.on_website && 'Website', p.on_channels && 'Channels'].filter(Boolean).join(', ') || '–'}</td><td>${p.active ? 'Yes' : 'No'}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="plan-edit" data-id="${p.id}">Edit</button></td></tr>`))}</div>`;
  };

  VIEWS.channels = async () => {
    const d = await GET('/distribution/channels');
    return `<div class="page-head"><div><h1 class="page">Channels (OTAs)</h1><p class="sub">Availability and prices are pushed automatically when they change. Bookings from channels arrive in Reservations.</p></div>
      <div class="row"><button class="btn btn-ghost" data-action="sync-now">Push changes now${d.pending_changes ? ` (${d.pending_changes} waiting)` : ''}</button><button class="btn btn-gold" data-action="channel-edit">+ Channel</button></div></div>
      <div class="card">${table(['Channel', 'Connector', '#Commission', 'Mapped', 'Active bookings', 'Last push', 'Status', ''], d.channels.map((c) => `<tr><td><b>${esc(c.name)}</b><br><span class="small muted">${esc(c.code)}</span></td><td>${esc((d.adapters.find((a) => a.id === c.adapter) || {}).label || c.adapter)}</td><td class="num">${num(c.commission_pct)}%</td><td>${c.mappings} rate(s)</td><td>${c.active_bookings}</td><td>${c.last_push_at ? ftime(c.last_push_at) : 'never'}</td>
        <td>${!c.active ? pill('Paused') : c.last_error ? `<span class="pill bad" title="${esc(c.last_error)}">Error</span>` : pill('OK', 'ok')}</td>
        <td class="right nowrap"><button class="btn btn-sm btn-ghost" data-action="channel-map" data-id="${c.id}" data-name="${esc(c.name)}">Mapping</button> <button class="btn btn-sm btn-ghost" data-action="channel-log" data-id="${c.id}" data-name="${esc(c.name)}">Log</button> <button class="btn btn-sm btn-ghost" data-action="channel-more" data-id="${c.id}">More</button></td></tr>`), 'No channels yet.')}</div>
      <div class="card mt"><h2 class="sec">How channels connect</h2><p>Booking.com, Expedia and Airbnb only connect through certified partners. Add your provider as a <b>Webhook</b> channel: the PMS sends signed availability and price updates to the provider's address, and the provider sends bookings back to:</p>
        <p><code class="mono">${esc(location.origin)}/api/channels/&lt;channel code&gt;/inbound</code></p><p class="small muted">Every message in both directions is signed with the channel's secret (HMAC-SHA256 in the X-HK-Signature header). Use the <b>simulator</b> channel to try everything before going live.</p></div>`;
  };

  VIEWS.bookingengine = async () => {
    const s = await GET('/settings');
    const url = `${location.origin}/book/`;
    return `<div class="page-head"><div><h1 class="page">Booking engine</h1><p class="sub">The page guests use to book directly. Link it from the hotel website's “Book now” button.</p></div><a class="btn btn-gold" href="/book/" target="_blank" rel="noopener">Open booking page</a></div>
      <div class="card"><p>Booking page address: <code class="mono">${esc(url)}</code></p>
      <form class="form" data-form="booking-settings">
        <label class="row"><input type="checkbox" name="booking_enabled" value="1" ${s.booking_enabled ? 'checked' : ''}> Accept online bookings</label>
        <label>Welcome text<input name="booking_intro" value="${esc(s.booking_intro)}" maxlength="500"></label>
        <label>Cancellation policy (shown to guests)<textarea name="cancellation_policy" rows="2" maxlength="1000">${esc(s.cancellation_policy)}</textarea></label>
        <div class="three"><label>Check-in from<input name="check_in_time" value="${String(s.check_in_time).slice(0, 5)}" pattern="\\d{2}:\\d{2}" required></label><label>Check-out by<input name="check_out_time" value="${String(s.check_out_time).slice(0, 5)}" pattern="\\d{2}:\\d{2}" required></label><label>Bookable up to (days ahead)<input name="booking_horizon_days" type="number" min="7" max="730" value="${s.booking_horizon_days}"></label></div>
        <div class="two"><label>Contact phone<input name="contact_phone" value="${esc(s.contact_phone || '')}" maxlength="40"></label><label>Contact email<input name="contact_email" type="email" value="${esc(s.contact_email || '')}" maxlength="120"></label></div>
        <div class="actions"><button class="btn btn-gold">Save</button></div></form></div>
      ${await (async () => { const op = await GET('/finance/online-payments').catch(() => null); if (!op) return ''; return `<div class="card mt"><h2 class="sec">Online payment</h2>
        <form class="form" data-form="online-pay"><label class="row"><input type="checkbox" name="enabled" value="1" ${op.enabled ? 'checked' : ''}> Let guests pay online (non-refundable rates in full, other rates the first night)</label>
        <label>Payment provider<select name="provider">${opts(op.providers.map((p) => [p.id, p.label]), op.provider)}</select></label>
        ${op.provider === 'simulator' ? '<p class="note err">The test checkout lets anyone mark a payment as paid. Use it only for testing; connect a real provider (e.g. Flutterwave or Pesapal) before switching this on for guests.</p>' : ''}
        <div class="actions"><button class="btn btn-gold">Save</button></div></form></div>`; })()}`;
  };


  /* ================= FINANCE ================= */
  let ACCTS = null;
  const accts = async (force) => (ACCTS && !force ? ACCTS : (ACCTS = await GET('/finance/accounts')));
  const cashOpts = (list, sel) => opts(list.filter((a) => a.is_cash && a.active).map((a) => [a.code, `${a.code} ${a.name}`]), sel);
  const AGE = [['current', 'Not yet due'], ['d30', '1–30 days'], ['d60', '31–60'], ['d90', '61–90'], ['over90', '90+']];
  const rangeForm = (key, from, to, extra = '') => `<form class="row no-print" data-form="range" data-key="${key}"><input class="search" type="date" name="from" value="${from}" aria-label="From"><input class="search" type="date" name="to" value="${to}" aria-label="To">${extra}<button class="btn btn-ghost">Show</button><button type="button" class="btn btn-ghost" data-action="print">Print</button></form>`;
  const monthStart = () => SETTINGS.business_date.slice(0, 8) + '01';

  VIEWS.companies = async () => {
    const [cos, aging] = await Promise.all([GET('/finance/companies'), GET('/finance/ar-aging')]);
    const ag = (id) => aging.rows.find((r) => r.id === id);
    return `<div class="page-head"><div><h1 class="page">Company accounts</h1><p class="sub">Companies that stay on account. Guest bills moved to a company account are invoiced from here.</p></div>${CAN['finance.manage'] ? '<button class="btn btn-gold" data-action="company-edit">+ Company</button>' : ''}</div>
      <div class="card">${table(['Company', '#Not invoiced', ...AGE.map(([, l]) => '#' + l), '#Owed', ''], cos.map((c) => { const a = ag(c.id) || {}; return `<tr><td><a href="#company/${c.id}"><b>${esc(c.name)}</b></a><br><span class="small muted">${c.terms_days} days · limit ${c.credit_limit ? num(c.credit_limit) : 'none'}</span></td>
        <td class="num">${num(a.unbilled)}</td>${AGE.map(([k]) => `<td class="num ${k !== 'current' && a[k] ? 'err' : ''}">${a[k] ? num(a[k]) : ''}</td>`).join('')}<td class="num"><b>${num(a.total)}</b></td><td class="right"><a class="btn btn-sm" href="#company/${c.id}">Open</a></td></tr>`; }), 'No companies yet.')}
      <p class="small muted">Aging is by due date, as at ${fdate(aging.as_at)}. Unallocated payments reduce the amount owed.</p></div>`;
  };

  VIEWS.company = async (id) => {
    const d = await GET(`/finance/companies/${id}`);
    const c = d.company, m = CAN['finance.manage'];
    return `<div class="page-head"><div><p class="sub"><a href="#companies">← Company accounts</a></p><h1 class="page">${esc(c.name)}</h1><p class="sub">${c.tin ? 'TIN ' + esc(c.tin) + ' · ' : ''}${c.terms_days} days credit · owes <b>${ugx(d.balance)}</b></p></div>
      ${m ? `<div class="row"><button class="btn btn-ghost" data-action="company-edit" data-id="${c.id}">Edit</button><button class="btn btn-gold" data-action="receipt" data-id="${c.id}">Record payment received</button></div>` : ''}</div>
      <div class="card"><h2 class="sec">Not invoiced yet</h2>${d.unbilled.length ? `<form class="form" data-form="invoice" data-id="${c.id}">${table(['', 'Stay', 'Guest', 'Dates', '#Amount'], d.unbilled.map((p) => `<tr><td><input type="checkbox" name="p_${p.id}" value="1" checked aria-label="Include ${esc(p.code)}"></td><td>${esc(p.code)}</td><td>${esc(p.first_name)} ${esc(p.last_name)}</td><td>${fdate(p.arrival)} → ${fdate(p.departure)}</td><td class="num">${num(p.amount)}</td></tr>`))}
        ${m ? `<details><summary class="small">Add other charges (e.g. conference, transport)</summary>${[0, 1].map((k) => `<div class="three"><label>Description<input name="xd_${k}" maxlength="200"></label><label>Department<select name="xt_${k}">${opts(Object.entries(DEPT), 'events')}</select></label><label>Amount (VAT incl.)<input name="xa_${k}" type="number" min="1"></label></div>`).join('')}</details>
        <div class="actions"><button class="btn btn-gold">Create invoice</button></div>` : ''}</form>` : `<p class="muted">Nothing waiting.${m ? ' <button class="link" data-action="invoice-extra" data-id="' + c.id + '">Invoice other charges</button>' : ''}</p>`}</div>
      <div class="card mt"><h2 class="sec">Invoices</h2>${table(['Invoice', 'Date', 'Due', '#Total', '#Balance', 'Status', ''], d.invoices.map((i) => `<tr><td><a href="#invoice/${i.id}">${esc(i.number)}</a></td><td>${fdate(i.invoice_date)}</td><td class="${i.status === 'issued' && i.balance > 0 && i.due_date < d.business_date ? 'err' : ''}">${fdate(i.due_date)}</td><td class="num">${num(i.total)}</td><td class="num">${i.status === 'void' ? '' : num(i.balance)}</td>
        <td>${i.status === 'void' ? pill('Void') : i.balance <= 0 ? pill('Paid', 'ok') : i.due_date < d.business_date ? pill('Overdue', 'bad') : pill('Open', 'info')}</td><td class="right"><a class="btn btn-sm btn-ghost" href="#invoice/${i.id}">View</a></td></tr>`), 'No invoices.')}</div>
      <div class="card mt"><h2 class="sec">Payments received</h2>${table(['Receipt', 'Date', 'Into', 'Reference', '#Amount', '#Not allocated'], d.receipts.map((r) => `<tr><td>${esc(r.number)}</td><td>${fdate(r.receipt_date)}</td><td>${esc(r.account_name)}</td><td>${esc(r.reference || '')}</td><td class="num">${num(r.amount)}</td><td class="num">${r.unallocated ? num(r.unallocated) : ''}</td></tr>`), 'No payments yet.')}</div>`;
  };

  VIEWS.invoice = async (id) => {
    const i = await GET(`/finance/invoices/${id}`);
    return `<div class="page-head no-print"><div><p class="sub"><a href="#company/${i.company_id}">← ${esc(i.company_name)}</a></p><h1 class="page">Invoice ${esc(i.number)}</h1></div>
      <div class="row"><button class="btn btn-ghost" data-action="print">Print / PDF</button>${CAN['finance.manage'] && i.status === 'issued' && !i.payments.length ? `<button class="btn btn-bad" data-action="invoice-void" data-id="${i.id}">Void</button>` : ''}</div></div>
      <div class="card"><div class="inv-head"><div><h2>${esc(SETTINGS.property_name)}</h2><p class="muted">Tax invoice ${esc(i.number)}${i.status === 'void' ? ' · <b class="err">VOID</b>' : ''}</p></div>
        <dl class="kv"><dt>Bill to</dt><dd>${esc(i.company_name)}</dd>${i.tin ? `<dt>TIN</dt><dd>${esc(i.tin)}</dd>` : ''}${i.address ? `<dt>Address</dt><dd>${esc(i.address)}</dd>` : ''}<dt>Date</dt><dd>${fdate(i.invoice_date)}</dd><dt>Due</dt><dd>${fdate(i.due_date)}</dd></dl></div>
        ${table(['Description', '#Amount (UGX)'], i.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${num(l.amount)}</td></tr>`).concat([`<tr class="total"><td>Total (VAT included at ${num(SETTINGS.vat_rate)}%)</td><td class="num">${num(i.total)}</td></tr>`, `<tr><td>of which VAT</td><td class="num">${num(Math.round(i.total * Number(SETTINGS.vat_rate) / (100 + Number(SETTINGS.vat_rate))))}</td></tr>`,
          ...i.payments.map((p) => `<tr><td>Paid ${fdate(p.receipt_date)} (${esc(p.number)})</td><td class="num">(${num(p.amount)})</td></tr>`), `<tr class="total"><td>Balance due</td><td class="num">${num(i.balance)}</td></tr>`]))}
        ${i.notes ? `<p class="note">${esc(i.notes)}</p>` : ''}</div>`;
  };

  VIEWS.payables = async () => {
    const [aging, inv] = await Promise.all([GET('/finance/ap-aging'), GET('/inventory/setup').catch(() => ({ suppliers: [] }))]);
    const ag = (id) => aging.rows.find((r) => r.id === id) || {};
    return `<div class="page-head"><div><h1 class="page">Suppliers &amp; bills</h1><p class="sub">What the hotel owes. Deliveries become bills when the supplier's invoice arrives; then pay them.</p></div></div>
      <div class="card">${table(['Supplier', '#Delivered, not billed', ...AGE.map(([, l]) => '#' + l), '#Owed', ''], inv.suppliers.map((x) => { const a = ag(x.id); return `<tr><td><a href="#supplier/${x.id}"><b>${esc(x.name)}</b></a></td><td class="num">${a.not_billed ? num(a.not_billed) : ''}</td>${AGE.map(([k]) => `<td class="num ${k !== 'current' && a[k] ? 'err' : ''}">${a[k] ? num(a[k]) : ''}</td>`).join('')}<td class="num"><b>${num(a.total || 0)}</b></td><td class="right"><a class="btn btn-sm" href="#supplier/${x.id}">Open</a></td></tr>`; }), 'No suppliers. Add them under Items & recipes.')}
      <p class="small muted">As at ${fdate(aging.as_at)}. Add new suppliers under Stores & purchasing → Items & recipes.</p></div>`;
  };

  VIEWS.supplier = async (id) => {
    const d = await GET(`/finance/suppliers/${id}`);
    const m = CAN['finance.manage'];
    return `<div class="page-head"><div><p class="sub"><a href="#payables">← Suppliers &amp; bills</a></p><h1 class="page">${esc(d.supplier.name)}</h1><p class="sub">Owed: <b>${ugx(d.balance)}</b></p></div>
      ${m ? `<div class="row"><button class="btn btn-ghost" data-action="bill-expense" data-id="${id}">+ Bill (services, utilities…)</button><button class="btn btn-gold" data-action="pay-supplier" data-id="${id}">Pay supplier</button></div>` : ''}</div>
      <div class="card"><h2 class="sec">Delivered, waiting for the supplier's invoice</h2>${d.unbilled_grns.length ? `<form class="form" data-form="bill-stock" data-id="${id}">${table(['', 'Delivery', 'Date', 'Delivery note', '#Value'], d.unbilled_grns.map((g) => `<tr><td><input type="checkbox" name="g_${g.id}" value="1" aria-label="Include ${esc(g.code)}"></td><td>${esc(g.code)}</td><td>${fdate(g.business_date)}</td><td>${esc(g.invoice_ref || '')}</td><td class="num">${num(g.total)}</td></tr>`))}
        ${m ? `<div class="two"><label>Supplier's invoice number<input name="bill_number" required maxlength="60"></label><label>Invoice date<input type="date" name="bill_date" value="${SETTINGS.business_date}" max="${SETTINGS.business_date}"></label></div><div class="actions"><button class="btn btn-gold">Record supplier invoice</button></div>` : ''}</form>` : '<p class="muted">Nothing waiting.</p>'}</div>
      <div class="card mt"><h2 class="sec">Bills</h2>${table(['Invoice no.', 'Type', 'Date', 'Due', '#Total', '#VAT', '#Balance', ''], d.bills.map((b) => `<tr><td>${esc(b.bill_number)}</td><td>${b.kind === 'stock' ? 'Stock' : 'Expense'}</td><td>${fdate(b.bill_date)}</td><td>${fdate(b.due_date)}</td><td class="num">${num(b.total)}</td><td class="num">${b.vat ? num(b.vat) : ''}</td>
        <td class="num">${b.status === 'void' ? pill('Void') : b.balance <= 0 ? pill('Paid', 'ok') : num(b.balance)}</td><td class="right">${m && b.status === 'open' && b.balance === b.total ? `<button class="btn btn-sm btn-ghost" data-action="bill-void" data-id="${b.id}">Void</button>` : ''}</td></tr>`), 'No bills.')}</div>
      <div class="card mt"><h2 class="sec">Payments</h2>${table(['Payment', 'Date', 'From', 'Reference', '#Amount', '#Not allocated'], d.payments.map((p) => `<tr><td>${esc(p.number)}</td><td>${fdate(p.payment_date)}</td><td>${esc(p.account_name)}</td><td>${esc(p.reference || '')}</td><td class="num">${num(p.amount)}</td><td class="num">${p.unallocated ? num(p.unallocated) : ''}</td></tr>`), 'No payments.')}</div>`;
  };

  VIEWS.money = async () => {
    const t = cur('money', 'expenses');
    const from = ui.q.moneyFrom || monthStart(), to = ui.q.moneyTo || SETTINGS.business_date;
    const m = CAN['finance.manage'];
    let body;
    if (t === 'expenses') {
      const list = await GET(`/finance/expenses?from=${from}&to=${to}`);
      body = `<div class="row between mb">${rangeForm('money', from, to)}${m ? '<button class="btn btn-gold" data-action="expense">+ Record payment</button>' : ''}</div>${table(['Date', 'Paid to', 'What for', 'Account', 'From', '#VAT', '#Amount'], list.map((e) => `<tr><td>${fdate(e.date)}</td><td>${esc(e.payee)}</td><td>${esc(e.description)}${e.reference ? `<br><span class="small muted">${esc(e.reference)}</span>` : ''}</td><td>${esc(e.account_name)}</td><td>${esc(e.paid_from_name)}</td><td class="num">${e.vat ? num(e.vat) : ''}</td><td class="num">${num(e.amount)}</td></tr>`).concat(list.length ? [`<tr class="total"><td colspan="6">Total</td><td class="num">${num(list.reduce((a, e) => a + e.amount, 0))}</td></tr>`] : []), 'No payments in this period.')}`;
    } else {
      const list = await GET('/finance/transfers');
      body = `<div class="row between mb"><span class="muted">Moving money between cash, bank and mobile money, e.g. banking the cash takings or a card settlement.</span>${m ? '<button class="btn btn-gold" data-action="transfer">+ Transfer</button>' : ''}</div>${table(['Date', 'From', 'To', '#Amount', '#Fee', 'Note'], list.map((x) => `<tr><td>${fdate(x.date)}</td><td>${esc(x.from_name)}</td><td>${esc(x.to_name)}</td><td class="num">${num(x.amount)}</td><td class="num">${x.fee ? num(x.fee) : ''}</td><td>${esc(x.description || '')}</td></tr>`), 'No transfers.')}`;
    }
    return `<div class="page-head"><div><h1 class="page">Expenses &amp; transfers</h1><p class="sub">Payments made directly (petty cash, fuel, VAT to URA, OTA commission…) and transfers between accounts.</p></div></div>
      ${tabs('money', [['expenses', 'Payments out'], ['transfers', 'Transfers']], 'expenses')}<div class="card">${body}</div>`;
  };

  VIEWS.statements = async () => {
    const t = cur('st', 'pl');
    const from = ui.q.stFrom || monthStart(), to = ui.q.stTo || SETTINGS.business_date;
    const section = (title, rows, total, label) => `<tr><td colspan="2"><b>${title}</b></td></tr>${rows.map((r) => `<tr><td>&nbsp;&nbsp;${esc(r.code)} ${esc(r.name)}</td><td class="num">${num(r.amount)}</td></tr>`).join('')}<tr class="total"><td>${label}</td><td class="num">${num(total)}</td></tr>`;
    let body, head = rangeForm('st', from, to);
    if (t === 'pl') {
      const p = await GET(`/finance/pl?from=${from}&to=${to}`);
      body = `<h2 class="sec">Profit &amp; loss · ${fdate(p.from)} to ${fdate(p.to)}</h2><p class="small muted">Revenue is shown before VAT.</p>${table(['', '#UGX'], [section('Revenue', p.revenue, p.total_revenue, 'Total revenue'), section('Cost of sales', p.cost_of_sales, p.total_cost_of_sales, 'Total cost of sales'), `<tr class="total"><td>Gross profit</td><td class="num">${num(p.gross_profit)}</td></tr>`, section('Operating expenses', p.expenses, p.total_expenses, 'Total expenses'), `<tr class="total"><td>Net profit</td><td class="num ${p.net_profit < 0 ? 'err' : ''}">${num(p.net_profit)}</td></tr>`])}`;
    } else if (t === 'bs') {
      const b = await GET(`/finance/balance-sheet?to=${to}`);
      head = `<form class="row no-print" data-form="range" data-key="st"><input type="hidden" name="from" value="${from}"><label class="row small">As at <input class="search" type="date" name="to" value="${to}"></label><button class="btn btn-ghost">Show</button><button type="button" class="btn btn-ghost" data-action="print">Print</button></form>`;
      body = `<h2 class="sec">Balance sheet as at ${fdate(b.as_at)} ${b.balanced ? pill('Balanced', 'ok') : pill('Out of balance', 'bad')}</h2>${table(['', '#UGX'], [section('Assets', b.assets, b.total_assets, 'Total assets'), section('Liabilities', b.liabilities, b.total_liabilities, 'Total liabilities'), section('Equity', [...b.equity, { code: '', name: 'Profit to date (not yet closed to retained earnings)', amount: b.earnings }], b.total_equity, 'Total equity'), `<tr class="total"><td>Liabilities + equity</td><td class="num">${num(b.total_liabilities + b.total_equity)}</td></tr>`])}`;
    } else if (t === 'vat') {
      const v = await GET(`/finance/vat?from=${from}&to=${to}`);
      body = `<h2 class="sec">VAT summary · ${fdate(v.from)} to ${fdate(v.to)}</h2>${table(['', '#UGX'], [['Output VAT on sales (rooms, F&amp;B, invoices)', v.output_vat], ['Input VAT on supplier bills and expenses', v.input_vat], ['<b>Net VAT for the period</b>', v.net_vat], ['Paid to URA in the period', v.paid_to_ura], ['VAT account balance at the end of the period (owed if positive)', v.vat_account_balance]].map(([l, n]) => `<tr><td>${l}</td><td class="num">${num(n)}</td></tr>`))}
        <p class="note">Use this to prepare the URA VAT return. Input VAT on stock deliveries is not split out yet; record supplier VAT on expense bills.</p>`;
    } else {
      const list = await accts();
      const code = ui.q.glCode || '1030';
      const g = await GET(`/finance/ledger/${code}?from=${from}&to=${to}`);
      head = rangeForm('st', from, to, `<select class="search" name="code" aria-label="Account">${opts(list.map((a) => [a.code, `${a.code} ${a.name}`]), code)}</select>`);
      body = `<h2 class="sec">${esc(g.account.code)} ${esc(g.account.name)} · ${fdate(g.from)} to ${fdate(g.to)}</h2>${table(['Date', 'Description', 'By', '#Debit', '#Credit', '#Balance'], [`<tr><td colspan="5">Opening balance</td><td class="num">${num(g.opening)}</td></tr>`, ...g.lines.map((l) => `<tr><td class="nowrap">${fdate(l.date)}</td><td>${esc(l.description)}</td><td class="small">${esc(l.full_name || '')}</td><td class="num">${l.debit ? num(l.debit) : ''}</td><td class="num">${l.credit ? num(l.credit) : ''}</td><td class="num">${num(l.balance)}</td></tr>`), `<tr class="total"><td colspan="5">Closing balance</td><td class="num">${num(g.closing)}</td></tr>`])}`;
    }
    return `<div class="page-head"><div><h1 class="page">Financial statements</h1><p class="sub">Built live from the books. Every figure traces back to its journal entries.</p></div>${head}</div>
      ${tabs('st', [['pl', 'Profit & loss'], ['bs', 'Balance sheet'], ['vat', 'VAT'], ['gl', 'General ledger']], 'pl')}<div class="card">${body}</div>`;
  };

  VIEWS.bankrec = async () => {
    const [list, all] = await Promise.all([GET('/finance/reconciliations'), accts(true)]);
    return `<div class="page-head"><div><h1 class="page">Bank reconciliation</h1><p class="sub">Tick off the books against the bank or mobile money statement until the difference is zero.</p></div></div>
      ${CAN['accounts.journal'] ? `<div class="card mb"><form class="form" data-form="rec-start"><div class="three"><label>Account<select name="account_code">${cashOpts(all, '1030')}</select></label><label>Statement date<input type="date" name="statement_date" value="${SETTINGS.business_date}" required></label><label>Statement closing balance (UGX)<input name="statement_balance" type="number" step="1" required></label></div><div class="actions"><button class="btn btn-gold">Start reconciliation</button></div></form></div>` : ''}
      <div class="card">${table(['Account', 'Statement date', '#Statement balance', 'Status', ''], list.map((r) => `<tr><td>${esc(r.account_name)}</td><td>${fdate(r.sdate)}</td><td class="num">${num(r.statement_balance)}</td><td>${r.status === 'open' ? pill('In progress', 'warn') : pill('Finished', 'ok')}</td><td class="right"><a class="btn btn-sm" href="#rec/${r.id}">${r.status === 'open' ? 'Continue' : 'View'}</a></td></tr>`), 'No reconciliations yet.')}</div>`;
  };

  VIEWS.rec = async (id) => {
    const r = await GET(`/finance/reconciliations/${id}`);
    const open = r.status === 'open' && CAN['accounts.journal'];
    return `<div class="page-head"><div><p class="sub"><a href="#bankrec">← Bank reconciliation</a></p><h1 class="page">${esc(r.account_name)}</h1><p class="sub">Statement ${fdate(r.sdate)}: ${ugx(r.statement_balance)}</p></div></div>
      <div class="grid g3 mb"><div class="card kpi"><span>Cleared balance</span><b>${num(r.cleared_balance)}</b><small>previously cleared ${num(r.opening_cleared)}</small></div><div class="card kpi"><span>Statement balance</span><b>${num(r.statement_balance)}</b><small>UGX</small></div><div class="card kpi"><span>Difference</span><b class="${r.difference ? 'err' : ''}">${num(r.difference)}</b><small>${r.difference ? 'tick items until this is zero' : 'balanced'}</small></div></div>
      <div class="card">${table(['', 'Date', 'Description', '#Money in', '#Money out'], r.items.map((i) => `<tr><td>${open ? `<input type="checkbox" data-action="rec-tick" data-rec="${r.id}" data-line="${i.id}" ${i.cleared ? 'checked' : ''} aria-label="Cleared">` : i.cleared ? '✓' : ''}</td><td class="nowrap">${fdate(i.date)}</td><td>${esc(i.description)}</td><td class="num">${i.debit ? num(i.debit) : ''}</td><td class="num">${i.credit ? num(i.credit) : ''}</td></tr>`), 'Nothing to reconcile up to this date.')}
      ${open ? `<div class="actions mt"><button class="btn btn-gold" data-action="rec-finish" data-id="${r.id}" ${r.difference ? 'disabled' : ''}>Finish reconciliation</button></div><p class="small muted">Bank charges or interest on the statement but not in the books? Record them under Expenses &amp; transfers first.</p>` : ''}</div>`;
  };

  VIEWS.chart = async () => {
    const list = await accts(true);
    const lock = SETTINGS.books_locked_until ? String(SETTINGS.books_locked_until).slice(0, 10) : '';
    return `<div class="page-head"><div><h1 class="page">Chart of accounts</h1><p class="sub">Accounts marked “system” are used automatically and cannot be removed.</p></div><div class="row"><button class="btn btn-ghost" data-action="journal">Manual journal</button><button class="btn btn-gold" data-action="account-edit">+ Account</button></div></div>
      <div class="card mb"><form class="row" data-form="lock"><b>Books closed up to</b><input class="search" type="date" name="until" value="${lock}" max="${addDays(SETTINGS.business_date, -1)}" aria-label="Books closed up to"><button class="btn btn-ghost">Save</button><span class="small muted">Nothing can be posted on or before this date. Only an administrator can reopen a closed date.</span></form></div>
      <div class="card">${table(['Code', 'Account', 'Type', '#Balance', '', ''], list.map((a) => `<tr class="${a.active ? '' : 'void'}"><td>${esc(a.code)}</td><td><b>${esc(a.name)}</b>${a.is_cash ? ' ' + pill('cash/bank', 'info') : ''}</td><td>${esc(a.type)}</td><td class="num">${num(['asset', 'expense'].includes(a.type) ? a.balance : -a.balance)}</td><td>${a.system ? pill('system') : ''}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="account-edit" data-code="${esc(a.code)}">Edit</button></td></tr>`))}</div>`;
  };


  /* ================= PEOPLE (HR & PAYROLL) ================= */
  let HRS = null;
  const hrSetup = async () => (HRS || (HRS = await GET('/hr/setup')));
  const LEAVE_ST = { pending: ['Waiting approval', 'warn'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'bad'], cancelled: ['Cancelled', ''] };
  const PAY_ST = { draft: ['Draft', 'warn'], approved: ['Approved', 'info'], posted: ['Posted', 'ok'], paid: ['Paid', 'ok'] };
  const ATT_ST = { present: ['Present', 'ok'], late: ['Late', 'warn'], absent: ['Absent', 'bad'], leave: ['On leave', 'info'], off: ['Day off', ''], expected: ['Expected', ''], 'not rostered': ['Not rostered', ''] };
  const fmonth = (p) => new Date(p + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const empName = (e) => `${e.first_name} ${e.last_name}`;
  const deptFilter = (key, depts) => `<select class="search" data-action="dept-filter" data-key="${key}" aria-label="Department">${opts([['', 'All departments'], ...depts.map((d) => [d, d])], ui.q[key] || '')}</select>`;
  const weekStart = (d) => { const t = new Date(d + 'T00:00:00Z'); const dow = (t.getUTCDay() + 6) % 7; return addDays(d, -dow); };

  VIEWS.myhr = async () => {
    const [me, setup] = await Promise.all([GET('/hr/me'), hrSetup()]);
    if (!me.linked) return `<div class="page-head"><div><h1 class="page">My HR</h1></div></div><div class="card"><p>Your sign-in is not linked to an employee record yet. Ask HR to link it so you can see your shifts, leave and payslips here.</p></div>`;
    const sh = (id) => setup.shifts.find((x) => x.id === id);
    const att = me.attendance;
    return `<div class="page-head"><div><h1 class="page">Hello, ${esc(me.employee.first_name)}</h1><p class="sub">${esc(me.employee.job_title)} · ${esc(me.employee.department)} · ${esc(me.employee.emp_no)}</p></div></div>
      <div class="grid g3">
        <div class="card kpi"><span>Today</span><b>${att?.clock_out ? 'Signed out' : att?.clock_in ? 'Signed in' : 'Not signed in'}</b><small>${att?.clock_in ? `in ${att.clock_in}` : ''}${att?.clock_out ? ` · out ${att.clock_out}` : ''}</small>
          <div class="row mt">${!att?.clock_in ? '<button class="btn btn-gold" data-action="clock" data-a="in">Sign in</button>' : !att.clock_out ? '<button class="btn" data-action="clock" data-a="out">Sign out</button>' : ''}</div></div>
        <div class="card kpi"><span>Annual leave left (${me.leave_balance.year})</span><b>${me.leave_balance.remaining}</b><small>of ${me.leave_balance.entitlement} days · ${me.leave_balance.pending} waiting approval</small><div class="row mt"><button class="btn btn-ghost" data-action="my-leave">Request leave</button></div></div>
        <div class="card kpi"><span>Latest payslip</span><b>${me.payslips[0] ? num(me.payslips[0].net) : '–'}</b><small>${me.payslips[0] ? 'UGX net, ' + fmonth(me.payslips[0].period) : 'none yet'}</small>${me.payslips[0] ? `<div class="row mt"><a class="btn btn-ghost" href="#payslip/${me.payslips[0].id}">View</a></div>` : ''}</div>
      </div>
      <div class="card mt"><h2 class="sec">My shifts this week</h2>${table(me.week.map((d) => fdate(d.date)), [`<tr>${me.week.map((d) => `<td>${d.leave ? pill('Leave', 'info') : d.shift_id === null ? 'Off' : d.shift_id ? `<b>${esc(sh(d.shift_id)?.name || '')}</b><br><span class="small muted">${sh(d.shift_id)?.start_time}–${sh(d.shift_id)?.end_time}</span>` : '<span class="muted">–</span>'}</td>`).join('')}</tr>`])}</div>
      <div class="grid g2 mt"><div class="card"><h2 class="sec">My leave</h2>${table(['Type', 'Dates', '#Days', 'Status', ''], me.leave.map((l) => `<tr><td>${esc(l.type_name)}</td><td>${fdate(l.f)} → ${fdate(l.t)}</td><td class="num">${l.days}</td><td>${pill(...LEAVE_ST[l.status])}</td><td class="right">${l.status === 'pending' ? `<button class="btn btn-sm btn-ghost" data-action="leave-cancel" data-id="${l.id}">Cancel</button>` : ''}</td></tr>`), 'No leave yet.')}</div>
        <div class="card"><h2 class="sec">My payslips</h2>${table(['Month', '#Net pay', ''], me.payslips.map((p) => `<tr><td>${fmonth(p.period)}</td><td class="num">${num(p.net)}</td><td class="right"><a class="btn btn-sm btn-ghost" href="#payslip/${p.id}">View</a></td></tr>`), 'No payslips yet.')}</div></div>`;
  };

  VIEWS.payslip = async (id) => {
    const [run, emp] = String(id).split('-');
    const p = await GET(`/hr/payslip/${run}${emp ? '?employee_id=' + emp : ''}`);
    const row = (l, v, neg) => v ? `<tr><td>${l}</td><td class="num">${neg ? '(' + num(v) + ')' : num(v)}</td></tr>` : '';
    return `<div class="page-head no-print"><div><p class="sub"><a href="${emp ? '#payrun/' + run : '#myhr'}">← Back</a></p><h1 class="page">Payslip</h1></div><button class="btn btn-ghost" data-action="print">Print / PDF</button></div>
      <div class="card payslip"><div class="inv-head"><div><h2>${esc(SETTINGS.property_name)}</h2><p class="muted">Payslip · ${fmonth(p.period)}${p.status === 'draft' || p.status === 'approved' ? ' · <b class="err">DRAFT</b>' : ''}</p></div>
        <dl class="kv"><dt>Employee</dt><dd>${esc(empName(p))} (${esc(p.emp_no)})</dd><dt>Job</dt><dd>${esc(p.job_title)}, ${esc(p.department)}</dd><dt>TIN</dt><dd>${esc(p.tin || '–')}</dd><dt>NSSF no.</dt><dd>${esc(p.nssf_no || '–')}</dd><dt>Paid by</dt><dd>${p.pay_method === 'bank' ? `${esc(p.bank_name || 'Bank')} ${esc(p.bank_account || '')}` : p.pay_method === 'mobile_money' ? `Mobile money ${esc(p.momo_number || '')}` : 'Cash'}</dd></dl></div>
        <div class="grid g2"><div>${table(['Earnings', '#UGX'], [row(`Basic salary (${p.days_worked - p.unpaid_days} of ${p.days_in_month} days)`, p.basic), row('Allowances', p.allowances), row(`Overtime (${p.overtime_hours} h)`, p.overtime), row('Other additions', p.other_additions), `<tr class="total"><td>Gross pay</td><td class="num">${num(p.gross)}</td></tr>`])}</div>
          <div>${table(['Deductions', '#UGX'], [row('PAYE', p.paye), row('NSSF (5%)', p.nssf_employee), row('Advance recovery', p.advance_recovery), row('Other deductions', p.other_deductions), `<tr class="total"><td>Total deductions</td><td class="num">${num(p.paye + p.nssf_employee + p.advance_recovery + p.other_deductions)}</td></tr>`])}</div></div>
        <div class="net-pay"><span>Net pay</span><b>${ugx(p.net)}</b></div><p class="small muted">Employer NSSF contribution (10%): ${ugx(p.nssf_employer)}. ${p.note ? esc(p.note) : ''}</p></div>`;
  };

  VIEWS.employees = async () => {
    const st = cur('emp', 'active');
    const [list, setup] = await Promise.all([GET(`/hr/employees?status=${st === 'all' ? 'all' : st}`), hrSetup()]);
    const d = ui.q.empDept || '';
    const shown = list.filter((e) => !d || e.department === d);
    return `<div class="page-head"><div><h1 class="page">Employees</h1><p class="sub">${shown.length} shown · monthly basic pay ${ugx(shown.filter((e) => e.status === 'active').reduce((a, e) => a + Number(e.basic_salary || 0), 0))}</p></div>
      <div class="row">${deptFilter('empDept', setup.departments)}${CAN['hr.manage'] ? '<button class="btn btn-gold" data-action="emp-edit">+ Employee</button>' : ''}</div></div>
      ${tabs('emp', [['active', 'Current staff'], ['left', 'Former staff'], ['all', 'All']], 'active')}
      <div class="card">${table(['Employee', 'Department', 'Job', 'Type', 'Started', '#Basic pay', 'Sign-in', ''], shown.map((e) => `<tr><td><a href="#employee/${e.id}"><b>${esc(empName(e))}</b></a><br><span class="small muted">${esc(e.emp_no)}${e.status === 'left' ? ' · left ' + fdate(String(e.end_date).slice(0, 10)) : ''}</span></td><td>${esc(e.department)}</td><td>${esc(e.job_title)}</td><td>${esc(e.employment_type)}</td><td>${fdate(String(e.start_date).slice(0, 10))}</td><td class="num">${num(e.basic_salary)}</td><td>${e.username ? esc(e.username) : '<span class="muted">–</span>'}</td><td class="right"><a class="btn btn-sm btn-ghost" href="#employee/${e.id}">Open</a></td></tr>`), 'No employees.')}</div>`;
  };

  VIEWS.employee = async (id) => {
    const d = await GET(`/hr/employees/${id}`);
    const e = d.employee, m = CAN['hr.manage'];
    const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${k}</dt><dd>${v === null || v === '' ? '–' : v}</dd>`).join('')}</dl>`;
    return `<div class="page-head"><div><p class="sub"><a href="#employees">← Employees</a></p><h1 class="page">${esc(empName(e))}</h1><p class="sub">${esc(e.emp_no)} · ${esc(e.job_title)}, ${esc(e.department)} · ${e.status === 'left' ? pill('Left ' + fdate(String(e.end_date).slice(0, 10))) : pill('Current', 'ok')}</p></div>
      ${m && e.status === 'active' ? `<div class="row"><button class="btn btn-ghost" data-action="emp-edit" data-id="${e.id}">Edit</button><button class="btn btn-ghost" data-action="hr-leave" data-id="${e.id}">Record leave</button><button class="btn btn-bad" data-action="emp-leave" data-id="${e.id}">Leaving the company</button></div>` : ''}</div>
      <div class="grid g3"><div class="card"><h2 class="sec">Personal</h2>${kv([['Gender', esc(e.gender || '')], ['Date of birth', e.date_of_birth ? fdate(String(e.date_of_birth).slice(0, 10)) : ''], ['Phone', esc(e.phone || '')], ['Email', esc(e.email || '')], ['NIN', esc(e.nin || '')], ['TIN', esc(e.tin || '')], ['NSSF no.', esc(e.nssf_no || '')], ['Sign-in', esc(e.username || '')]])}</div>
        <div class="card"><h2 class="sec">Employment & pay</h2>${kv([['Type', esc(e.employment_type)], ['Started', fdate(String(e.start_date).slice(0, 10))], ['Basic (month)', ugx(e.basic_salary)], ['Housing', num(e.housing_allowance)], ['Transport', num(e.transport_allowance)], ['Other allowance', num(e.other_allowance)], ['Paid by', e.pay_method === 'bank' ? `${esc(e.bank_name || 'Bank')} ${esc(e.bank_account || '')}` : e.pay_method === 'mobile_money' ? `Mobile money ${esc(e.momo_number || '')}` : 'Cash'], ['Leaving reason', e.leaving_reason ? esc(e.leaving_reason) : undefined]])}</div>
        <div class="card kpi"><span>Annual leave ${d.leave_balance.year}</span><b>${d.leave_balance.remaining}</b><small>left of ${d.leave_balance.entitlement} · ${d.leave_balance.taken} taken · ${d.leave_balance.pending} pending</small></div></div>
      <div class="grid g2 mt"><div class="card"><h2 class="sec">Leave</h2>${table(['Type', 'Dates', '#Days', 'Status'], d.leave.map((l) => `<tr><td>${esc(l.type_name)}</td><td>${fdate(l.f)} → ${fdate(l.t)}</td><td class="num">${l.days}</td><td>${pill(...LEAVE_ST[l.status])}</td></tr>`), 'None.')}</div>
        <div class="card"><h2 class="sec">Payslips</h2>${table(['Month', '#Gross', '#Net', ''], d.payslips.map((p) => `<tr><td>${fmonth(p.period)}</td><td class="num">${num(p.gross)}</td><td class="num">${num(p.net)}</td><td class="right"><a class="btn btn-sm btn-ghost" href="#payslip/${p.id}-${e.id}">View</a></td></tr>`), 'None yet.')}
        <h2 class="sec mt">Advances</h2>${table(['Date', '#Amount', '#Recovered', '#Per month'], d.advances.map((a) => `<tr><td>${fdate(a.d)}</td><td class="num">${num(a.amount)}</td><td class="num">${num(a.recovered)}</td><td class="num">${num(a.monthly_recovery)}</td></tr>`), 'None.')}</div></div>
      ${e.notes ? `<p class="note mt">${esc(e.notes)}</p>` : ''}`;
  };

  VIEWS.roster = async () => {
    const from = ui.q.rosterFrom || weekStart(SETTINGS.business_date);
    const setup = await hrSetup();
    const d = ui.q.rosterDept || '';
    const wk = await GET(`/hr/roster?from=${from}${d ? '&department=' + encodeURIComponent(d) : ''}`);
    const edit = CAN['roster.manage'];
    const shiftOpts = (v) => opts([['', '–'], ['off', 'Off'], ...setup.shifts.filter((x) => x.active).map((x) => [x.id, `${x.code} ${x.start_time}`])], v === null ? 'off' : v ?? '');
    return `<div class="page-head"><div><h1 class="page">Rosters</h1><p class="sub">Week of ${fdateLong(wk.from)}. ${setup.shifts.map((x) => `<b>${esc(x.code)}</b> ${esc(x.name)} ${x.start_time}–${x.end_time}`).join(' · ')}</p></div>
      <div class="row">${deptFilter('rosterDept', setup.departments)}<button class="btn btn-ghost" data-action="roster-week" data-d="-7">← Previous</button><button class="btn btn-ghost" data-action="roster-week" data-d="7">Next →</button>${edit ? `<button class="btn btn-ghost" data-action="roster-copy" data-from="${wk.from}">Copy last week</button>` : ''}</div></div>
      <form class="card roster" data-form="roster">${table(['Employee', ...wk.days.map(fdate)], wk.employees.map((e) => `<tr><td><b>${esc(empName(e))}</b><br><span class="small muted">${esc(e.department)}</span></td>${e.days.map((x) => `<td>${x.leave ? pill('Leave', 'info') : edit ? `<select name="r_${e.id}_${x.date}" aria-label="${esc(e.first_name)} ${x.date}">${shiftOpts(x.shift_id)}</select>` : x.shift_id === null ? 'Off' : esc(setup.shifts.find((s) => s.id === x.shift_id)?.code || '–')}</td>`).join('')}</tr>`), 'No employees in this department.')}
      ${edit && wk.employees.length ? '<div class="actions mt"><button class="btn btn-gold">Save roster</button></div>' : ''}</form>`;
  };

  VIEWS.attendance = async () => {
    const date = ui.q.attDate || SETTINGS.business_date;
    const setup = await hrSetup();
    const d = ui.q.attDept || '';
    const rows = await GET(`/hr/attendance?date=${date}${d ? '&department=' + encodeURIComponent(d) : ''}`);
    const count = (k) => rows.filter((r) => r.status === k).length;
    return `<div class="page-head"><div><h1 class="page">Attendance</h1><p class="sub">${fdateLong(date)} · late = more than 10 minutes after the shift starts</p></div>
      <div class="row"><form class="row" data-form="att-date"><input class="search" type="date" name="date" value="${date}" aria-label="Date"><button class="btn btn-ghost">Show</button></form>${deptFilter('attDept', setup.departments)}</div></div>
      <div class="grid g4 mb">${[['Present', count('present')], ['Late', count('late')], ['Absent', count('absent')], ['On leave', count('leave')]].map(([l, v]) => `<div class="card kpi"><span>${l}</span><b>${v}</b></div>`).join('')}</div>
      <div class="card">${table(['Employee', 'Shift', 'In', 'Out', '#Hours', 'Status', ''], rows.map((r) => `<tr><td><b>${esc(empName(r))}</b><br><span class="small muted">${esc(r.department)}</span></td><td>${r.shift_name ? `${esc(r.shift_name)} ${r.shift_start}` : r.status === 'off' ? 'Day off' : '–'}</td><td>${r.clock_in || ''}</td><td>${r.clock_out || ''}</td><td class="num">${r.hours ?? ''}</td><td>${pill(...ATT_ST[r.status])}${r.source === 'self' ? ' <span class="small muted">self</span>' : ''}</td>
        <td class="right">${CAN['attendance.record'] ? `<button class="btn btn-sm btn-ghost" data-action="att-edit" data-id="${r.id}" data-name="${esc(empName(r))}" data-date="${date}" data-in="${r.clock_in || ''}" data-out="${r.clock_out || ''}">Record</button>` : ''}</td></tr>`), 'Nobody employed on this date.')}</div>`;
  };

  VIEWS.leave = async () => {
    const v = cur('lv', 'pending');
    const list = await GET(`/hr/leave?view=${v}`);
    return `<div class="page-head"><div><h1 class="page">Leave</h1><p class="sub">Managers approve; nobody approves their own leave. Unpaid leave is deducted in payroll automatically.</p></div></div>
      ${tabs('lv', [['pending', 'Waiting approval'], ['upcoming', 'Approved & upcoming'], ['all', 'All']], 'pending')}
      <div class="card">${table(['Employee', 'Type', 'Dates', '#Days', 'Reason', 'Status', ''], list.map((l) => `<tr><td><a href="#employee/${l.employee_id}">${esc(empName(l))}</a><br><span class="small muted">${esc(l.department)}</span></td><td>${esc(l.type_name)}</td><td>${fdate(l.f)} → ${fdate(l.t)}</td><td class="num">${l.days}</td><td>${esc(l.reason || '')}${l.decision_note ? `<br><span class="small muted">${esc(l.decision_note)}</span>` : ''}</td><td>${pill(...LEAVE_ST[l.status])}${l.decided_by_name ? `<br><span class="small muted">${esc(l.decided_by_name)}</span>` : ''}</td>
        <td class="right nowrap">${l.status === 'pending' && CAN['hr.approve'] && (l.user_id !== ME.id || ME.role === 'admin') ? `<button class="btn btn-sm btn-ok" data-action="leave-decide" data-id="${l.id}" data-d="approved">Approve</button> <button class="btn btn-sm btn-bad" data-action="leave-decide" data-id="${l.id}" data-d="rejected">Reject</button>` : ''}${CAN['hr.manage'] && ['pending', 'approved'].includes(l.status) && l.f > SETTINGS.business_date ? ` <button class="btn btn-sm btn-ghost" data-action="leave-cancel" data-id="${l.id}">Cancel</button>` : ''}</td></tr>`), 'Nothing here.')}</div>`;
  };

  VIEWS.payroll = async () => {
    const t = cur('pr', 'runs');
    let body;
    if (t === 'runs') {
      const runs = await GET('/hr/payroll');
      body = `${CAN['payroll.manage'] ? `<form class="row mb" data-form="new-run"><input class="search" type="month" name="period" value="${SETTINGS.business_date.slice(0, 7)}" max="${SETTINGS.business_date.slice(0, 7)}" aria-label="Month"><button class="btn btn-gold">Prepare payroll</button></form>` : ''}
        ${table(['Month', 'Status', '#Staff', '#Gross', '#Net pay', 'Prepared by', ''], runs.map((r) => `<tr><td><b>${fmonth(r.period)}</b></td><td>${pill(...PAY_ST[r.status])}</td><td class="num">${r.employees}</td><td class="num">${num(r.gross)}</td><td class="num">${num(r.net)}</td><td>${esc(r.created_by_name || '')}</td><td class="right"><a class="btn btn-sm" href="#payrun/${r.id}">Open</a></td></tr>`), 'No payrolls yet.')}`;
    } else {
      const [adv, emps] = await Promise.all([GET('/hr/advances'), GET('/hr/employees')]);
      body = `${CAN['payroll.manage'] ? `<div class="row between mb"><span class="muted">Advances are recovered automatically from each payroll until repaid.</span><button class="btn btn-gold" data-action="advance" data-emps='${esc(JSON.stringify(emps.map((e) => [e.id, empName(e)])))}'>+ Advance</button></div>` : ''}
        ${table(['Date', 'Employee', 'Reason', '#Amount', '#Per month', '#Recovered', '#Still owed'], adv.map((a) => `<tr><td>${fdate(a.d)}</td><td>${esc(empName(a))}</td><td>${esc(a.reason || '')}</td><td class="num">${num(a.amount)}</td><td class="num">${num(a.monthly_recovery)}</td><td class="num">${num(a.recovered)}</td><td class="num">${a.amount - a.recovered ? num(a.amount - a.recovered) : pill('Repaid', 'ok')}</td></tr>`), 'No advances.')}`;
    }
    return `<div class="page-head"><div><h1 class="page">Payroll</h1><p class="sub">Prepare → approve (someone else) → post to the accounts → pay. PAYE and NSSF are calculated automatically.</p></div></div>
      ${tabs('pr', [['runs', 'Monthly payroll'], ['advances', 'Staff advances']], 'runs')}<div class="card">${body}</div>`;
  };

  VIEWS.payrun = async (id) => {
    const r = await GET(`/hr/payroll/${id}`);
    const t = cur('payrun', 'lines');
    const draft = r.status === 'draft' && CAN['payroll.manage'];
    const acts = [];
    if (draft) acts.push(`<button class="btn btn-ghost" data-action="run-act" data-id="${r.id}" data-a="refresh">Refresh from staff records</button>`);
    if (r.status === 'draft' && CAN['hr.approve'] && (r.created_by !== ME.id || ME.role === 'admin')) acts.push(`<button class="btn btn-gold" data-action="run-act" data-id="${r.id}" data-a="approve">Approve</button>`);
    if (r.status === 'approved' && (CAN['hr.approve'] || CAN['payroll.manage'])) acts.push(`<button class="btn btn-ghost" data-action="run-act" data-id="${r.id}" data-a="reopen">Back to draft</button>`);
    if (r.status === 'approved' && CAN['payroll.manage']) acts.push(`<button class="btn btn-gold" data-action="run-act" data-id="${r.id}" data-a="post">Post to accounts</button>`);
    if (r.status === 'posted' && CAN['payroll.manage']) acts.push(`<button class="btn btn-gold" data-action="run-pay" data-id="${r.id}">Mark salaries paid</button>`);
    if (['draft', 'approved'].includes(r.status) && CAN['payroll.manage']) acts.push(`<button class="btn btn-ghost" data-action="run-act" data-id="${r.id}" data-a="void">Delete</button>`);
    acts.push('<button class="btn btn-ghost" data-action="print">Print</button>');
    const T = r.totals;
    let body;
    if (t === 'lines') body = table(['Employee', '#Days', '#Basic', '#Allow.', '#Overtime', '#Gross', '#NSSF 5%', '#PAYE', '#Advance', '#Other ded.', '#Net', ''], r.lines.map((l) => `<tr><td><b>${esc(empName(l))}</b><br><span class="small muted">${esc(l.department)}${l.unpaid_days ? ` · ${l.unpaid_days} unpaid day(s)` : ''}</span></td><td class="num">${l.days_worked}/${l.days_in_month}</td><td class="num">${num(l.basic)}</td><td class="num">${num(l.allowances)}</td><td class="num">${l.overtime ? num(l.overtime) + `<br><span class="small muted">${l.overtime_hours} h</span>` : ''}</td><td class="num">${num(l.gross)}</td><td class="num">${num(l.nssf_employee)}</td><td class="num">${num(l.paye)}</td><td class="num">${l.advance_recovery ? num(l.advance_recovery) : ''}</td><td class="num">${l.other_deductions ? num(l.other_deductions) : ''}${l.other_additions ? `<br><span class="small muted">+${num(l.other_additions)} added</span>` : ''}</td><td class="num"><b>${num(l.net)}</b></td>
        <td class="right nowrap">${draft ? `<button class="btn btn-sm btn-ghost" data-action="line-edit" data-run="${r.id}" data-emp="${l.employee_id}" data-name="${esc(empName(l))}" data-ot="${l.overtime_hours}" data-add="${l.other_additions}" data-ded="${l.other_deductions}" data-note="${esc(l.note || '')}">Adjust</button>` : ''} <a class="btn btn-sm btn-ghost" href="#payslip/${r.id}-${l.employee_id}">Slip</a></td></tr>`).concat([`<tr class="total"><td>Totals (${T.employees})</td><td></td><td></td><td></td><td></td><td class="num">${num(T.gross)}</td><td class="num">${num(T.nssf_employee)}</td><td class="num">${num(T.paye)}</td><td class="num">${num(T.advance_recovery)}</td><td class="num">${num(T.other_deductions)}</td><td class="num">${num(T.net)}</td><td></td></tr>`]));
    else if (t === 'paye') body = `<p class="small muted">PAYE schedule for the URA return.</p>${table(['Employee', 'TIN', '#Gross pay', '#PAYE'], r.lines.map((l) => `<tr><td>${esc(empName(l))}</td><td>${esc(l.tin || '–')}</td><td class="num">${num(l.gross)}</td><td class="num">${num(l.paye)}</td></tr>`).concat([`<tr class="total"><td colspan="2">Total</td><td class="num">${num(T.gross)}</td><td class="num">${num(T.paye)}</td></tr>`]))}`;
    else if (t === 'nssf') body = `<p class="small muted">NSSF schedule: 5% employee + 10% employer.</p>${table(['Employee', 'NSSF no.', '#Gross pay', '#Employee 5%', '#Employer 10%', '#Total'], r.lines.map((l) => `<tr><td>${esc(empName(l))}</td><td>${esc(l.nssf_no || '–')}</td><td class="num">${num(l.gross)}</td><td class="num">${num(l.nssf_employee)}</td><td class="num">${num(l.nssf_employer)}</td><td class="num">${num(l.nssf_employee + l.nssf_employer)}</td></tr>`).concat([`<tr class="total"><td colspan="3">Total</td><td class="num">${num(T.nssf_employee)}</td><td class="num">${num(T.nssf_employer)}</td><td class="num">${num(T.nssf_employee + T.nssf_employer)}</td></tr>`]))}`;
    else if (t === 'bank') body = `<p class="small muted">Payment list for the bank and mobile money.</p>${table(['Employee', 'Method', 'Bank / number', '#Net pay'], r.lines.map((l) => `<tr><td>${esc(empName(l))}</td><td>${{ bank: 'Bank', mobile_money: 'Mobile money', cash: 'Cash' }[l.pay_method]}</td><td>${l.pay_method === 'bank' ? `${esc(l.bank_name || '')} ${esc(l.bank_account || '')}` : esc(l.momo_number || '')}</td><td class="num">${num(l.net)}</td></tr>`).concat([`<tr class="total"><td colspan="3">Total</td><td class="num">${num(T.net)}</td></tr>`]))}`;
    else body = table(['Department', '#Staff', '#Gross pay', '#Cost incl. employer NSSF'], r.departments.map((x) => `<tr><td>${esc(x.department)}</td><td class="num">${x.employees}</td><td class="num">${num(x.gross)}</td><td class="num">${num(x.employer_cost)}</td></tr>`));
    return `<div class="page-head"><div><p class="sub"><a href="#payroll">← Payroll</a></p><h1 class="page">Payroll ${fmonth(r.period)}</h1><p class="sub">${pill(...PAY_ST[r.status])} · prepared by ${esc(r.created_by_name || '')}${r.approved_by_name ? ' · approved by ' + esc(r.approved_by_name) : ''}${r.posted_by_name ? ' · posted by ' + esc(r.posted_by_name) : ''}</p></div><div class="row no-print">${acts.join('')}</div></div>
      <div class="grid g4 mb">${[['Gross pay', T.gross], ['PAYE to URA', T.paye], ['NSSF (15%)', T.nssf_employee + T.nssf_employer], ['Net pay to staff', T.net]].map(([l, v]) => `<div class="card kpi"><span>${l}</span><b>${num(v)}</b><small>UGX</small></div>`).join('')}</div>
      ${tabs('payrun', [['lines', 'Payroll'], ['paye', 'PAYE schedule'], ['nssf', 'NSSF schedule'], ['bank', 'Payment list'], ['dept', 'By department']], 'lines')}<div class="card">${body}</div>
      <p class="small muted">PAYE uses the Uganda monthly resident bands and NSSF 5% + 10% of gross. Confirm current rates with URA and NSSF.</p>`;
  };

  /* ---------- forms & actions ---------- */
  async function newReservation() {
    const types = (await GET('/room-types')).filter((t) => t.active);
    const bd = SETTINGS.business_date;
    modal('New reservation', `<form class="form" data-form="new-res">
      <div class="two"><label>First name<input name="first_name" required maxlength="80"></label><label>Last name<input name="last_name" maxlength="80"></label></div>
      <div class="two"><label>Phone<input name="phone" maxlength="40" placeholder="+256 …"></label><label>Email<input name="email" type="email" maxlength="120"></label></div>
      <div class="two"><label>Arrival<input type="date" name="arrival" value="${bd}" min="${bd}" required></label><label>Departure<input type="date" name="departure" value="${addDays(bd, 1)}" min="${addDays(bd, 1)}" required></label></div>
      <div class="two"><label>Room type<select name="room_type_id">${opts(types.map((t) => [t.id, `${t.name} · ${num(t.base_rate)}`]))}</select></label><label>Nightly rate (blank = standard)<input name="rate" type="number" min="0" step="1"></label></div>
      <div class="two"><label>Adults<input name="adults" type="number" min="1" value="2"></label><label>Source<select name="source">${opts(['Direct', 'Walk-in', 'Phone', 'Website', 'Booking.com', 'Expedia', 'Airbnb', 'Corporate', 'Travel agent'].map((s) => [s, s]))}</select></label></div>
      <label>Company (if billing a company)<input name="company_name" maxlength="120"></label>
      <label>Notes<textarea name="notes" rows="2" maxlength="1000"></textarea></label>
      <div class="actions">${cancelBtn}<button class="btn btn-gold">Save reservation</button></div></form>`,
      async (f) => {
        const r = await POST('/reservations', { guest: { first_name: f.first_name, last_name: f.last_name, phone: f.phone, email: f.email }, arrival: f.arrival, departure: f.departure, room_type_id: Number(f.room_type_id), rate: f.rate === '' ? null : Number(f.rate), adults: Number(f.adults), source: f.source, company_name: f.company_name, notes: f.notes });
        location.hash = `#res/${r.id}`; return `Reservation ${esc(r.code)} saved.`;
      });
  }
  async function checkInForm(id) {
    const [f, rooms] = await Promise.all([GET(`/reservations/${id}`), GET('/room-board')]);
    const r = f.reservation;
    const free = rooms.rooms.filter((x) => !x.reservation_id && x.hk_status !== 'out_of_order');
    const sameType = free.filter((x) => x.type_code === r.room_type_code), others = free.filter((x) => x.type_code !== r.room_type_code);
    const label = (x) => `${x.number} · ${x.type_name}${x.hk_status === 'dirty' ? ' (not cleaned)' : ''}`;
    const best = sameType.find((x) => x.hk_status === 'clean') || sameType[0] || free[0];
    modal(`Check in · ${guestName(r)}`, `<form class="form" data-form="check-in">
      <dl class="kv"><dt>Stay</dt><dd>${fdate(r.arrival)} → ${fdate(r.departure)}</dd><dt>Booked</dt><dd>${esc(r.room_type_name)} · ${ugx(r.rate)}/night</dd></dl>
      <label>Room<select name="room_id" required>${sameType.length ? `<optgroup label="${esc(r.room_type_name)}">${opts(sameType.map((x) => [x.id, label(x)]), best?.id)}</optgroup>` : ''}${others.length ? `<optgroup label="Other types (upgrade/move)">${opts(others.map((x) => [x.id, label(x)]), best?.id)}</optgroup>` : ''}</select></label>
      <div class="two"><label>ID type<select name="id_type">${opts([['', '–'], ['National ID', 'National ID'], ['Passport', 'Passport'], ['Driving permit', 'Driving permit']], r.id_type || '')}</select></label><label>ID number<input name="id_number" value="${esc(r.id_number || '')}" maxlength="60"></label></div>
      <label class="row"><input type="checkbox" name="allow_dirty" value="1"> Allow a room that has not been cleaned yet</label>
      <div class="actions">${cancelBtn}<button class="btn btn-gold" ${free.length ? '' : 'disabled'}>Check in</button></div></form>`,
      async (v) => { const res = await POST(`/reservations/${id}/check-in`, { room_id: Number(v.room_id), allow_dirty: !!v.allow_dirty, guest: { id_type: v.id_type || null, id_number: v.id_number || null } }); return `Checked in to room ${esc(res.room)}.`; });
  }
  async function paymentForm(id, bal, company) {
    const cos = (await GET('/finance/companies').catch(() => [])).filter((c) => c.active);
    const pre = cos.find((c) => c.name === company);
    modal('Take payment', `<form class="form" data-form="pay">
      <div class="two"><label>Amount (UGX)<input name="amount" type="number" min="1" step="1" value="${Math.max(0, bal)}" required></label><label>Method<select name="method">${opts(Object.entries(METHOD), 'cash')}</select></label></div>
      <div class="two"><label>Reference (receipt / transaction no.)<input name="reference" maxlength="80"></label><label>Company (for company account)<select name="company_id">${opts([['', '–'], ...cos.map((c) => [c.id, c.name])], pre?.id || '')}</select></label></div>
      <p class="note">“Company account” moves the balance to the company's account to invoice later.</p>
      <div class="actions">${cancelBtn}<button class="btn btn-gold">Record payment</button></div></form>`,
      async (v) => { await POST(`/reservations/${id}/payments`, { amount: Number(v.amount), method: v.method, reference: v.reference, company_id: v.company_id ? Number(v.company_id) : undefined }); return `${ugx(v.amount)} recorded.`; });
  }

  /* ---------- Phase 7: amenities, events, maintenance, assets ---------- */
  const AM_CAT = { spa: 'Spa', transport: 'Transport', tour: 'Tours', laundry: 'Laundry', leisure: 'Leisure', other: 'Other' };
  const AB_ST = { booked: ['Booked', 'info'], completed: ['Done', 'ok'], cancelled: ['Cancelled', ''], no_show: ['No-show', 'bad'] };
  const SETTLE = { room: 'Charged to room', cash: 'Cash', card: 'Card', mobile_money: 'Mobile money' };
  const EV_ST = { enquiry: ['Enquiry', ''], tentative: ['Tentative', 'warn'], confirmed: ['Confirmed', 'info'], completed: ['Completed', 'ok'], cancelled: ['Cancelled', 'bad'] };
  const EV_TYPE = { conference: 'Conference', meeting: 'Meeting', wedding: 'Wedding', party: 'Party', workshop: 'Workshop', other: 'Other' };
  const HIRE = { none: 'No room hire', half_day: 'Half day', full_day: 'Full day' };
  const BEO = [['kitchen', 'Kitchen'], ['service', 'Service / banqueting'], ['bar', 'Bar'], ['housekeeping', 'Housekeeping'], ['technical', 'Technical / AV'], ['front_office', 'Front office']];
  const WO_ST = { open: ['Open', 'info'], in_progress: ['In progress', 'warn'], on_hold: ['On hold', ''], done: ['Done', 'ok'], cancelled: ['Cancelled', ''] };
  const PRIO = { urgent: ['Urgent', 'bad'], high: ['High', 'warn'], normal: ['Normal', ''], low: ['Low', ''] };
  const AS_CAT = { building: 'Building', furniture: 'Furniture & fittings', equipment: 'Equipment', kitchen: 'Kitchen', vehicle: 'Vehicles', it: 'IT', other: 'Other' };
  const AS_ST = { in_use: ['In use', 'ok'], under_repair: ['Under repair', 'warn'], disposed: ['Disposed', ''] };
  const cashList = (list) => list.map((a) => [a.code, `${a.code} ${a.name}`]);

  VIEWS.amenities = async () => {
    const t = cur('am', 'day');
    const head = `<div class="page-head"><div><h1 class="page">Amenities &amp; services</h1><p class="sub">Spa, transfers, tours, laundry and passes. Charge to the guest's room or take payment on the spot.</p></div>
      <div class="row"><button class="btn btn-gold" data-action="am-book">+ Book a service</button></div></div>
      ${CAN['amenities.manage'] ? tabs('am', [['day', 'Bookings'], ['list', 'Price list']], 'day') : ''}`;
    if (t === 'list' && CAN['amenities.manage']) {
      const list = await GET('/ops/amenities?all=1'); ui.amList = list;
      return head + `<div class="card"><div class="row between"><h2 class="sec">Price list</h2><button class="btn btn-sm" data-action="am-edit">+ Add service</button></div>
        ${table(['Service', 'Category', '#Price (VAT incl.)', 'Duration', 'Status', ''], list.map((a) => `<tr><td>${esc(a.name)}${a.description ? `<br><span class="small muted">${esc(a.description)}</span>` : ''}</td><td>${AM_CAT[a.category]}</td><td class="num">${num(a.price)}</td><td>${a.duration_min ? `${a.duration_min} min` : ''}</td><td>${a.active ? pill('Active', 'ok') : pill('Hidden')}</td><td class="right"><button class="btn btn-sm btn-ghost" data-action="am-edit" data-id="${a.id}">Edit</button></td></tr>`))}</div>`;
    }
    const d = await GET(`/ops/amenity-bookings?date=${ui.q.amDate || SETTINGS.business_date}`);
    ui.amDay = d;
    return head + `<div class="card"><form class="form row" data-form="am-date"><label>Date<input type="date" name="date" value="${d.date}"></label><button class="btn btn-ghost">Show</button></form></div>
      <div class="grid g3 mt"><div class="card kpi"><span>Still to deliver</span><b>${num(d.totals.booked)}</b><small>UGX booked</small></div><div class="card kpi"><span>Sold</span><b>${num(d.totals.completed)}</b><small>UGX completed</small></div><div class="card kpi"><span>Charged to rooms</span><b>${num(d.totals.room)}</b><small>UGX on guest bills</small></div></div>
      <div class="card mt">${table(['Time', 'Service', 'Guest', 'Staff', '#Amount', 'Status', ''], d.bookings.map((b) => `<tr><td>${esc(b.time || 'Any time')}</td><td>${esc(b.amenity)}${b.qty > 1 ? ` × ${b.qty}` : ''}<br><span class="small muted">${esc(b.code)}</span></td>
        <td>${esc(b.guest_name)}${b.room ? `<br><span class="small muted">Room ${esc(b.room)}</span>` : ''}</td><td>${esc(b.staff || '')}</td><td class="num">${num(b.amount)}</td>
        <td>${pill(...AB_ST[b.status])}${b.settled_by ? `<br><span class="small muted">${SETTLE[b.settled_by]}</span>` : ''}</td>
        <td class="right nowrap">${b.status === 'booked' ? `<button class="btn btn-sm btn-ok" data-action="am-done" data-id="${b.id}">Done</button> <button class="btn btn-sm btn-ghost" data-action="am-close" data-id="${b.id}" data-s="no_show">No-show</button> <button class="btn btn-sm btn-ghost" data-action="am-close" data-id="${b.id}" data-s="cancelled">Cancel</button>` : ''}</td></tr>`), 'No services booked for this day.')}</div>`;
  };

  VIEWS.events = async () => {
    const t = cur('ev', 'upcoming');
    const head = `<div class="page-head"><div><h1 class="page">Events &amp; banqueting</h1><p class="sub">Conferences, weddings and functions: quote, hold the room, take deposits, print the event order and bill.</p></div>
      <div class="row">${CAN['events.manage'] ? '<a class="btn btn-gold" href="#eventedit/new">+ New event</a>' : ''}</div></div>
      ${tabs('ev', [['upcoming', 'Upcoming'], ['enquiries', 'Enquiries & tentative'], ['due', 'To bill'], ['past', 'Past'], ['setup', 'Rooms & packages']], 'upcoming')}`;
    if (t === 'setup') {
      const s = await GET('/ops/events/setup'); ui.evSetup = s;
      const m = CAN['events.manage'];
      return head + `<div class="grid g2"><div class="card"><div class="row between"><h2 class="sec">Function rooms</h2>${m ? '<button class="btn btn-sm" data-action="fr-edit">+ Add</button>' : ''}</div>
        ${table(['Room', '#Capacity', '#Full day', '#Half day', ''], s.rooms.map((r) => `<tr><td>${esc(r.name)}${r.active ? '' : ' ' + pill('Hidden')}</td><td class="num">${r.capacity}</td><td class="num">${num(r.hire_full_day)}</td><td class="num">${num(r.hire_half_day)}</td><td class="right">${m ? `<button class="btn btn-sm btn-ghost" data-action="fr-edit" data-id="${r.id}">Edit</button>` : ''}</td></tr>`))}</div>
        <div class="card"><div class="row between"><h2 class="sec">Packages (per guest)</h2>${m ? '<button class="btn btn-sm" data-action="pk-edit">+ Add</button>' : ''}</div>
        ${table(['Package', '#Per guest', ''], s.packages.map((p) => `<tr><td>${esc(p.name)}${p.active ? '' : ' ' + pill('Hidden')}${p.includes ? `<br><span class="small muted">${esc(p.includes)}</span>` : ''}</td><td class="num">${num(p.per_person)}</td><td class="right">${m ? `<button class="btn btn-sm btn-ghost" data-action="pk-edit" data-id="${p.id}">Edit</button>` : ''}</td></tr>`))}</div></div>`;
    }
    const d = await GET(`/ops/events?filter=${t}`);
    return head + `<div class="card">${table(['Date', 'Event', 'Room', '#Guests', '#Total', '#Deposits', 'Status'], d.events.map((e) => `<tr><td class="nowrap">${fdate(e.d)}<br><span class="small muted">${esc(e.start)}–${esc(e.end)}</span></td>
      <td><a href="#event/${e.id}">${esc(e.title)}</a><br><span class="small muted">${esc(e.code)} · ${esc(e.company_name || e.contact_name)}</span></td><td>${esc(e.room_name)}</td><td class="num">${e.pax}</td><td class="num">${num(e.total)}</td><td class="num">${num(e.deposits)}</td><td>${pill(...EV_ST[e.status])}</td></tr>`), t === 'due' ? 'No confirmed events waiting to be billed.' : 'No events here.')}</div>`;
  };

  VIEWS.eventedit = async (id) => {
    const s = await GET('/ops/events/setup');
    const x = id && id !== 'new' ? await GET(`/ops/events/${id}`) : null;
    const e = x?.event || { event_type: 'conference', status: 'enquiry', d: SETTINGS.business_date, start: '09:00', end: '17:00', hire_type: 'full_day', beo_notes: {} };
    const extras = [...(x?.extras || []), {}, {}, {}].slice(0, Math.max(3, (x?.extras?.length || 0) + 1));
    return `<div class="page-head"><div><h1 class="page">${x ? `Edit ${esc(e.code)}` : 'New event'}</h1><p class="sub">The function room is held once the event is tentative or confirmed. Enquiries do not block the room.</p></div><a class="btn btn-ghost" href="${x ? `#event/${e.id}` : '#events'}">Back</a></div>
      <form class="form" data-form="event" data-id="${x ? e.id : ''}">
      <div class="card"><h2 class="sec">Booking</h2>
        <div class="two"><label>Event name<input name="title" value="${esc(e.title || '')}" required maxlength="150"></label><label>Type<select name="event_type">${opts(Object.entries(EV_TYPE), e.event_type)}</select></label></div>
        <div class="three"><label>Date<input type="date" name="event_date" value="${esc(e.d)}" required></label><label>Starts<input type="time" name="start_time" value="${esc(e.start)}" required></label><label>Ends<input type="time" name="end_time" value="${esc(e.end)}" required></label></div>
        <div class="three"><label>Function room<select name="function_room_id" required>${opts(s.rooms.filter((r) => r.active || r.id === e.function_room_id).map((r) => [r.id, `${r.name} (up to ${r.capacity})`]), e.function_room_id)}</select></label><label>Guests<input type="number" name="pax" min="1" value="${e.pax || ''}" required></label><label>Status<select name="status">${opts([['enquiry', 'Enquiry'], ['tentative', 'Tentative (hold room)'], ['confirmed', 'Confirmed']], e.status)}</select></label></div>
        <label>Set-up<input name="setup_style" value="${esc(e.setup_style || '')}" placeholder="Theatre, classroom, banquet rounds, U-shape, cocktail" maxlength="60"></label></div>
      <div class="card mt"><h2 class="sec">Client</h2>
        <div class="two"><label>Contact person<input name="contact_name" value="${esc(e.contact_name || '')}" required></label><label>Company account (to invoice)<select name="company_id"><option value="">Private client</option>${opts(s.companies.map((c) => [c.id, c.name]), e.company_id)}</select></label></div>
        <div class="two"><label>Phone<input name="contact_phone" value="${esc(e.contact_phone || '')}"></label><label>Email<input type="email" name="contact_email" value="${esc(e.contact_email || '')}"></label></div></div>
      <div class="card mt"><h2 class="sec">Price</h2>
        <div class="three"><label>Package<select name="package_id"><option value="">No package</option>${opts(s.packages.filter((p) => p.active || p.id === e.package_id).map((p) => [p.id, `${p.name} (${num(p.per_person)})`]), e.package_id)}</select></label>
        <label>Price per guest (UGX)<input type="number" name="per_person" min="0" value="${x ? e.per_person : ''}" placeholder="From the package"></label>
        <label>Room hire<select name="hire_type">${opts(Object.entries(HIRE), e.hire_type)}</select></label></div>
        <label>Room hire amount (UGX)<input type="number" name="room_hire" min="0" value="${x ? e.room_hire : ''}" placeholder="From the room's rate"></label>
        <p class="small muted">Extras (décor, equipment, printing). All prices include VAT.</p>
        ${extras.map((ex, i) => `<div class="three"><label>Extra<input name="xd_${i}" value="${esc(ex.description || '')}"></label><label>Qty<input type="number" min="1" name="xq_${i}" value="${ex.qty || 1}"></label><label>Price each<input type="number" min="0" name="xp_${i}" value="${ex.unit_price ?? ''}"></label></div>`).join('')}</div>
      <div class="card mt"><h2 class="sec">Event order: instructions by department</h2><div class="two">${BEO.map(([k, l]) => `<label>${l}<textarea name="beo_${k}" rows="3">${esc(e.beo_notes?.[k] || '')}</textarea></label>`).join('')}</div>
        <label>Internal notes<textarea name="notes" rows="2">${esc(e.notes || '')}</textarea></label>
        <div class="actions"><button class="btn btn-gold">Save event</button></div></div></form>`;
  };

  VIEWS.event = async (id) => {
    const { event: e, totals: t, extras, payments } = await GET(`/ops/events/${id}`);
    const open = ['enquiry', 'tentative', 'confirmed'].includes(e.status), m = CAN['events.manage'];
    const due = e.status === 'confirmed' && e.d <= SETTINGS.business_date;
    return `<div class="page-head"><div><h1 class="page">${esc(e.title)}</h1><p class="sub">${esc(e.code)} · ${fdateLong(e.d)} · ${esc(e.start)}–${esc(e.end)} · ${esc(e.room_name)} ${pill(...EV_ST[e.status])}</p></div>
      <div class="row"><a class="btn btn-ghost" href="#beo/${e.id}">Event order (BEO)</a>${open && m ? `<a class="btn btn-ghost" href="#eventedit/${e.id}">Edit</a><button class="btn" data-action="ev-pay" data-id="${e.id}" data-k="deposit">Take deposit</button>${t.deposits > 0 ? `<button class="btn btn-ghost" data-action="ev-pay" data-id="${e.id}" data-k="refund">Refund</button>` : ''}` : ''}
      ${due && m ? `<button class="btn btn-gold" data-action="ev-complete" data-id="${e.id}" data-bal="${t.balance}" data-co="${e.company_id || ''}">Complete &amp; bill</button>` : ''}${open && m ? `<button class="btn btn-bad" data-action="ev-cancel" data-id="${e.id}" data-dep="${t.deposits}">Cancel event</button>` : ''}</div></div>
      <div class="grid g4"><div class="card kpi"><span>Total</span><b>${num(t.total)}</b><small>UGX incl. VAT</small></div><div class="card kpi"><span>Deposits held</span><b>${num(t.deposits)}</b><small>UGX</small></div><div class="card kpi"><span>Balance</span><b>${num(t.balance)}</b><small>${e.invoice_number ? `Invoiced: ${esc(e.invoice_number)}` : 'UGX'}</small></div><div class="card kpi"><span>Guests</span><b>${e.pax}</b><small>${esc(e.setup_style || '')}</small></div></div>
      <div class="grid g2 mt"><div class="card"><h2 class="sec">Quote</h2>${table(['Item', '#Qty', '#Price', '#Amount'], [
        `<tr><td>${esc(e.package_name || 'Food & beverage per guest')}</td><td class="num">${e.pax}</td><td class="num">${num(e.per_person)}</td><td class="num">${num(t.package)}</td></tr>`,
        ...(e.room_hire ? [`<tr><td>Room hire: ${esc(e.room_name)} (${HIRE[e.hire_type].toLowerCase()})</td><td class="num">1</td><td class="num">${num(e.room_hire)}</td><td class="num">${num(e.room_hire)}</td></tr>`] : []),
        ...extras.map((x) => `<tr><td>${esc(x.description)}</td><td class="num">${x.qty}</td><td class="num">${num(x.unit_price)}</td><td class="num">${num(x.qty * x.unit_price)}</td></tr>`),
        `<tr class="total"><td colspan="3">Total (VAT included)</td><td class="num">${num(t.total)}</td></tr>`])}</div>
      <div class="card"><h2 class="sec">Client</h2><p>${esc(e.contact_name)}${e.company_name ? ` · <b>${esc(e.company_name)}</b>` : ''}<br>${esc(e.contact_phone || '')} ${esc(e.contact_email || '')}</p>
        <h2 class="sec mt">Deposits &amp; refunds</h2>${table(['Date', 'Type', 'Account', '#Amount'], payments.map((p) => `<tr><td>${fdate(p.d)}</td><td>${p.kind === 'deposit' ? 'Deposit' : 'Refund'}${p.reference ? `<br><span class="small muted">${esc(p.reference)}</span>` : ''}</td><td>${esc(p.account_name)}</td><td class="num">${p.kind === 'refund' ? '−' : ''}${num(p.amount)}</td></tr>`), 'No deposits yet.')}
        ${e.cancel_reason ? `<p class="note err">Cancelled: ${esc(e.cancel_reason)}</p>` : ''}${e.notes ? `<p class="small muted">${esc(e.notes)}</p>` : ''}</div></div>`;
  };

  VIEWS.beo = async (id) => {
    const { event: e, extras } = await GET(`/ops/events/${id}`);
    const n = e.beo_notes || {};
    return `<div class="page-head no-print"><div><h1 class="page">Banquet event order</h1><p class="sub">Print and hand to each department.</p></div><div class="row"><a class="btn btn-ghost" href="#event/${e.id}">Back</a><button class="btn btn-gold" data-action="print">Print</button></div></div>
      <div class="card beo"><div class="row between"><div><h2>${esc(SETTINGS.property_name)}</h2><p class="muted mt0">Banquet event order ${esc(e.code)}</p></div><div class="right">${pill(...EV_ST[e.status])}</div></div>
      <dl class="beo-facts"><div><dt>Event</dt><dd>${esc(e.title)} (${EV_TYPE[e.event_type]})</dd></div><div><dt>Date</dt><dd>${fdateLong(e.d)}</dd></div><div><dt>Time</dt><dd>${esc(e.start)}–${esc(e.end)}</dd></div>
        <div><dt>Room</dt><dd>${esc(e.room_name)}</dd></div><div><dt>Guests</dt><dd>${e.pax}</dd></div><div><dt>Set-up</dt><dd>${esc(e.setup_style || '—')}</dd></div>
        <div><dt>Client</dt><dd>${esc(e.company_name || '')} ${esc(e.contact_name)} ${esc(e.contact_phone || '')}</dd></div><div><dt>Package</dt><dd>${esc(e.package_name || '—')}</dd></div></dl>
      ${extras.length ? `<h3>Extras</h3><ul>${extras.map((x) => `<li>${x.qty} × ${esc(x.description)}</li>`).join('')}</ul>` : ''}
      <div class="beo-depts">${BEO.map(([k, l]) => `<section><h3>${l}</h3><p>${esc(n[k] || 'No special instructions.')}</p></section>`).join('')}</div>
      <p class="small muted">Printed ${fdateLong(SETTINGS.business_date)} by ${esc(ME.full_name)}. Prices are on the quote, not on this order.</p></div>`;
  };

  VIEWS.maintenance = async () => {
    const t = cur('wo', 'open'), w = CAN['maintenance.work'];
    const d = await GET(`/ops/work-orders?status=${t}`);
    ui.woRooms = d.rooms; ui.woList = d.work_orders;
    if (!ui.woAssets) ui.woAssets = await GET('/ops/assets').catch(() => []);
    const late = (x) => x.due && x.due < d.business_date && !['done', 'cancelled'].includes(x.status);
    return `<div class="page-head"><div><h1 class="page">Maintenance</h1><p class="sub">${w ? 'All jobs, most urgent first. A room taken out of order goes back to housekeeping when the job is done.' : 'Faults you have reported. Maintenance will pick them up.'}</p></div>
      <div class="row"><button class="btn btn-gold" data-action="wo-report">+ Report a fault</button>${w ? '<button class="btn btn-ghost" data-action="wo-schedule">Create due services</button>' : ''}</div></div>
      ${tabs('wo', [['open', 'Open'], ['closed', 'Closed']], 'open')}
      <div class="card">${table(['Job', 'Where', 'Priority', 'Due', 'Assigned', 'Status', ''], d.work_orders.map((x) => `<tr><td>${esc(x.title)}<br><span class="small muted">${esc(x.code)} · ${x.kind === 'repair' ? 'Repair' : x.kind === 'preventive' ? 'Scheduled service' : 'Inspection'} · ${esc(x.reporter || '')}</span>${x.description ? `<br><span class="small">${esc(x.description)}</span>` : ''}${x.completion_notes ? `<br><span class="small muted">Done: ${esc(x.completion_notes)}</span>` : ''}</td>
        <td>${x.room ? `Room ${esc(x.room)}${x.room_out_of_order ? ' ' + pill('Out of order', 'bad') : ''}` : ''}${x.asset_name ? `${x.room ? '<br>' : ''}${esc(x.asset_name)}` : ''}${x.location ? `<br><span class="small muted">${esc(x.location)}</span>` : ''}</td>
        <td>${pill(...PRIO[x.priority])}</td><td class="nowrap ${late(x) ? 'err' : ''}">${x.due ? fdate(x.due) : ''}</td><td>${esc(x.assigned_to || '')}</td><td>${pill(...WO_ST[x.status])}${x.cost ? `<br><span class="small muted">${ugx(x.cost)}</span>` : ''}</td>
        <td class="right">${w && !['done', 'cancelled'].includes(x.status) ? `<button class="btn btn-sm" data-action="wo-update" data-id="${x.id}">Update</button>` : ''}</td></tr>`), t === 'open' ? 'No open jobs.' : 'Nothing closed yet.')}</div>`;
  };

  VIEWS.assets = async () => {
    const t = cur('as', 'register');
    const head = `<div class="page-head"><div><h1 class="page">Assets</h1><p class="sub">The fixed asset register: cost, depreciation and book value, with service history.</p></div>
      <div class="row"><button class="btn btn-gold" data-action="as-new">+ Add asset</button></div></div>${tabs('as', [['register', 'Register'], ['disposed', 'Disposed'], ['dep', 'Depreciation']], 'register')}`;
    if (t === 'dep') {
      const d = await GET('/ops/depreciation');
      return head + `<div class="grid g3"><div class="card kpi"><span>Cost</span><b>${num(d.totals.cost)}</b><small>UGX, assets in use</small></div><div class="card kpi"><span>Depreciated</span><b>${num(d.totals.dep)}</b><small>UGX to date</small></div><div class="card kpi"><span>Book value</span><b>${num(d.totals.cost - d.totals.dep)}</b><small>UGX</small></div></div>
        <div class="card mt"><form class="form row" data-form="dep-run"><label>Month<input type="month" name="period" value="${SETTINGS.business_date.slice(0, 7)}" max="${SETTINGS.business_date.slice(0, 7)}" required></label><button class="btn btn-gold">Post depreciation</button></form>
        <p class="small muted">Straight line over each asset's useful life, down to its residual value. Each month is posted once: Dr 6800 Depreciation, Cr 1590 Accumulated depreciation.</p>
        ${table(['Month', '#Assets', '#Amount', 'Posted by'], d.runs.map((r) => `<tr><td>${esc(r.period)}</td><td class="num">${r.assets}</td><td class="num">${num(r.total)}</td><td>${esc(r.by_name || '')}</td></tr>`), 'No depreciation posted yet.')}</div>`;
    }
    const list = await GET(`/ops/assets${t === 'disposed' ? '?status=disposed' : ''}`);
    return head + `<div class="card">${table(['Asset', 'Category', 'Location', 'Bought', '#Cost', '#Book value', 'Next service', 'Status'], list.map((a) => `<tr><td><a href="#asset/${a.id}">${esc(a.name)}</a><br><span class="small muted">${esc(a.code)}${a.serial_no ? ' · ' + esc(a.serial_no) : ''}</span></td><td>${AS_CAT[a.category]}</td><td>${esc(a.location || '')}</td><td>${fdate(a.bought)}</td>
      <td class="num">${num(a.cost)}</td><td class="num">${num(a.book_value)}</td><td class="nowrap ${a.next_service && a.next_service < SETTINGS.business_date ? 'err' : ''}">${a.next_service ? fdate(a.next_service) : ''}</td><td>${pill(...AS_ST[a.status])}</td></tr>`), 'No assets yet.')}</div>`;
  };

  VIEWS.asset = async (id) => {
    const { asset: a, work_orders: wo } = await GET(`/ops/assets/${id}`);
    ui.asset = a;
    return `<div class="page-head"><div><h1 class="page">${esc(a.name)}</h1><p class="sub">${esc(a.code)} · ${AS_CAT[a.category]} · ${esc(a.location || '')} ${pill(...AS_ST[a.status])}</p></div>
      <div class="row"><a class="btn btn-ghost" href="#assets">Back</a>${a.status !== 'disposed' ? `<button class="btn btn-ghost" data-action="as-edit">Edit</button>${CAN['assets.manage'] ? `<button class="btn btn-bad" data-action="as-dispose" data-id="${a.id}">Dispose / sell</button>` : ''}` : ''}</div></div>
      <div class="grid g4"><div class="card kpi"><span>Cost</span><b>${num(a.cost)}</b><small>bought ${fdate(a.bought)}</small></div><div class="card kpi"><span>Depreciated</span><b>${num(a.accumulated_dep)}</b><small>over ${Math.round(a.useful_life_months / 12 * 10) / 10} years to ${num(a.residual_value)}</small></div>
        <div class="card kpi"><span>Book value</span><b>${num(a.book_value)}</b><small>UGX</small></div><div class="card kpi"><span>Last service</span><b>${a.serviced ? fdate(a.serviced) : '—'}</b><small>${a.service_interval_days ? `every ${a.service_interval_days} days` : 'no schedule'}</small></div></div>
      ${a.status === 'disposed' ? `<p class="note">Disposed ${fdate(a.disposed)} for ${ugx(a.disposal_proceeds)}.</p>` : ''}
      <div class="card mt"><h2 class="sec">Maintenance history</h2>${table(['Reported', 'Job', 'Status', '#Cost'], wo.map((x) => `<tr><td>${fdate(x.reported)}</td><td>${esc(x.title)}<br><span class="small muted">${esc(x.code)}${x.completion_notes ? ' · ' + esc(x.completion_notes) : ''}</span></td><td>${pill(...WO_ST[x.status])}</td><td class="num">${num(x.cost)}</td></tr>`), 'No jobs yet.')}
      ${a.notes ? `<p class="small muted">${esc(a.notes)}</p>` : ''}</div>`;
  };

  const OPS_A = {
    'am-book': async () => {
      const date = ui.q.amDate || SETTINGS.business_date;
      const [list, guests] = await Promise.all([GET('/ops/amenities'), GET(`/ops/amenity-guests?date=${date}`)]);
      modal('Book a service', `<form class="form" data-form="ops-modal"><label>Service<select name="amenity_id" required>${opts(list.map((a) => [a.id, `${a.name} · ${num(a.price)}`]))}</select></label>
        <div class="three"><label>Date<input type="date" name="service_date" value="${date}" min="${SETTINGS.business_date}" required></label><label>Time<input type="time" name="start_time"></label><label>Quantity<input type="number" name="qty" min="1" value="1"></label></div>
        <label>Hotel guest<select name="reservation_id"><option value="">Not staying with us (walk-in)</option>${opts(guests.map((g) => [g.id, `${g.room ? `Room ${g.room} · ` : ''}${g.guest} (${g.code})`]))}</select></label>
        <div class="two"><label>Walk-in name<input name="guest_name" placeholder="If not a hotel guest"></label><label>Phone<input name="phone"></label></div>
        <div class="two"><label>Staff (therapist, driver, guide)<input name="staff"></label><label>Notes<input name="notes"></label></div>
        <p class="small muted">The same staff member cannot be booked twice at overlapping times.</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Book</button></div></form>`,
      async (v) => { const b = await POST('/ops/amenity-bookings', { ...v, amenity_id: Number(v.amenity_id), reservation_id: v.reservation_id ? Number(v.reservation_id) : null, qty: Number(v.qty) }); ui.q.amDate = v.service_date; return `Booked ${esc(b.code)}.`; });
    },
    'am-done': (d) => {
      const b = ui.amDay.bookings.find((x) => x.id === Number(d.id));
      const room = b.res_status === 'in_house';
      modal(`Service delivered: ${b.amenity}`, `<form class="form" data-form="ops-modal"><p><b>${ugx(b.amount)}</b> for ${esc(b.guest_name)}${b.room ? `, room ${esc(b.room)}` : ''}.</p>
        <label>How is it paid?<select name="settle_by">${opts([...(room ? [['room', 'Charge to room ' + b.room]] : []), ['cash', 'Cash'], ['card', 'Card'], ['mobile_money', 'Mobile money']], room ? 'room' : 'cash')}</select></label>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Confirm</button></div></form>`,
      async (v) => { await POST(`/ops/amenity-bookings/${b.id}/complete`, v); return v.settle_by === 'room' ? 'Charged to the guest\'s bill.' : 'Payment recorded.'; });
    },
    'am-close': async (d) => { if (!confirm(d.s === 'no_show' ? 'Mark as no-show?' : 'Cancel this booking?')) return; await POST(`/ops/amenity-bookings/${d.id}/close`, { status: d.s }); toast('Booking closed.'); render(); },
    'am-edit': (d) => {
      const a = d.id ? ui.amList.find((x) => x.id === Number(d.id)) : null;
      modal(a ? `Edit ${a.name}` : 'New service', `<form class="form" data-form="ops-modal"><label>Name<input name="name" value="${esc(a?.name || '')}" required maxlength="120"></label>
        <div class="three"><label>Category<select name="category">${opts(Object.entries(AM_CAT), a?.category)}</select></label><label>Price (UGX, VAT incl.)<input type="number" name="price" min="0" value="${a?.price ?? ''}" required></label><label>Duration (min)<input type="number" name="duration_min" min="5" value="${a?.duration_min ?? ''}"></label></div>
        <label>Description<input name="description" value="${esc(a?.description || '')}"></label>${a ? `<label class="row"><input type="checkbox" name="active" value="1" ${a.active ? 'checked' : ''}> Available for booking</label>` : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { const body = { ...v, price: Number(v.price), duration_min: v.duration_min ? Number(v.duration_min) : null, active: a ? !!v.active : true }; if (a) await PUT(`/ops/amenities/${a.id}`, body); else await POST('/ops/amenities', body); return 'Price list updated.'; });
    },
    'fr-edit': (d) => {
      const r = d.id ? ui.evSetup.rooms.find((x) => x.id === Number(d.id)) : null;
      modal(r ? `Edit ${r.name}` : 'New function room', `<form class="form" data-form="ops-modal"><label>Name<input name="name" value="${esc(r?.name || '')}" required></label>
        <div class="three"><label>Capacity<input type="number" name="capacity" min="1" value="${r?.capacity ?? ''}" required></label><label>Full-day hire<input type="number" name="hire_full_day" min="0" value="${r?.hire_full_day ?? 0}"></label><label>Half-day hire<input type="number" name="hire_half_day" min="0" value="${r?.hire_half_day ?? 0}"></label></div>
        ${r ? `<label class="row"><input type="checkbox" name="active" value="1" ${r.active ? 'checked' : ''}> In use</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { const body = { ...v, active: r ? !!v.active : true }; if (r) await PUT(`/ops/function-rooms/${r.id}`, body); else await POST('/ops/function-rooms', body); return 'Function room saved.'; });
    },
    'pk-edit': (d) => {
      const p = d.id ? ui.evSetup.packages.find((x) => x.id === Number(d.id)) : null;
      modal(p ? `Edit ${p.name}` : 'New package', `<form class="form" data-form="ops-modal"><div class="two"><label>Name<input name="name" value="${esc(p?.name || '')}" required></label><label>Price per guest (UGX)<input type="number" name="per_person" min="0" value="${p?.per_person ?? ''}" required></label></div>
        <label>Includes<textarea name="includes" rows="3">${esc(p?.includes || '')}</textarea></label>${p ? `<label class="row"><input type="checkbox" name="active" value="1" ${p.active ? 'checked' : ''}> Offered</label>` : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { const body = { ...v, active: p ? !!v.active : true }; if (p) await PUT(`/ops/event-packages/${p.id}`, body); else await POST('/ops/event-packages', body); return 'Package saved.'; });
    },
    'ev-pay': async (d) => {
      const s = await GET('/ops/events/setup');
      const dep = d.k === 'deposit';
      modal(dep ? 'Take a deposit' : 'Refund a deposit', `<form class="form" data-form="ops-modal"><div class="two"><label>Amount (UGX)<input type="number" name="amount" min="1" required></label><label>${dep ? 'Received into' : 'Paid from'}<select name="account_code">${opts(cashList(s.cash_accounts), '1000')}</select></label></div>
        <label>Reference<input name="reference" placeholder="Receipt, transfer or mobile money reference"></label>${dep ? '<p class="small muted">Held as a guest deposit until the event is billed. A deposit confirms a tentative booking.</p>' : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">${dep ? 'Record deposit' : 'Record refund'}</button></div></form>`,
      async (v) => { await POST(`/ops/events/${d.id}/payments`, { ...v, kind: d.k, amount: Number(v.amount) }); return dep ? 'Deposit recorded.' : 'Refund recorded.'; });
    },
    'ev-complete': async (d) => {
      const s = await GET('/ops/events/setup');
      const bal = Number(d.bal);
      modal('Complete & bill event', `<form class="form" data-form="ops-modal"><p>Deposits are applied to the bill. ${bal > 0 ? `Balance due: <b>${ugx(bal)}</b>.` : 'Nothing more to pay.'}</p>
        ${bal > 0 ? `<label>Settle the balance<select name="settle_by">${opts([...(d.co ? [['invoice', 'Invoice the company account']] : []), ['cash', 'Cash'], ['card', 'Card'], ['mobile_money', 'Mobile money']], d.co ? 'invoice' : 'cash')}</select></label>
        <label>Into account (cash or mobile money)<select name="account_code"><option value="">Default for the method</option>${opts(cashList(s.cash_accounts))}</select></label>` : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Complete</button></div></form>`,
      async (v) => { const r = await POST(`/ops/events/${d.id}/complete`, v); return r.invoice_id ? 'Event billed. Invoice sent to the company account.' : 'Event completed and paid.'; });
    },
    'ev-cancel': (d) => {
      const dep = Number(d.dep);
      modal('Cancel event', `<form class="form" data-form="ops-modal"><label>Reason<input name="reason" required maxlength="300"></label>
        ${dep > 0 ? `<p class="note">${ugx(dep)} in deposits is held. Refund it first with <b>Refund</b>, or keep it under your cancellation terms:</p><label class="row"><input type="checkbox" name="forfeit" value="1" required> Keep the deposit (recorded as forfeited deposits income)</label>` : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-bad">Cancel event</button></div></form>`,
      async (v) => { await POST(`/ops/events/${d.id}/cancel`, { reason: v.reason, deposit: v.forfeit ? 'forfeit' : undefined }); return 'Event cancelled. The room is free again.'; });
    },
    'wo-report': () => {
      modal('Report a fault', `<form class="form" data-form="ops-modal"><label>What is wrong?<input name="title" required maxlength="150" placeholder="e.g. Shower leaking, AC not cooling"></label><label>Details<textarea name="description" rows="2"></textarea></label>
        <div class="two"><label>Room<select name="room_id"><option value="">Not a guest room</option>${opts((ui.woRooms || []).map((r) => [r.id, `Room ${r.number}${r.hk_status === 'out_of_order' ? ' (out of order)' : ''}`]))}</select></label><label>Equipment / asset<select name="asset_id"><option value="">—</option>${opts((ui.woAssets || []).map((a) => [a.id, `${a.name}${a.location ? ' · ' + a.location : ''}`]))}</select></label></div>
        <div class="two"><label>Location<input name="location" placeholder="If not a room, e.g. Kitchen, Pool"></label><label>Priority<select name="priority">${opts([['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent (now)'], ['low', 'Low']], 'normal')}</select></label></div>
        <label class="row"><input type="checkbox" name="room_out_of_order" value="1"> Take the room out of order until this is fixed</label>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Report</button></div></form>`,
      async (v) => { const w = await POST('/ops/work-orders', { ...v, room_id: v.room_id ? Number(v.room_id) : null, asset_id: v.asset_id ? Number(v.asset_id) : null, room_out_of_order: !!v.room_out_of_order }); return `Reported as ${esc(w.code)}.`; });
    },
    'wo-update': (d) => {
      const w = ui.woList.find((x) => x.id === Number(d.id));
      modal(`${w.code}: ${w.title}`, `<form class="form" data-form="ops-modal"><div class="two"><label>Status<select name="status">${opts(Object.entries(WO_ST).map(([k, [l]]) => [k, l]), w.status)}</select></label><label>Priority<select name="priority">${opts(Object.entries(PRIO).map(([k, [l]]) => [k, l]), w.priority)}</select></label></div>
        <div class="three"><label>Assigned to<input name="assigned_to" value="${esc(w.assigned_to || '')}"></label><label>Due<input type="date" name="due_date" value="${esc(w.due || '')}"></label><label>Cost (UGX)<input type="number" name="cost" min="0" value="${w.cost || 0}"></label></div>
        <label>What was done<textarea name="completion_notes" rows="2" placeholder="Required when you mark it done"></textarea></label>
        ${w.room_out_of_order ? '<p class="small muted">When done, the room goes back to housekeeping as dirty.</p>' : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { await PUT(`/ops/work-orders/${w.id}`, { ...v, cost: Number(v.cost) }); return 'Job updated.'; });
    },
    'wo-schedule': async () => { const r = await POST('/ops/work-orders/schedule'); toast(r.created ? `${r.created} scheduled service job(s) created.` : 'No services are due in the next 7 days.'); render(); },
    'as-new': async () => {
      const s = await GET('/ops/depreciation');
      modal('Add asset', `<form class="form" data-form="ops-modal"><div class="two"><label>Name<input name="name" required maxlength="120"></label><label>Category<select name="category">${opts(Object.entries(AS_CAT), 'equipment')}</select></label></div>
        <div class="three"><label>Location<input name="location"></label><label>Serial number<input name="serial_no"></label><label>Supplier<input name="supplier"></label></div>
        <div class="three"><label>Purchase date<input type="date" name="purchase_date" max="${SETTINGS.business_date}" required></label><label>Cost (UGX)<input type="number" name="cost" min="0" required></label><label>Residual value<input type="number" name="residual_value" min="0" value="0"></label></div>
        <div class="two"><label>Useful life (years)<input type="number" name="useful_life_years" min="0.1" step="0.1" value="5" required></label><label>Service every (days)<input type="number" name="service_interval_days" min="1" placeholder="Leave empty if none"></label></div>
        <div class="two"><label>In the books<select name="funding">${opts([['paid', 'Bought now: paid from an account'], ['opening', 'Already owned: opening balance'], ['none', 'Register only (no posting)']], 'paid')}</select></label><label>Paid from<select name="paid_from">${opts(cashList(s.cash_accounts), '1030')}</select></label></div>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Add asset</button></div></form>`,
      async (v) => { const a = await POST('/ops/assets', { ...v, cost: Number(v.cost), residual_value: Number(v.residual_value), useful_life_years: Number(v.useful_life_years) }); return `${esc(a.code)} added to the register.`; });
    },
    'as-edit': () => {
      const a = ui.asset;
      modal(`Edit ${a.name}`, `<form class="form" data-form="ops-modal"><label>Name<input name="name" value="${esc(a.name)}" required></label><div class="two"><label>Location<input name="location" value="${esc(a.location || '')}"></label><label>Serial number<input name="serial_no" value="${esc(a.serial_no || '')}"></label></div>
        <div class="two"><label>Service every (days)<input type="number" name="service_interval_days" min="1" value="${a.service_interval_days || ''}"></label><label>Status<select name="status">${opts([['in_use', 'In use'], ['under_repair', 'Under repair']], a.status)}</select></label></div>
        <label>Notes<textarea name="notes" rows="2">${esc(a.notes || '')}</textarea></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { await PUT(`/ops/assets/${a.id}`, v); return 'Asset updated.'; });
    },
    'as-dispose': async (d) => {
      const s = await GET('/ops/depreciation');
      modal('Dispose of asset', `<form class="form" data-form="ops-modal"><p>Book value today: <b>${ugx(ui.asset.book_value)}</b>. Any difference from the sale price is booked as a gain or loss.</p>
        <div class="two"><label>Sale proceeds (UGX)<input type="number" name="proceeds" min="0" value="0"></label><label>Received into<select name="account_code">${opts(cashList(s.cash_accounts), '1000')}</select></label></div>
        <label>Reason<input name="reason" placeholder="Sold, scrapped, stolen…"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Dispose</button></div></form>`,
      async (v) => { const r = await POST(`/ops/assets/${d.id}/dispose`, { ...v, proceeds: Number(v.proceeds) }); return r.gain >= 0 ? `Disposed. Gain of ${ugx(r.gain)}.` : `Disposed. Loss of ${ugx(-r.gain)}.`; });
    },
  };
  const OPS_FORMS = {
    'am-date': (v) => { ui.q.amDate = v.date; render(); },
    'dep-run': async (v) => { if (!confirm(`Post depreciation for ${v.period}?`)) return; const r = await POST('/ops/depreciation', { period: v.period }); toast(`Depreciation ${esc(r.period)}: ${ugx(r.total)} on ${r.assets} asset(s).`); render(); },
    event: async (v, form) => {
      const extras = Object.keys(v).filter((k) => k.startsWith('xd_')).map((k) => k.slice(3)).map((i) => ({ description: v['xd_' + i], qty: Number(v['xq_' + i]) || 1, unit_price: Number(v['xp_' + i]) || 0 })).filter((x) => x.description);
      const body = { title: v.title, event_type: v.event_type, status: v.status, event_date: v.event_date, start_time: v.start_time, end_time: v.end_time, function_room_id: Number(v.function_room_id), pax: Number(v.pax),
        contact_name: v.contact_name, contact_phone: v.contact_phone, contact_email: v.contact_email, company_id: v.company_id ? Number(v.company_id) : null,
        package_id: v.package_id ? Number(v.package_id) : null, per_person: v.per_person === '' ? undefined : Number(v.per_person), hire_type: v.hire_type, room_hire: v.room_hire === '' ? undefined : Number(v.room_hire),
        setup_style: v.setup_style, notes: v.notes, beo_notes: Object.fromEntries(BEO.map(([k]) => [k, v['beo_' + k] || ''])), extras };
      const id = form.dataset.id;
      const e = id ? await PUT(`/ops/events/${id}`, body) : await POST('/ops/events', body);
      toast(id ? 'Event saved.' : `Event ${esc(e.code)} created.`); location.hash = `#event/${e.id}`;
    },
  };

  const A = {

    clock: async (d) => { await POST('/hr/me/clock', { action: d.a }); toast(d.a === 'in' ? 'Signed in.' : 'Signed out.'); render(); },
    'my-leave': async () => {
      const setup = await hrSetup();
      modal('Request leave', `<form class="form" data-form="my-leave"><label>Type<select name="type">${opts(setup.leave_types.map((t) => [t.code, t.name]), 'annual')}</select></label>
        <div class="two"><label>From<input type="date" name="from_date" required min="${SETTINGS.business_date}"></label><label>To<input type="date" name="to_date" required min="${SETTINGS.business_date}"></label></div><label>Reason<input name="reason" maxlength="300"></label>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Send request</button></div></form>`, async (v) => { await POST('/hr/me/leave', v); return 'Leave requested. Your manager will be asked to approve it.'; });
    },
    'hr-leave': async (d) => {
      const setup = await hrSetup();
      modal('Record leave', `<form class="form" data-form="hr-leave"><label>Type<select name="type">${opts(setup.leave_types.map((t) => [t.code, t.name]), 'annual')}</select></label>
        <div class="two"><label>From<input type="date" name="from_date" required></label><label>To<input type="date" name="to_date" required></label></div><label>Reason<input name="reason" maxlength="300"></label>
        <p class="note">A manager still approves it under People → Leave.</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`, async (v) => { await POST('/hr/leave', { ...v, employee_id: Number(d.id) }); return 'Leave recorded for approval.'; });
    },
    'leave-cancel': async (d) => { if (!confirm('Cancel this leave request?')) return; await POST(`/hr/leave/${d.id}/cancel`); toast('Leave cancelled.'); render(); },
    'leave-decide': (d) => {
      if (d.d === 'approved') return POST(`/hr/leave/${d.id}/decide`, { decision: 'approved' }).then(() => { toast('Leave approved.'); render(); });
      modal('Reject leave', `<form class="form" data-form="leave-reject"><label>Reason (shown to the employee)<input name="note" required maxlength="300"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Reject</button></div></form>`, async (v) => { await POST(`/hr/leave/${d.id}/decide`, { decision: 'rejected', note: v.note }); return 'Leave rejected.'; });
    },
    'emp-edit': async (d) => {
      const [setup, unlinked] = await Promise.all([hrSetup(), GET('/hr/users-unlinked').catch(() => [])]);
      const e = d.id ? (await GET(`/hr/employees/${d.id}`)).employee : null;
      const users = e?.user_id ? [[e.user_id, e.username], ...unlinked.map((u) => [u.id, `${u.full_name} (${u.username})`])] : unlinked.map((u) => [u.id, `${u.full_name} (${u.username})`]);
      const sd = (x) => (x ? String(x).slice(0, 10) : '');
      modal(e ? `Edit ${empName(e)}` : 'New employee', `<form class="form" data-form="emp"><div class="three"><label>First name<input name="first_name" value="${esc(e?.first_name || '')}" required></label><label>Last name<input name="last_name" value="${esc(e?.last_name || '')}" required></label><label>Gender<select name="gender">${opts([['', '–'], ['female', 'Female'], ['male', 'Male']], e?.gender || '')}</select></label></div>
        <div class="three"><label>Date of birth<input type="date" name="date_of_birth" value="${sd(e?.date_of_birth)}"></label><label>Phone<input name="phone" value="${esc(e?.phone || '')}"></label><label>Email<input name="email" type="email" value="${esc(e?.email || '')}"></label></div>
        <div class="three"><label>National ID (NIN)<input name="nin" value="${esc(e?.nin || '')}"></label><label>TIN<input name="tin" value="${esc(e?.tin || '')}"></label><label>NSSF number<input name="nssf_no" value="${esc(e?.nssf_no || '')}"></label></div>
        <div class="three"><label>Department<select name="department">${opts(setup.departments.map((x) => [x, x]), e?.department)}</select></label><label>Job title<input name="job_title" value="${esc(e?.job_title || '')}" required></label><label>Type<select name="employment_type">${opts([['permanent', 'Permanent'], ['contract', 'Contract'], ['casual', 'Casual'], ['intern', 'Intern']], e?.employment_type)}</select></label></div>
        <div class="three"><label>Start date<input type="date" name="start_date" value="${sd(e?.start_date)}" required></label><label>Basic salary / month (UGX)<input name="basic_salary" type="number" min="0" value="${e?.basic_salary ?? ''}" required></label><label>Annual leave days<input name="annual_leave_days" type="number" min="0" max="60" value="${e?.annual_leave_days ?? 21}"></label></div>
        <div class="three"><label>Housing allowance<input name="housing_allowance" type="number" min="0" value="${e?.housing_allowance ?? 0}"></label><label>Transport allowance<input name="transport_allowance" type="number" min="0" value="${e?.transport_allowance ?? 0}"></label><label>Other allowance<input name="other_allowance" type="number" min="0" value="${e?.other_allowance ?? 0}"></label></div>
        <div class="three"><label>Paid by<select name="pay_method">${opts([['bank', 'Bank'], ['mobile_money', 'Mobile money'], ['cash', 'Cash']], e?.pay_method)}</select></label><label>Bank / account no.<span class="row"><input name="bank_name" value="${esc(e?.bank_name || '')}" placeholder="Bank"><input name="bank_account" value="${esc(e?.bank_account || '')}" placeholder="Account"></span></label><label>Mobile money number<input name="momo_number" value="${esc(e?.momo_number || '')}"></label></div>
        <label>Sign-in for self-service<select name="user_id">${opts([['', 'None'], ...users], e?.user_id || '')}</select></label><label>Notes<textarea name="notes" rows="2">${esc(e?.notes || '')}</textarea></label>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const b = { ...v, user_id: v.user_id ? Number(v.user_id) : null, basic_salary: Number(v.basic_salary), housing_allowance: Number(v.housing_allowance || 0), transport_allowance: Number(v.transport_allowance || 0), other_allowance: Number(v.other_allowance || 0), annual_leave_days: Number(v.annual_leave_days) };
          if (e) await PUT(`/hr/employees/${e.id}`, b); else { const n = await POST('/hr/employees', b); location.hash = `#employee/${n.id}`; } return 'Employee saved.'; });
    },
    'emp-leave': (d) => modal('Leaving the company', `<form class="form" data-form="emp-leave"><p class="note">Their roster after the leaving date is cleared and their sign-in is switched off. Payroll pays them up to the leaving date.</p><div class="two"><label>Last working day<input type="date" name="end_date" required value="${SETTINGS.business_date}"></label><label>Reason<input name="reason" required maxlength="300"></label></div><div class="actions">${cancelBtn}<button class="btn btn-bad">Confirm</button></div></form>`,
      async (v) => { await POST(`/hr/employees/${d.id}/leave-company`, v); return 'Employment ended.'; }),
    'roster-week': (d) => { ui.q.rosterFrom = addDays(ui.q.rosterFrom || weekStart(SETTINGS.business_date), Number(d.d)); render(); },
    'roster-copy': async (d) => { const r = await POST('/hr/roster/copy', { from: d.from, department: ui.q.rosterDept || undefined }); toast(`${r.copied} shift(s) copied from last week. Existing entries were kept.`); render(); },
    'att-edit': (d) => modal(`Attendance · ${d.name}`, `<form class="form" data-form="att"><p class="muted">${fdateLong(d.date)}</p><div class="two"><label>Signed in<input type="time" name="clock_in" value="${d.in}"></label><label>Signed out<input type="time" name="clock_out" value="${d.out}"></label></div><label>Note<input name="note" maxlength="200"></label><p class="small muted">A sign-out earlier than the sign-in counts as the next morning (night shift).</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { await POST('/hr/attendance', { employee_id: Number(d.id), date: d.date, clock_in: v.clock_in, clock_out: v.clock_out, note: v.note }); return 'Attendance saved.'; }),
    'line-edit': (d) => modal(`Adjust · ${d.name}`, `<form class="form" data-form="line"><div class="three"><label>Overtime hours (paid at 1.5×)<input name="overtime_hours" type="number" min="0" step="0.5" value="${d.ot}"></label><label>Other additions (bonus, tips…)<input name="other_additions" type="number" min="0" value="${d.add}"></label><label>Other deductions<input name="other_deductions" type="number" min="0" value="${d.ded}"></label></div><label>Note on payslip<input name="note" value="${esc(d.note)}" maxlength="200"></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Recalculate</button></div></form>`,
      async (v) => { await PUT(`/hr/payroll/${d.run}/lines/${d.emp}`, { overtime_hours: Number(v.overtime_hours || 0), other_additions: Number(v.other_additions || 0), other_deductions: Number(v.other_deductions || 0), note: v.note }); return 'Recalculated.'; }),
    'run-act': async (d) => {
      const msg = { approve: 'Approve this payroll?', post: 'Post this payroll to the accounts? It cannot be changed afterwards.', void: 'Delete this payroll?', reopen: 'Send back to draft?', refresh: 'Refresh from staff records? Overtime and adjustments are kept.' }[d.a];
      if (msg && !confirm(msg)) return;
      await POST(`/hr/payroll/${d.id}/${d.a}`); toast({ approve: 'Payroll approved.', post: 'Payroll posted to the accounts.', void: 'Payroll deleted.', reopen: 'Back to draft.', refresh: 'Payroll refreshed.' }[d.a]);
      if (d.a === 'void') location.hash = '#payroll'; else render();
    },
    'run-pay': async (d) => {
      const all = await accts(true);
      modal('Salaries paid', `<form class="form" data-form="run-pay"><label>Paid from<select name="paid_from">${cashOpts(all, '1030')}</select></label><p class="note">Use the Payment list tab for the bank and mobile money transfers. PAYE and NSSF are paid to URA and NSSF under Finance → Expenses & transfers (accounts 2400 and 2410).</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Confirm</button></div></form>`,
        async (v) => { await POST(`/hr/payroll/${d.id}/pay`, v); return 'Salaries marked as paid.'; });
    },
    advance: async (d) => {
      const all = await accts(true); const emps = JSON.parse(d.emps);
      modal('Staff advance', `<form class="form" data-form="advance"><label>Employee<select name="employee_id">${opts(emps)}</select></label><div class="three"><label>Amount (UGX)<input name="amount" type="number" min="1" required></label><label>Recover per month<input name="monthly_recovery" type="number" min="1" required></label><label>Paid from<select name="paid_from">${cashOpts(all, '1000')}</select></label></div><label>Reason<input name="reason" maxlength="200"></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Give advance</button></div></form>`,
        async (v) => { await POST('/hr/advances', { ...v, employee_id: Number(v.employee_id), amount: Number(v.amount), monthly_recovery: Number(v.monthly_recovery) }); return 'Advance recorded.'; });
    },

    'company-edit': async (d) => {
      const c = d.id ? (await GET('/finance/companies')).find((x) => String(x.id) === d.id) : null;
      modal(c ? `Edit ${c.name}` : 'New company account', `<form class="form" data-form="company"><div class="two"><label>Company name<input name="name" value="${esc(c?.name || '')}" required maxlength="120"></label><label>TIN<input name="tin" value="${esc(c?.tin || '')}" maxlength="30"></label></div>
        <div class="three"><label>Contact person<input name="contact" value="${esc(c?.contact || '')}"></label><label>Phone<input name="phone" value="${esc(c?.phone || '')}"></label><label>Email<input name="email" type="email" value="${esc(c?.email || '')}"></label></div>
        <label>Address<input name="address" value="${esc(c?.address || '')}" maxlength="300"></label>
        <div class="two"><label>Credit limit (UGX, 0 = none)<input name="credit_limit" type="number" min="0" value="${c?.credit_limit ?? 0}"></label><label>Payment terms (days)<input name="terms_days" type="number" min="0" max="180" value="${c?.terms_days ?? 30}"></label></div>
        ${c ? `<label class="row"><input type="checkbox" name="active" value="1" ${c.active ? 'checked' : ''}> Active</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const b = { ...v, credit_limit: Number(v.credit_limit), terms_days: Number(v.terms_days), active: c ? !!v.active : true }; if (c) await PUT(`/finance/companies/${c.id}`, b); else await POST('/finance/companies', b); return 'Company saved.'; });
    },
    'invoice-extra': (d) => modal('Invoice other charges', `<form class="form" data-form="invoice-x">${[0, 1, 2].map((k) => `<div class="three"><label>${k ? '' : 'Description'}<input name="xd_${k}" maxlength="200"></label><label>${k ? '' : 'Department'}<select name="xt_${k}">${opts(Object.entries(DEPT), 'events')}</select></label><label>${k ? '' : 'Amount (VAT incl.)'}<input name="xa_${k}" type="number" min="1"></label></div>`).join('')}<div class="actions">${cancelBtn}<button class="btn btn-gold">Create invoice</button></div></form>`,
      async (v) => { const extra = [0, 1, 2].map((k) => ({ description: v['xd_' + k], department: v['xt_' + k], amount: Number(v['xa_' + k]) })).filter((x) => x.description && x.amount); const inv = await POST('/finance/invoices', { company_id: Number(d.id), extra_lines: extra }); location.hash = `#invoice/${inv.id}`; return `Invoice ${esc(inv.number)} created.`; }),
    'invoice-void': (d) => modal('Void invoice', `<form class="form" data-form="void-inv"><p class="note">Stays on the invoice go back to “not invoiced”. Extra charges are reversed in the accounts.</p><label>Reason<input name="reason" required maxlength="300"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Void invoice</button></div></form>`,
      async (v) => { await POST(`/finance/invoices/${d.id}/void`, v); return 'Invoice voided.'; }),
    receipt: async (d) => {
      const [co, all] = await Promise.all([GET(`/finance/companies/${d.id}`), accts(true)]);
      const open = co.invoices.filter((i) => i.status === 'issued' && i.balance > 0);
      modal(`Payment from ${co.company.name}`, `<form class="form" data-form="receipt"><div class="three"><label>Amount (UGX)<input name="amount" type="number" min="1" required></label><label>Received into<select name="account_code">${cashOpts(all, '1030')}</select></label><label>Reference<input name="reference" maxlength="80" placeholder="EFT / cheque no."></label></div>
        ${open.length ? `<p class="small muted">Allocate to invoices (anything left stays as a credit on the account):</p>${table(['Invoice', 'Due', '#Balance', 'Allocate'], open.map((i) => `<tr><td>${esc(i.number)}</td><td>${fdate(i.due_date)}</td><td class="num">${num(i.balance)}</td><td><input class="search" type="number" min="0" name="a_${i.id}" value="" aria-label="Allocate to ${esc(i.number)}"></td></tr>`))}` : '<p class="note">No open invoices: the payment will sit on the account as a credit.</p>'}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Record payment</button></div></form>`,
        async (v) => { const allocations = Object.keys(v).filter((k) => k.startsWith('a_') && Number(v[k]) > 0).map((k) => ({ invoice_id: Number(k.slice(2)), amount: Number(v[k]) })); await POST('/finance/receipts', { company_id: Number(d.id), amount: Number(v.amount), account_code: v.account_code, reference: v.reference, allocations }); return 'Payment recorded.'; });
    },
    'bill-expense': async (d) => {
      const all = (await accts(true)).filter((a) => a.active && a.type === 'expense');
      modal('Supplier bill (services, utilities, repairs…)', `<form class="form" data-form="bill-x"><div class="three"><label>Supplier's invoice number<input name="bill_number" required maxlength="60"></label><label>Invoice date<input type="date" name="bill_date" value="${SETTINGS.business_date}" max="${SETTINGS.business_date}"></label><label>Due date<input type="date" name="due_date"></label></div>
        ${[0, 1, 2].map((k) => `<div class="three"><label>${k ? '' : 'Expense account'}<select name="ac_${k}">${opts([['', '–'], ...all.map((a) => [a.code, `${a.code} ${a.name}`])])}</select></label><label>${k ? '' : 'Description / amount before VAT'}<span class="row"><input name="de_${k}" maxlength="200" placeholder="Description"><input name="am_${k}" type="number" min="1" placeholder="Amount"></span></label><label>${k ? '' : 'VAT'}<input name="va_${k}" type="number" min="0" placeholder="0"></label></div>`).join('')}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save bill</button></div></form>`,
        async (v) => { const lines = [0, 1, 2].map((k) => ({ account_code: v['ac_' + k], description: v['de_' + k], amount: Number(v['am_' + k]), vat: Number(v['va_' + k] || 0) })).filter((l) => l.account_code && l.amount);
          await POST('/finance/bills', { supplier_id: Number(d.id), kind: 'expense', bill_number: v.bill_number, bill_date: v.bill_date, due_date: v.due_date || undefined, lines }); return 'Bill recorded.'; });
    },
    'bill-void': (d) => modal('Void bill', `<form class="form" data-form="void-bill"><label>Reason<input name="reason" required maxlength="300"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Void bill</button></div></form>`, async (v) => { await POST(`/finance/bills/${d.id}/void`, v); return 'Bill voided.'; }),
    'pay-supplier': async (d) => {
      const [s, all] = await Promise.all([GET(`/finance/suppliers/${d.id}`), accts(true)]);
      const open = s.bills.filter((b) => b.status === 'open' && b.balance > 0);
      modal(`Pay ${s.supplier.name}`, `<form class="form" data-form="pay-sup"><div class="three"><label>Amount (UGX)<input name="amount" type="number" min="1" required value="${open.reduce((a, b) => a + b.balance, 0) || ''}"></label><label>Paid from<select name="account_code">${cashOpts(all, '1030')}</select></label><label>Reference<input name="reference" maxlength="80" placeholder="Cheque / transfer no."></label></div>
        ${open.length ? table(['Bill', 'Due', '#Balance', 'Pay'], open.map((b) => `<tr><td>${esc(b.bill_number)}</td><td>${fdate(b.due_date)}</td><td class="num">${num(b.balance)}</td><td><input class="search" type="number" min="0" name="b_${b.id}" value="${b.balance}" aria-label="Pay ${esc(b.bill_number)}"></td></tr>`)) : '<p class="note">No open bills: this will be an advance payment.</p>'}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Record payment</button></div></form>`,
        async (v) => { const allocations = Object.keys(v).filter((k) => k.startsWith('b_') && Number(v[k]) > 0).map((k) => ({ bill_id: Number(k.slice(2)), amount: Number(v[k]) })); await POST('/finance/supplier-payments', { supplier_id: Number(d.id), amount: Number(v.amount), account_code: v.account_code, reference: v.reference, allocations }); return 'Payment recorded.'; });
    },
    expense: async () => {
      const all = await accts(true);
      const targets = all.filter((a) => a.active && (a.type === 'expense' || (a.type === 'liability' && !['2000'].includes(a.code))));
      modal('Record a payment', `<form class="form" data-form="expense"><div class="two"><label>Paid to<input name="payee" required maxlength="120"></label><label>What for<input name="description" required maxlength="200"></label></div>
        <div class="three"><label>Account<select name="account_code">${opts(targets.map((a) => [a.code, `${a.code} ${a.name}`]), '6900')}</select></label><label>Paid from<select name="paid_from">${cashOpts(all, '1000')}</select></label><label>Date<input type="date" name="expense_date" value="${SETTINGS.business_date}" max="${SETTINGS.business_date}"></label></div>
        <div class="three"><label>Total paid (UGX)<input name="amount" type="number" min="1" required></label><label>VAT included (if any)<input name="vat" type="number" min="0" value="0"></label><label>Receipt / reference<input name="reference" maxlength="80"></label></div>
        <p class="small muted">To pay VAT to URA choose 2100 VAT payable; to pay an OTA its commission choose 2300.</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { await POST('/finance/expenses', { ...v, amount: Number(v.amount), vat: Number(v.vat || 0) }); ACCTS = null; return 'Payment recorded.'; });
    },
    transfer: async () => {
      const all = await accts(true);
      const from = all.filter((a) => a.active && (a.is_cash || a.code === '1010'));
      modal('Transfer between accounts', `<form class="form" data-form="transfer"><div class="three"><label>From<select name="from_account">${opts(from.map((a) => [a.code, `${a.code} ${a.name}`]), '1000')}</select></label><label>To<select name="to_account">${cashOpts(all, '1030')}</select></label><label>Date<input type="date" name="transfer_date" value="${SETTINGS.business_date}" max="${SETTINGS.business_date}"></label></div>
        <div class="three"><label>Amount (UGX)<input name="amount" type="number" min="1" required></label><label>Fee deducted (bank / card / mobile money)<input name="fee" type="number" min="0" value="0"></label><label>Note<input name="description" maxlength="200" placeholder="e.g. Banking cash takings"></label></div>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save transfer</button></div></form>`,
        async (v) => { await POST('/finance/transfers', { ...v, amount: Number(v.amount), fee: Number(v.fee || 0) }); return 'Transfer recorded.'; });
    },
    'account-edit': async (d) => {
      const a = d.code ? (await accts(true)).find((x) => x.code === d.code) : null;
      modal(a ? `Edit ${a.code}` : 'New account', `<form class="form" data-form="account"><div class="three"><label>Code<input name="code" value="${esc(a?.code || '')}" ${a ? 'disabled' : 'required'} pattern="\\d{4}"></label><label>Name<input name="name" value="${esc(a?.name || '')}" required maxlength="100"></label><label>Type<select name="type" ${a ? 'disabled' : ''}>${opts([['expense', 'Expense'], ['revenue', 'Revenue'], ['asset', 'Asset'], ['liability', 'Liability'], ['equity', 'Equity']], a?.type)}</select></label></div>
        ${!a?.system ? `<label class="row"><input type="checkbox" name="is_cash" value="1" ${a?.is_cash ? 'checked' : ''}> Cash, bank or mobile money account (assets only)</label>` : ''}${a && !a.system ? `<label class="row"><input type="checkbox" name="active" value="1" ${a.active ? 'checked' : ''}> Active</label>` : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { if (a) await PUT(`/finance/accounts/${a.code}`, { name: v.name, is_cash: !!v.is_cash, active: a.system ? true : !!v.active }); else await POST('/finance/accounts', { code: v.code, name: v.name, type: v.type, is_cash: !!v.is_cash }); ACCTS = null; return 'Account saved.'; });
    },
    journal: async () => {
      const all = (await accts(true)).filter((a) => a.active && !['1100', '1200', '1300', '2000'].includes(a.code));
      modal('Manual journal', `<form class="form" data-form="journal"><div class="two"><label>Description<input name="description" required maxlength="200"></label><label>Date<input type="date" name="date" value="${SETTINGS.business_date}" max="${SETTINGS.business_date}"></label></div>
        ${[0, 1, 2, 3].map((k) => `<div class="three"><label>${k ? '' : 'Account'}<select name="ac_${k}">${opts([['', '–'], ...all.map((a) => [a.code, `${a.code} ${a.name}`])])}</select></label><label>${k ? '' : 'Debit'}<input name="dr_${k}" type="number" min="0"></label><label>${k ? '' : 'Credit'}<input name="cr_${k}" type="number" min="0"></label></div>`).join('')}
        <p class="small muted">Guest ledger, company accounts, inventory and supplier balances are kept by the system and are not listed. Debits must equal credits.</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Post journal</button></div></form>`,
        async (v) => { const lines = [0, 1, 2, 3].map((k) => ({ account_code: v['ac_' + k], debit: Number(v['dr_' + k] || 0), credit: Number(v['cr_' + k] || 0) })).filter((l) => l.account_code); await POST('/finance/journals', { description: v.description, date: v.date, lines }); ACCTS = null; return 'Journal posted.'; });
    },
    'rec-finish': async (d) => { await POST(`/finance/reconciliations/${d.id}/finish`); toast('Reconciliation finished.'); render(); },

    'rate-edit': async () => {
      const types = (await GET('/room-types')).filter((t) => t.active);
      const from = ui.q.rateFrom || SETTINGS.business_date;
      modal('Change rates & restrictions', `<form class="form" data-form="rate-edit"><fieldset class="row"><legend class="small">Room types</legend>${types.map((t) => `<label class="row"><input type="checkbox" name="rt_${t.id}" value="1" checked> ${esc(t.name)}</label>`).join('')}</fieldset>
        <div class="two"><label>From<input type="date" name="from" value="${from}" required></label><label>To (inclusive)<input type="date" name="to" value="${from}" required></label></div>
        <div class="three"><label>Price per night (UGX)<input name="rate" type="number" min="0" step="100" placeholder="no change"></label><label>Minimum stay<select name="min_stay">${opts([['', 'No change'], ['clear', 'No minimum'], ...[2, 3, 4, 5, 7].map((n) => [n, n + ' nights'])])}</select></label>
          <label>Sales<select name="stop_sell">${opts([['', 'No change'], ['open', 'Open'], ['close', 'Close (stop-sell)']])}</select></label></div>
        <label class="row"><input type="checkbox" name="clear_rate" value="1"> Go back to the standard price for these dates</label>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Apply</button></div></form>`,
        async (v) => {
          const body = { room_type_ids: Object.keys(v).filter((k) => k.startsWith('rt_')).map((k) => Number(k.slice(3))), from: v.from, to: v.to };
          if (v.clear_rate) body.rate = null; else if (v.rate !== '') body.rate = Number(v.rate);
          if (v.min_stay === 'clear') body.min_stay = null; else if (v.min_stay) body.min_stay = Number(v.min_stay);
          if (v.stop_sell) body.stop_sell = v.stop_sell === 'close';
          await PUT('/distribution/calendar', body); return 'Rates updated. Channels will be updated automatically.';
        });
    },
    'plan-edit': async (d) => {
      const p = d.id ? (await GET('/distribution/rate-plans')).find((x) => String(x.id) === d.id) : null;
      modal(p ? `Edit ${p.name}` : 'New rate plan', `<form class="form" data-form="plan"><div class="two"><label>Code<input name="code" value="${esc(p?.code || '')}" ${p ? 'disabled' : 'required'} maxlength="20"></label><label>Name<input name="name" value="${esc(p?.name || '')}" required></label></div>
        <label>Description for guests<input name="description" value="${esc(p?.description || '')}" maxlength="300"></label>
        <div class="three"><label>Discount (%)<input name="discount_pct" type="number" min="0" max="99" step="0.5" value="${p?.discount_pct ?? 0}"></label><label>Minimum stay<input name="min_stay" type="number" min="1" value="${p?.min_stay ?? 1}"></label><label>Display order<input name="sort" type="number" value="${p?.sort ?? 0}"></label></div>
        <div class="row">${[['breakfast', 'Breakfast included', p ? p.breakfast : true], ['refundable', 'Free cancellation', p ? p.refundable : true], ['on_website', 'Sell on website', p ? p.on_website : true], ['on_channels', 'Sell on channels', p ? p.on_channels : true], ['active', 'Active', p ? p.active : true]].map(([k, l, c]) => `<label class="row"><input type="checkbox" name="${k}" value="1" ${c ? 'checked' : ''}> ${l}</label>`).join('')}</div>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const b = { code: v.code, name: v.name, description: v.description, discount_pct: Number(v.discount_pct), min_stay: Number(v.min_stay), sort: Number(v.sort), breakfast: !!v.breakfast, refundable: !!v.refundable, on_website: !!v.on_website, on_channels: !!v.on_channels, active: !!v.active };
          if (p) await PUT(`/distribution/rate-plans/${p.id}`, b); else await POST('/distribution/rate-plans', b); return 'Rate plan saved.'; });
    },
    'sync-now': async () => { const r = await POST('/distribution/sync'); toast(r.results ? r.results.map((x) => `${esc(x.channel)}: ${x.error ? 'error' : x.pushed + ' updates'}`).join(' · ') || 'Nothing to push.' : 'Nothing waiting.'); render(); },
    'channel-edit': async (d) => {
      const all = await GET('/distribution/channels'); const c = d.id ? all.channels.find((x) => String(x.id) === d.id) : null;
      modal(c ? `Edit ${c.name}` : 'New channel', `<form class="form" data-form="channel"><div class="two"><label>Code (used in the inbound address)<input name="code" value="${esc(c?.code || '')}" ${c ? 'disabled' : 'required'} pattern="[a-z0-9\\-]{2,30}"></label><label>Name<input name="name" value="${esc(c?.name || '')}" required placeholder="Booking.com"></label></div>
        <div class="two"><label>Connector<select name="adapter">${opts(all.adapters.map((a) => [a.id, a.label]), c?.adapter || 'webhook')}</select></label><label>Commission (%)<input name="commission_pct" type="number" min="0" max="99" step="0.5" value="${c?.commission_pct ?? 15}"></label></div>
        <label>Endpoint URL (webhook connector)<input name="endpoint_url" value="${esc(c?.endpoint_url || '')}" placeholder="https://provider.example.com/ari"></label>
        ${c ? `<label class="row"><input type="checkbox" name="active" value="1" ${c.active ? 'checked' : ''}> Active</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => {
          const b = { name: v.name, adapter: v.adapter, commission_pct: Number(v.commission_pct), endpoint_url: v.endpoint_url || null, active: c ? !!v.active : true };
          if (c) { await PUT(`/distribution/channels/${c.id}`, b); return 'Channel saved.'; }
          const r = await POST('/distribution/channels', { ...b, code: v.code });
          setTimeout(() => showSecret(r.code, r.secret), 50); return null;
        });
    },
    'channel-more': async (d) => {
      const all = await GET('/distribution/channels'); const c = all.channels.find((x) => String(x.id) === d.id);
      modal(c.name, `<p>${c.last_error ? `<span class="err">Last error: ${esc(c.last_error)}</span>` : 'No errors.'}</p><div class="row">
        <button class="btn btn-ghost" data-action="channel-edit" data-id="${c.id}">Edit</button><button class="btn btn-ghost" data-action="channel-full" data-id="${c.id}">Full re-sync</button>
        <button class="btn btn-ghost" data-action="channel-secret" data-id="${c.id}" data-code="${esc(c.code)}">New secret</button>${c.adapter === 'simulator' ? `<button class="btn btn-gold" data-action="channel-test" data-id="${c.id}">Send a test booking</button>` : ''}</div>`);
    },
    'channel-full': async (d) => { const r = await POST(`/distribution/channels/${d.id}/full-sync`); closeModal(); toast(r.error ? `Failed: ${esc(r.error)}` : `${r.pushed} updates sent.`, !!r.error); render(); },
    'channel-secret': async (d) => { if (!confirm('Create a new secret? The provider must be updated with it, or messages will be rejected.')) return; const r = await POST(`/distribution/channels/${d.id}/secret`); showSecret(d.code, r.secret); },
    'channel-test': async (d) => { const r = await POST(`/distribution/channels/${d.id}/test-booking`, {}); closeModal(); toast(`Test booking ${esc(r.reservation_code)} received${r.overbooked ? ' (overbooked)' : ''}.`); render(); },
    'channel-log': async (d) => {
      const log = await GET(`/distribution/channels/${d.id}/log`);
      modal(`${d.name}: activity`, table(['When', 'Direction', 'What', 'Result'], log.map((l) => `<tr><td class="nowrap">${ftime(l.created_at)}</td><td>${l.direction === 'out' ? 'Sent' : 'Received'}</td><td>${esc(l.kind)}<br><span class="small muted">${esc(l.summary || '')}</span></td><td>${l.status === 'ok' ? pill('OK', 'ok') : pill('Error', 'bad')}</td></tr>`), 'No activity yet.'));
    },
    'channel-map': async (d) => {
      const [types, plans, maps] = await Promise.all([GET('/room-types'), GET('/distribution/rate-plans'), GET(`/distribution/channels/${d.id}/mappings`)]);
      const m = (t, p) => maps.find((x) => x.room_type_id === t && x.rate_plan_id === p) || {};
      modal(`${d.name}: room & rate codes`, `<form class="form" data-form="channel-map"><p class="note">Enter the channel's own codes for each room type and rate plan you sell there. Leave blank to not sell that combination.</p>
        ${table(['Room type', 'Rate plan', 'Channel room code', 'Channel rate code'], types.filter((t) => t.active).flatMap((t) => plans.filter((p) => p.active && p.on_channels).map((p) => `<tr><td>${esc(t.name)}</td><td>${esc(p.name)}</td><td><input class="search" name="r_${t.id}_${p.id}" value="${esc(m(t.id, p.id).external_room_code || '')}" maxlength="40"></td><td><input class="search" name="p_${t.id}_${p.id}" value="${esc(m(t.id, p.id).external_rate_code || '')}" maxlength="40"></td></tr>`)))}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save mapping</button></div></form>`,
        async (v) => {
          const mappings = Object.keys(v).filter((k) => k.startsWith('r_')).map((k) => { const [, t, p] = k.split('_'); return { room_type_id: Number(t), rate_plan_id: Number(p), external_room_code: v[k], external_rate_code: v[`p_${t}_${p}`] }; }).filter((x) => x.external_room_code && x.external_rate_code);
          await PUT(`/distribution/channels/${d.id}/mappings`, { mappings }); return 'Mapping saved. Run a full re-sync to send everything to the channel.';
        });
    },

    'new-req': async () => {
      const S = await invSetup(true);
      const main = S.stores.find((x) => x.kind === 'main') || S.stores[0];
      modal('New requisition', `<form class="form" data-form="new-req"><div class="three"><label>Department<select name="department">${opts(S.departments.map((x) => [x, x]))}</select></label>
        <label>From store<select name="from_store_id">${opts(S.stores.filter((x) => x.active).map((x) => [x.id, x.name]), main?.id)}</select></label>
        <label>Send to<select name="to_store_id">${opts([['', 'Used by the department'], ...S.stores.filter((x) => x.active).map((x) => [x.id, x.name + ' store'])])}</select></label></div>
        ${lineRows(6, S.items)}<label>Notes<input name="notes" maxlength="500"></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Submit for approval</button></div></form>`,
        async (v) => { const lines = readLines(v, 6); const r = await POST('/inventory/requisitions', { department: v.department, from_store_id: Number(v.from_store_id), to_store_id: v.to_store_id ? Number(v.to_store_id) : null, notes: v.notes, lines }); return `Requisition ${esc(r.code)} sent for approval.`; });
    },
    'open-req': async (d) => {
      const r = await GET(`/inventory/requisitions/${d.id}`);
      const canApprove = r.status === 'pending' && CAN['requisition.approve'] && (r.requested_by !== ME.id || ME.role === 'admin');
      const canIssue = r.status === 'approved' && CAN['requisition.issue'];
      const editCol = canApprove ? 'Approve qty' : canIssue ? 'Issue qty' : null;
      modal(`${r.code} · ${r.department}`, `<form class="form" data-form="req-act" data-id="${r.id}">
        <dl class="kv"><dt>From</dt><dd>${esc(r.from_store)}</dd><dt>To</dt><dd>${esc(r.to_store || 'Used by the department (expensed)')}</dd><dt>Requested by</dt><dd>${esc(r.requested_by_name || '')}, ${ftime(r.requested_at)}</dd>${r.approved_by_name ? `<dt>${r.status === 'rejected' ? 'Rejected' : 'Approved'} by</dt><dd>${esc(r.approved_by_name)}</dd>` : ''}${r.issued_by_name ? `<dt>Issued by</dt><dd>${esc(r.issued_by_name)}, cost ${ugx(r.total_cost)}</dd>` : ''}<dt>Status</dt><dd>${pill(...RQ_STATUS[r.status])}</dd></dl>
        ${r.notes ? `<p class="note">${esc(r.notes)}</p>` : ''}${r.reject_reason ? `<p class="note err">Rejected: ${esc(r.reject_reason)}</p>` : ''}
        ${table(['Item', '#Requested', '#Approved', '#Issued', '#In store', ...(editCol ? [editCol] : [])], r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${qn(l.qty_requested)} ${esc(l.unit)}</td><td class="num">${l.qty_approved != null ? qn(l.qty_approved) : ''}</td><td class="num">${l.qty_issued != null ? qn(l.qty_issued) : ''}</td><td class="num ${l.in_store < (l.qty_approved ?? l.qty_requested) ? 'err' : ''}">${qn(l.in_store)}</td>
          ${editCol ? `<td><input class="search" type="number" min="0" step="0.001" name="l_${l.id}" value="${canApprove ? l.qty_requested : l.qty_approved}" aria-label="${editCol} ${esc(l.name)}"></td>` : ''}</tr>`))}
        ${canApprove ? `<label>Reason (only if rejecting)<input name="reason" maxlength="300"></label>` : ''}
        <div class="actions">${canApprove ? '<button type="submit" class="btn btn-bad" name="do" value="reject">Reject</button><button type="submit" class="btn btn-gold" name="do" value="approve">Approve</button>' : ''}
          ${canIssue ? '<button type="submit" class="btn btn-gold" name="do" value="issue">Issue from store</button>' : ''}
          ${r.status === 'pending' && (r.requested_by === ME.id || CAN['requisition.approve']) ? '<button type="submit" class="btn btn-ghost" name="do" value="cancel">Cancel requisition</button>' : ''}
          ${!canApprove && !canIssue ? cancelBtn : ''}</div></form>`, null);
    },
    'new-po': async () => {
      const S = await invSetup(true);
      modal('New purchase order', `<form class="form" data-form="new-po"><div class="three"><label>Supplier<select name="supplier_id">${opts(S.suppliers.filter((x) => x.active).map((x) => [x.id, x.name]))}</select></label>
        <label>Deliver to<select name="store_id">${opts(S.stores.filter((x) => x.active).map((x) => [x.id, x.name]), (S.stores.find((x) => x.kind === 'main') || {}).id)}</select></label><label>Expected<input type="date" name="expected_date"></label></div>
        ${lineRows(6, S.items, { cost: true })}<label>Notes<input name="notes" maxlength="500"></label><p class="note">A manager approves the order before it can be received.</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Save order</button></div></form>`,
        async (v) => { const po = await POST('/inventory/purchase-orders', { supplier_id: Number(v.supplier_id), store_id: Number(v.store_id), expected_date: v.expected_date || null, notes: v.notes, lines: readLines(v, 6, true) }); return `Order ${esc(po.code)} saved and waiting for approval.`; });
    },
    'open-po': async (d) => {
      const p = await GET(`/inventory/purchase-orders/${d.id}`);
      const canApprove = p.status === 'draft' && CAN['purchase.approve'] && (p.created_by !== ME.id || ME.role === 'admin');
      const canReceive = ['approved', 'partly_received'].includes(p.status) && CAN['inventory.receive'];
      modal(`${p.code} · ${p.supplier_name}`, `<form class="form" data-form="po-act" data-id="${p.id}">
        <dl class="kv"><dt>Deliver to</dt><dd>${esc(p.store_name)}</dd><dt>Raised by</dt><dd>${esc(p.created_by_name || '')}, ${ftime(p.created_at)}</dd>${p.approved_by_name ? `<dt>Approved by</dt><dd>${esc(p.approved_by_name)}</dd>` : ''}<dt>Status</dt><dd>${pill(...PO_STATUS[p.status])}</dd><dt>Value</dt><dd>${ugx(p.total)}</dd></dl>
        ${table(['Item', '#Ordered', '#Received', '#Unit cost', ...(canReceive ? ['Receiving now', 'Actual unit cost'] : [])], p.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${qn(l.qty)} ${esc(l.unit)}</td><td class="num">${qn(l.received_qty)}</td><td class="num">${num(l.unit_cost)}</td>
          ${canReceive ? `<td><input class="search" type="number" min="0" step="0.001" name="q_${l.item_id}" value="${Math.max(0, Math.round((l.qty - l.received_qty) * 1000) / 1000)}"></td><td><input class="search" type="number" min="0" step="1" name="c_${l.item_id}" value="${l.unit_cost}"></td>` : ''}</tr>`))}
        ${canReceive ? '<label>Supplier invoice / delivery note number<input name="invoice_ref" maxlength="60"></label>' : ''}
        <div class="actions">${canApprove ? '<button class="btn btn-gold" name="do" value="approve">Approve order</button>' : ''}${canReceive ? '<button class="btn btn-gold" name="do" value="receive">Receive delivery</button>' : ''}
          ${['draft', 'approved'].includes(p.status) ? '<button class="btn btn-ghost" name="do" value="cancel">Cancel order</button>' : ''}${!canApprove && !canReceive ? cancelBtn : ''}</div></form>`, null);
    },
    receive: async (d) => {
      const S = await invSetup(true); const opening = d.mode === 'opening';
      modal(opening ? 'Opening stock' : 'Delivery without an order', `<form class="form" data-form="receive" data-opening="${opening ? 1 : ''}"><div class="two">
        <label>Into store<select name="store_id">${opts(S.stores.filter((x) => x.active).map((x) => [x.id, x.name]), (S.stores.find((x) => x.kind === 'main') || {}).id)}</select></label>
        ${opening ? '<span></span>' : `<label>Supplier<select name="supplier_id">${opts(S.suppliers.filter((x) => x.active).map((x) => [x.id, x.name]))}</select></label>`}</div>
        ${lineRows(8, S.items, { cost: true })}${opening ? '<p class="note">Use this once at go-live to record what is already on the shelves. It is credited to owner\'s equity, not to a supplier.</p>' : '<label>Supplier invoice / delivery note number<input name="invoice_ref" maxlength="60"></label>'}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Receive</button></div></form>`,
        async (v) => { const g = await POST('/inventory/receipts', { is_opening: opening, store_id: Number(v.store_id), supplier_id: v.supplier_id ? Number(v.supplier_id) : null, invoice_ref: v.invoice_ref, lines: readLines(v, 8, true) }); INVS = null; return `${esc(g.code)} recorded: ${ugx(g.total)}.`; });
    },
    'write-off': async () => {
      const S = await invSetup(true);
      modal('Write off stock', `<form class="form" data-form="wo"><div class="two"><label>Store<select name="store_id">${opts(S.stores.filter((x) => x.active).map((x) => [x.id, x.name]))}</select></label><label>Item<select name="item_id">${itemOpts(S.items)}</select></label></div>
        <div class="two"><label>Quantity<input name="qty" type="number" min="0" step="0.001" required></label><label>Reason<input name="reason" required maxlength="300" placeholder="Broken, expired, spoiled…"></label></div><div class="actions">${cancelBtn}<button class="btn btn-bad">Write off</button></div></form>`,
        async (v) => { const r = await POST('/inventory/write-offs', { store_id: Number(v.store_id), item_id: Number(v.item_id), qty: Number(v.qty), reason: v.reason }); return `Written off: ${ugx(r.value)}.`; });
    },
    movements: async (d) => {
      const [mv, bal] = await Promise.all([GET(`/inventory/items/${d.id}/movements`), GET(`/inventory/items/${d.id}/balances`)]);
      modal(`${d.name}: history`, `<p>${bal.map((b) => `${esc(b.name)}: <b>${qn(b.qty)}</b>`).join(' · ') || 'No stock anywhere.'}</p>${table(['Date', 'What', 'Store', '#Qty', '#Unit cost', 'By'], mv.map((m) => `<tr><td class="nowrap">${fdate(m.business_date)}</td><td>${MV[m.kind]}${m.note ? `<br><span class="small muted">${esc(m.note)}</span>` : ''}</td><td>${esc(m.store_name)}</td><td class="num ${m.qty < 0 ? 'err' : ''}">${m.qty > 0 ? '+' : ''}${qn(m.qty)}</td><td class="num">${num(m.unit_cost)}</td><td>${esc(m.user_name || '')}</td></tr>`), 'No movements yet.')}`);
    },
    'cancel-count': async (d) => { if (!confirm('Cancel this count? Nothing will be adjusted.')) return; await POST(`/inventory/counts/${d.id}/cancel`); location.hash = '#counts'; },
    'stock-item': async (d) => {
      const S = await invSetup(true); const i = d.id ? S.items.find((x) => String(x.id) === d.id) : null;
      modal(i ? `Edit ${i.name}` : 'New stock item', `<form class="form" data-form="si"><div class="two"><label>Code<input name="code" value="${esc(i?.code || '')}" ${i ? 'disabled' : 'required'} maxlength="20"></label><label>Name<input name="name" value="${esc(i?.name || '')}" required maxlength="120"></label></div>
        <div class="three"><label>Unit<input name="unit" value="${esc(i?.unit || '')}" required maxlength="20" placeholder="kg, litre, bottle…"></label><label>Category<input name="category" value="${esc(i?.category || '')}" maxlength="60"></label><label>Re-order level<input name="reorder_level" type="number" min="0" step="0.001" value="${i?.reorder_level ?? 0}"></label></div>
        ${i ? `<label class="row"><input type="checkbox" name="active" value="1" ${i.active ? 'checked' : ''}> Active</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const b = { code: v.code, name: v.name, unit: v.unit, category: v.category, reorder_level: Number(v.reorder_level), active: i ? !!v.active : true }; if (i) await PUT(`/inventory/items/${i.id}`, b); else await POST('/inventory/items', b); INVS = null; return 'Item saved.'; });
    },
    supplier: async (d) => {
      const S = await invSetup(true); const x = d.id ? S.suppliers.find((y) => String(y.id) === d.id) : null;
      modal(x ? `Edit ${x.name}` : 'New supplier', `<form class="form" data-form="sup"><label>Name<input name="name" value="${esc(x?.name || '')}" required></label><div class="two"><label>Contact person<input name="contact" value="${esc(x?.contact || '')}"></label><label>Phone<input name="phone" value="${esc(x?.phone || '')}"></label></div>
        <div class="two"><label>Email<input name="email" type="email" value="${esc(x?.email || '')}"></label><label>TIN<input name="tin" value="${esc(x?.tin || '')}"></label></div>${x ? `<label class="row"><input type="checkbox" name="active" value="1" ${x.active ? 'checked' : ''}> Active</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const b = { ...v, active: x ? !!v.active : true }; if (x) await PUT(`/inventory/suppliers/${x.id}`, b); else await POST('/inventory/suppliers', b); INVS = null; return 'Supplier saved.'; });
    },
    'store-edit': async (d) => {
      const S = await invSetup(true); const x = d.id ? S.stores.find((y) => String(y.id) === d.id) : null;
      modal(x ? `Edit ${x.name}` : 'New store', `<form class="form" data-form="store"><label>Name<input name="name" value="${esc(x?.name || '')}" required></label>${x ? `<label class="row"><input type="checkbox" name="active" value="1" ${x.active ? 'checked' : ''}> Active</label>` : `<label>Type<select name="kind">${opts([['other', 'Other'], ['main', 'Main store'], ['kitchen', 'Kitchen'], ['bar', 'Bar'], ['housekeeping', 'Housekeeping'], ['maintenance', 'Maintenance']])}</select></label>`}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { if (x) await PUT(`/inventory/stores/${x.id}`, { name: v.name, active: !!v.active }); else await POST('/inventory/stores', v); INVS = null; return 'Store saved.'; });
    },
    recipe: async (d) => {
      const [S, lines] = await Promise.all([invSetup(true), GET(`/inventory/recipes/${d.id}`)]);
      modal(`Recipe: ${d.name}`, `<form class="form" data-form="recipe"><p class="note">Quantity of each ingredient used for one portion, in the item's stock unit (e.g. 0.25 kg).</p>${lineRows(6, S.items, { pre: lines })}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save recipe</button></div></form>`,
        async (v) => { await PUT(`/inventory/recipes/${d.id}`, { lines: readLines(v, 6) }); return 'Recipe saved.'; });
    },

    'pos-outlet': (d) => { ui.posOutlet = Number(d.id); render(); },
    'pos-cat': (d) => { ui.posCat = Number(d.id); render(); },
    'new-check': (d) => modal(`Open ${d.name}`, `<form class="form" data-form="new-check"><label>Number of guests<input name="covers" type="number" min="1" value="2" required></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Open bill</button></div></form>`,
      async (v) => { const c = await POST('/pos/checks', { outlet_id: ui.posOutlet || undefined, table_id: Number(d.table), covers: Number(v.covers) }); location.hash = `#check/${c.id}`; return null; }),
    'quick-check': async () => { const c = await POST('/pos/checks', { outlet_id: ui.posOutlet || undefined, covers: 1 }); location.hash = `#check/${c.id}`; },
    'room-service': async () => {
      const [rooms, setup] = await Promise.all([GET('/pos/rooms'), posSetup()]);
      const rsOutlet = setup.outlets.find((o) => o.kind === 'room_service' && o.active);
      modal('Room service', `<form class="form" data-form="room-service"><label>Guest room<select name="res" required>${opts(rooms.map((r) => [r.reservation_id, `Room ${r.room_number} · ${guestName(r)}`]))}</select></label>${rooms.length ? '' : '<p class="note">No guests are in-house.</p>'}<div class="actions">${cancelBtn}<button class="btn btn-gold" ${rooms.length ? '' : 'disabled'}>Open bill</button></div></form>`,
        async (v) => { const c = await POST('/pos/checks', { outlet_id: (rsOutlet || {}).id || ui.posOutlet || undefined, reservation_id: Number(v.res) }); location.hash = `#check/${c.id}`; return null; });
    },
    'close-shift': async () => {
      const s = await GET('/pos/shift');
      modal('Close shift', `<form class="form" data-form="close-shift"><dl class="kv"><dt>Opening float</dt><dd>${ugx(s.opening_float)}</dd><dt>Cash sales</dt><dd>${ugx(s.takings.cash)}</dd><dt>Card</dt><dd>${ugx(s.takings.card)}</dd><dt>Mobile money</dt><dd>${ugx(s.takings.mobile_money)}</dd><dt>Charged to rooms</dt><dd>${ugx(s.takings.room)}</dd></dl>
        <label>Cash counted in the drawer (UGX)<input name="counted_cash" type="number" min="0" step="1" required></label><label>Notes<input name="notes" maxlength="500"></label>
        <p class="note">Count the cash before you look at the expected amount. The difference is recorded on the shift report.</p><div class="actions">${cancelBtn}<button class="btn btn-gold">Close shift</button></div></form>`,
        async (v) => { const r = await POST('/pos/shift/close', { counted_cash: Number(v.counted_cash), notes: v.notes }); return `Shift closed. Expected ${ugx(r.expected_cash)}, counted ${ugx(r.counted_cash)}, difference ${ugx(r.variance)}.`; });
    },
    'add-item': async (d, e) => {
      let note = null;
      if (e.shiftKey) { note = prompt('Note for the kitchen/bar (e.g. no onions):'); if (note === null) return; }
      await POST(`/pos/checks/${d.check}/lines`, { item_id: Number(d.id), qty: 1, note }); render();
    },
    'line-note': (d) => modal('Note for the kitchen / bar', `<form class="form" data-form="line-note"><label>Note<input name="note" value="${esc(d.note)}" maxlength="200" placeholder="e.g. no onions, well done"></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Save note</button></div></form>`,
      async (v) => { await PATCH(`/pos/lines/${d.id}`, { note: v.note }); return null; }),
    'line-qty': async (d) => { await PATCH(`/pos/lines/${d.id}`, { qty: Number(d.qty) }); render(); },
    'line-void': (d) => modal('Void item', `<form class="form" data-form="line-void"><p class="note">This item was already sent to the kitchen or bar. The void is recorded with your name.</p><label>Reason<input name="reason" required maxlength="300"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Void item</button></div></form>`,
      async (v) => { await PATCH(`/pos/lines/${d.id}`, { qty: 0, reason: v.reason }); return 'Item voided.'; }),
    'send-check': async (d) => { const r = await POST(`/pos/checks/${d.id}/send`); toast(`Sent to ${r.tickets.map((t) => t.station).join(' and ')}.`); render(); },
    'pay-check': (d) => payForm(d.id, Number(d.total), d.res ? Number(d.res) : ''),
    'move-check': async (d) => {
      const [c, setup] = await Promise.all([GET(`/pos/checks/${d.id}`), posSetup()]);
      const floor = await GET(`/pos/floor?outlet_id=${c.check.outlet_id}`);
      modal('Move to table', `<form class="form" data-form="move"><label>Table<select name="table_id">${opts(floor.tables.filter((t) => !t.check_id).map((t) => [t.id, `${t.name} (${t.seats} seats)`]))}</select></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Move</button></div></form>`,
        async (v) => { await POST(`/pos/checks/${d.id}/move`, { table_id: Number(v.table_id) }); return 'Bill moved.'; });
    },
    'void-check': (d) => modal('Void bill', `<form class="form" data-form="void-check"><label>Reason<input name="reason" required maxlength="300"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Void bill</button></div></form>`,
      async (v) => { await POST(`/pos/checks/${d.id}/void`, v); location.hash = '#pos'; return 'Bill voided.'; }),
    ticket: async (d) => { await POST(`/pos/tickets/${d.id}/status`, { status: d.status }); render(); },
    'item-edit': async (d) => {
      const setup = await posSetup(true); const i = d.id ? setup.items.find((x) => String(x.id) === d.id) : null;
      modal(i ? `Edit ${i.name}` : 'New menu item', `<form class="form" data-form="item"><label>Name<input name="name" value="${esc(i?.name || '')}" required maxlength="120"></label>
        <div class="two"><label>Category<select name="category_id">${opts(setup.categories.map((c) => [c.id, c.name]), i?.category_id)}</select></label><label>Price (UGX, VAT included)<input name="price" type="number" min="0" step="1" value="${i?.price ?? ''}" required></label></div>
        ${i ? `<label class="row"><input type="checkbox" name="active" value="1" ${i.active ? 'checked' : ''}> On sale</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const body = { name: v.name, category_id: Number(v.category_id), price: Number(v.price), active: i ? !!v.active : true }; if (i) await PUT(`/pos/items/${i.id}`, body); else await POST('/pos/items', body); POS = null; return 'Menu saved.'; });
    },
    'cat-edit': async (d) => {
      const setup = await posSetup(true); const c = d.id ? setup.categories.find((x) => String(x.id) === d.id) : null;
      modal(c ? `Edit ${c.name}` : 'New category', `<form class="form" data-form="cat"><label>Name<input name="name" value="${esc(c?.name || '')}" required></label>
        <div class="two"><label>Tickets go to<select name="station">${opts([['kitchen', 'Kitchen'], ['bar', 'Bar']], c?.station)}</select></label><label>Display order<input name="sort" type="number" value="${c?.sort ?? 0}"></label></div>
        ${c ? `<label class="row"><input type="checkbox" name="active" value="1" ${c.active ? 'checked' : ''}> Active</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const body = { name: v.name, station: v.station, sort: Number(v.sort), active: c ? !!v.active : true }; if (c) await PUT(`/pos/categories/${c.id}`, body); else await POST('/pos/categories', body); POS = null; return 'Category saved.'; });
    },
    'table-edit': async (d) => {
      const setup = await posSetup(true); const t = d.id ? setup.tables.find((x) => String(x.id) === d.id) : null;
      modal(t ? `Edit table ${t.name}` : 'New table', `<form class="form" data-form="table"><div class="two"><label>Table name<input name="name" value="${esc(t?.name || '')}" required maxlength="20"></label><label>Seats<input name="seats" type="number" min="1" value="${t?.seats ?? 4}"></label></div>
        ${t ? `<label class="row"><input type="checkbox" name="active" value="1" ${t.active ? 'checked' : ''}> In use</label>` : `<label>Outlet<select name="outlet_id">${opts(setup.outlets.map((o) => [o.id, o.name]))}</select></label>`}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { if (t) await PUT(`/pos/tables/${t.id}`, { name: v.name, seats: Number(v.seats), active: !!v.active }); else await POST('/pos/tables', { name: v.name, seats: Number(v.seats), outlet_id: Number(v.outlet_id) }); POS = null; return 'Table saved.'; });
    },
    'outlet-edit': async (d) => {
      const setup = await posSetup(true); const o = d.id ? setup.outlets.find((x) => String(x.id) === d.id) : null;
      modal(o ? `Edit ${o.name}` : 'New outlet', `<form class="form" data-form="outlet"><label>Name<input name="name" value="${esc(o?.name || '')}" required></label>
        ${o ? `<label class="row"><input type="checkbox" name="active" value="1" ${o.active ? 'checked' : ''}> Active</label>` : `<label>Type<select name="kind">${opts([['restaurant', 'Restaurant'], ['bar', 'Bar'], ['room_service', 'Room service'], ['other', 'Other']])}</select></label>`}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { if (o) await PUT(`/pos/outlets/${o.id}`, { name: v.name, active: !!v.active }); else await POST('/pos/outlets', { name: v.name, kind: v.kind }); POS = null; return 'Outlet saved.'; });
    },
    'close-modal': closeModal,
    'toggle-nav': () => document.body.classList.toggle('nav-open'),
    tab: (d) => { ui.tab[d.key] = d.val; render(); },
    print: () => window.print(),
    logout: async () => { await POST('/auth/logout'); ME = null; renderLogin(); },
    'change-password': () => modal('Change password', `<form class="form" data-form="pw"><label>Current password<input type="password" name="current_password" required autocomplete="current-password"></label><label>New password (8+ characters)<input type="password" name="new_password" minlength="8" required autocomplete="new-password"></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Change</button></div></form>`,
      async (v) => { await POST('/auth/change-password', v); return 'Password changed.'; }),
    'new-res': () => newReservation(),
    'check-in': (d) => checkInForm(d.id),
    'check-out': async (d) => {
      if (Number(d.bal) > 0) { toast(`Balance of ${ugx(d.bal)} is still due. Take payment first.`, true); return; }
      if (!confirm('Check this guest out?')) return;
      await POST(`/reservations/${d.id}/check-out`); toast('Checked out. Room sent to housekeeping.'); refresh();
    },
    'post-charge': (d) => modal('Post charge', `<form class="form" data-form="charge"><label>Description<input name="description" required maxlength="200" placeholder="e.g. Dinner, Laundry, Minibar"></label>
      <div class="two"><label>Department<select name="department">${opts(Object.entries(DEPT), 'fnb')}</select></label><label>Amount (UGX, VAT included)<input name="amount" type="number" min="1" step="1" required></label></div>
      <div class="actions">${cancelBtn}<button class="btn btn-gold">Post to bill</button></div></form>`,
      async (v) => { await POST(`/reservations/${d.id}/charges`, { description: v.description, department: v.department, amount: Number(v.amount) }); return 'Charge posted.'; }),
    'take-payment': (d) => paymentForm(d.id, Number(d.bal), d.company),
    'edit-res': async (d) => {
      const [{ reservation: r }, types] = await Promise.all([GET(`/reservations/${d.id}`), GET('/room-types')]);
      const inHouse = r.status === 'in_house';
      modal('Edit stay', `<form class="form" data-form="edit-res"><div class="two"><label>Arrival<input type="date" name="arrival" value="${r.arrival}" ${inHouse ? 'disabled' : ''} required></label><label>Departure<input type="date" name="departure" value="${r.departure}" required></label></div>
        <div class="two"><label>Room type<select name="room_type_id" ${inHouse ? 'disabled' : ''}>${opts(types.map((t) => [t.id, t.name]), r.room_type_id)}</select></label><label>Nightly rate<input name="rate" type="number" min="0" value="${r.rate}" ${inHouse ? 'disabled' : ''}></label></div>
        <label>Company<input name="company_name" value="${esc(r.company_name || '')}"></label><label>Notes<textarea name="notes" rows="2">${esc(r.notes || '')}</textarea></label>
        ${inHouse ? '<p class="note">Guest is in-house: only the departure date, company and notes can change.</p>' : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const body = { departure: v.departure, notes: v.notes, company_name: v.company_name }; if (!inHouse) Object.assign(body, { arrival: v.arrival, room_type_id: Number(v.room_type_id), rate: Number(v.rate) }); await PUT(`/reservations/${d.id}`, body); return 'Stay updated.'; });
    },
    'cancel-res': (d) => modal('Cancel booking', `<form class="form" data-form="cancel"><label>Reason<input name="reason" required maxlength="300"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Cancel booking</button></div></form>`,
      async (v) => { await POST(`/reservations/${d.id}/cancel`, v); return 'Booking cancelled.'; }),
    void: (d) => modal(`Void ${d.kind}`, `<form class="form" data-form="void"><p class="note">The original entry stays on record and a reversing entry is posted to the accounts.</p><label>Reason<input name="reason" required maxlength="300"></label><div class="actions">${cancelBtn}<button class="btn btn-bad">Void</button></div></form>`,
      async (v) => { await POST(`/${d.kind === 'charge' ? 'charges' : 'payments'}/${d.id}/void`, v); return `${d.kind === 'charge' ? 'Charge' : 'Payment'} voided.`; }),
    room: (d) => {
      if (d.res) { location.hash = `#res/${d.res}`; return; }
      const hkBtns = CAN['housekeeping.update'] ? ['clean', 'dirty', 'out_of_order'].filter((h) => h !== d.hk).map((h) => `<button class="btn btn-ghost" data-action="hk" data-id="${d.id}" data-hk="${h}">Mark ${HK[h].toLowerCase()}</button>`).join('') : '';
      modal(`Room ${d.number}`, `<p>Status: <b>${HK[d.hk]}</b>. Vacant.</p><div class="row">${hkBtns || '<span class="muted">No actions available.</span>'}</div>`);
    },
    hk: async (d) => { await PATCH(`/rooms/${d.id}/housekeeping`, { hk_status: d.hk }); closeModal(); toast('Room updated.'); render(); },
    'run-audit': async () => {
      if (!confirm(`Run the night audit for ${fdateLong(SETTINGS.business_date)}? This cannot be undone.`)) return;
      const r = await POST('/night-audit'); toast(`Night audit complete: ${r.room_charges_posted} room charges (${ugx(r.room_revenue)}), ${r.no_shows} no-show(s). Business date is now ${fdate(r.new_business_date)}.`); refresh();
    },
    'room-type': async (d) => {
      const t = d.id ? (await GET('/room-types')).find((x) => String(x.id) === d.id) : null;
      modal(t ? `Edit ${t.name}` : 'New room type', `<form class="form" data-form="rt"><div class="two"><label>Code<input name="code" value="${esc(t?.code || '')}" ${t ? 'disabled' : 'required'} maxlength="10"></label><label>Name<input name="name" value="${esc(t?.name || '')}" required></label></div>
        <div class="two"><label>Standard rate (UGX)<input name="base_rate" type="number" min="0" value="${t?.base_rate ?? ''}" required></label><label>Max guests<input name="max_occupancy" type="number" min="1" value="${t?.max_occupancy ?? 2}"></label></div>
        ${t ? `<label class="row"><input type="checkbox" name="active" value="1" ${t.active ? 'checked' : ''}> Active</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { const body = { name: v.name, base_rate: Number(v.base_rate), max_occupancy: Number(v.max_occupancy), code: v.code }; if (t) { body.active = !!v.active; await PUT(`/room-types/${t.id}`, body); } else await POST('/room-types', body); return 'Room type saved.'; });
    },
    'room-edit': async (d) => {
      const [types, rooms] = await Promise.all([GET('/room-types'), GET('/rooms')]); const r = d.id ? rooms.find((x) => String(x.id) === d.id) : null;
      modal(r ? `Edit room ${r.number}` : 'New room', `<form class="form" data-form="room"><div class="two"><label>Room number<input name="number" value="${esc(r?.number || '')}" ${r ? 'disabled' : 'required'} maxlength="10"></label><label>Floor<input name="floor" value="${esc(r?.floor || '')}" maxlength="10"></label></div>
        <label>Room type<select name="room_type_id">${opts(types.map((t) => [t.id, t.name]), r?.room_type_id)}</select></label>${r ? `<label>Notes<input name="notes" value="${esc(r.notes || '')}"></label><label class="row"><input type="checkbox" name="active" value="1" ${r.active ? 'checked' : ''}> Active (in service)</label>` : ''}
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { if (r) await PUT(`/rooms/${r.id}`, { room_type_id: Number(v.room_type_id), floor: v.floor, notes: v.notes, active: !!v.active }); else await POST('/rooms', { number: v.number, floor: v.floor, room_type_id: Number(v.room_type_id) }); return 'Room saved.'; });
    },
    'user-edit': async (d) => {
      const u = d.id ? (await GET('/users')).find((x) => String(x.id) === d.id) : null;
      modal(u ? `Edit ${u.full_name}` : 'New user', `<form class="form" data-form="user"><div class="two"><label>Full name<input name="full_name" value="${esc(u?.full_name || '')}" required></label><label>Username<input name="username" value="${esc(u?.username || '')}" ${u ? 'disabled' : 'required'} pattern="[a-z0-9._\\-]{3,40}" title="3–40 lowercase letters, numbers, dots, dashes or underscores"></label></div>
        <div class="two"><label>Role<select name="role">${opts(Object.entries(ROLE), u?.role || 'front_office')}</select></label><label>${u ? 'Reset password (optional)' : 'Password (8+ characters)'}<input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label></div>
        ${u ? `<label class="row"><input type="checkbox" name="active" value="1" ${u.active ? 'checked' : ''}> Account active</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
        async (v) => { if (u) await PUT(`/users/${u.id}`, { full_name: v.full_name, role: v.role, active: !!v.active, password: v.password || undefined }); else await POST('/users', v); return 'User saved.'; });
    },
  };

  const FORMS = {
    'att-date': (v) => { ui.q.attDate = v.date; render(); },
    'new-run': async (v) => { const r = await POST('/hr/payroll', { period: v.period }); location.hash = `#payrun/${r.id}`; },
    roster: async (v) => {
      const entries = Object.entries(v).filter(([k]) => k.startsWith('r_')).map(([k, val]) => { const [, emp, date] = k.split('_'); return { employee_id: Number(emp), date, shift_id: val === '' ? undefined : val === 'off' ? null : Number(val) }; });
      await PUT('/hr/roster', { entries: entries.map((x) => (x.shift_id === undefined ? { ...x, shift_id: '' } : x)) }); toast('Roster saved.'); render();
    },
    range: (v, form) => { const k = form.dataset.key; ui.q[k + 'From'] = v.from; ui.q[k + 'To'] = v.to; if (v.code) ui.q.glCode = v.code; render(); },
    invoice: async (v, form) => {
      const payment_ids = Object.keys(v).filter((k) => k.startsWith('p_')).map((k) => Number(k.slice(2)));
      const extra_lines = [0, 1].map((k) => ({ description: v['xd_' + k], department: v['xt_' + k], amount: Number(v['xa_' + k]) })).filter((x) => x.description && x.amount);
      const inv = await POST('/finance/invoices', { company_id: Number(form.dataset.id), payment_ids, extra_lines }); toast(`Invoice ${esc(inv.number)} created.`); location.hash = `#invoice/${inv.id}`;
    },
    'bill-stock': async (v, form) => {
      const grn_ids = Object.keys(v).filter((k) => k.startsWith('g_')).map((k) => Number(k.slice(2)));
      if (!grn_ids.length) throw new Error('Tick the deliveries this invoice covers.');
      await POST('/finance/bills', { supplier_id: Number(form.dataset.id), kind: 'stock', grn_ids, bill_number: v.bill_number, bill_date: v.bill_date }); toast('Supplier invoice recorded.'); render();
    },
    'rec-start': async (v) => { const r = await POST('/finance/reconciliations', { ...v, statement_balance: Number(v.statement_balance) }); location.hash = `#rec/${r.id}`; },
    lock: async (v) => { await PUT('/finance/lock', { until: v.until || null }); await refreshSettings(); toast(v.until ? `Books closed up to ${fdate(v.until)}.` : 'Books reopened.'); render(); },
    'online-pay': async (v) => { await PUT('/finance/online-payments', { enabled: !!v.enabled, provider: v.provider }); toast('Online payment settings saved.'); render(); },
    'rate-from': (v) => { ui.q.rateFrom = v.from; render(); },
    'booking-settings': async (v) => { await PUT('/distribution/booking-settings', { ...v, booking_enabled: !!v.booking_enabled, booking_horizon_days: Number(v.booking_horizon_days) }); toast('Booking engine settings saved.'); render(); },

    invrep: (v) => { ui.q.invFrom = v.from; ui.q.invTo = v.to; render(); },
    'start-count': async (v) => { const c = await POST('/inventory/counts', { store_id: Number(v.store_id) }); location.hash = `#count/${c.id}`; },
    'count-sheet': async (v, form, submitter) => {
      const id = form.dataset.id;
      const lines = Object.entries(v).filter(([k]) => k.startsWith('c_')).map(([k, val]) => ({ item_id: Number(k.slice(2)), counted_qty: val === '' ? null : Number(val) }));
      await PUT(`/inventory/counts/${id}/lines`, { lines });
      if (submitter?.value === 'post') {
        if (!confirm('Post this count? Stock will be adjusted to the counted quantities and the differences posted to the accounts.')) { toast('Progress saved.'); return; }
        const r = await POST(`/inventory/counts/${id}/post`); toast(`Count posted. Losses ${ugx(r.loss)}, gains ${ugx(r.gain)}.`);
      } else toast('Progress saved.');
      render();
    },
    'req-act': async (v, form, submitter) => {
      const id = form.dataset.id, act = submitter?.value;
      const lines = Object.entries(v).filter(([k]) => k.startsWith('l_')).map(([k, val]) => ({ id: Number(k.slice(2)), qty: Number(val) }));
      if (act === 'approve') await POST(`/inventory/requisitions/${id}/approve`, { lines: lines.map((l) => ({ id: l.id, qty_approved: l.qty })) });
      else if (act === 'reject') await POST(`/inventory/requisitions/${id}/reject`, { reason: v.reason });
      else if (act === 'issue') { const r = await POST(`/inventory/requisitions/${id}/issue`, { lines: lines.map((l) => ({ id: l.id, qty_issued: l.qty })) }); toast(`Issued. Cost ${ugx(r.total)}.`); }
      else if (act === 'cancel') await POST(`/inventory/requisitions/${id}/cancel`);
      closeModal(); if (act !== 'issue') toast({ approve: 'Approved.', reject: 'Rejected.', cancel: 'Cancelled.' }[act] || 'Done.'); render();
    },
    'po-act': async (v, form, submitter) => {
      const id = form.dataset.id, act = submitter?.value;
      if (act === 'approve') await POST(`/inventory/purchase-orders/${id}/approve`);
      else if (act === 'cancel') { if (!confirm('Cancel this order?')) return; await POST(`/inventory/purchase-orders/${id}/cancel`); }
      else if (act === 'receive') {
        const lines = Object.entries(v).filter(([k]) => k.startsWith('q_')).map(([k, q]) => ({ item_id: Number(k.slice(2)), qty: Number(q), unit_cost: Number(v['c_' + k.slice(2)]) })).filter((l) => l.qty > 0);
        const g = await POST('/inventory/receipts', { po_id: Number(id), invoice_ref: v.invoice_ref, lines }); toast(`${esc(g.code)} received: ${ugx(g.total)}.`);
      }
      closeModal(); if (act !== 'receive') toast(act === 'approve' ? 'Order approved.' : 'Order cancelled.'); render();
    },
    login: async (v) => { try { const r = await POST('/auth/login', v); ME = r.user; await boot(); } catch (e) { renderLogin(e.message); } },
    'res-search': (v) => { ui.q.res = v.q; render(); },
    avail: (v) => { ui.q.availFrom = v.from; render(); },
    rep: (v) => { ui.q.repDate = v.date; render(); },
    possales: (v) => { ui.q.posDate = v.date; render(); },
    'open-shift': async (v) => { await POST('/pos/shift/open', { outlet_id: Number(v.outlet_id), opening_float: Number(v.opening_float) }); ui.posOutlet = Number(v.outlet_id); toast('Shift opened.'); render(); },
    settings: async (v) => { await PUT('/settings', { property_name: v.property_name, vat_rate: Number(v.vat_rate) }); toast('Settings saved.'); refresh(); },
  };

  Object.assign(A, OPS_A); Object.assign(FORMS, OPS_FORMS);

  function showSecret(code, secret) {
    modal('Channel secret', `<p>Give this secret to the channel provider. It signs every message in both directions. <b>It is shown only once.</b></p>
      <p><code class="mono">${esc(secret)}</code></p><p>Bookings address for the provider:<br><code class="mono">${esc(location.origin)}/api/channels/${esc(code)}/inbound</code></p><div class="actions"><button class="btn btn-gold" data-action="close-modal">Done</button></div>`);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const fn = A[el.dataset.action]; if (!fn) return;
    e.preventDefault();
    try { await fn(el.dataset, e); } catch (err) { if (err.message !== 'Signed out') toast(esc(err.message), true); }
  });
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]'); if (!form) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
    try {
      if (FORMS[form.dataset.form]) await FORMS[form.dataset.form](v, form, e.submitter);
      else if (modalSubmit) { const msg = await modalSubmit(v); closeModal(); if (msg) toast(msg); await refresh(); }
    } catch (err) { if (err.message !== 'Signed out') formErr(form, err.message); } finally { if (btn && document.contains(btn)) btn.disabled = false; }
  });
  document.addEventListener('change', async (e) => {
    if (e.target.dataset.action !== 'outlet-store') return;
    try { await PUT(`/inventory/outlets/${e.target.dataset.id}/store`, { store_id: e.target.value ? Number(e.target.value) : null }); toast('Outlet updated.'); INVS = null; } catch (err) { toast(esc(err.message), true); }
  });
  document.addEventListener('change', async (e) => {
    if (e.target.dataset.action !== 'rec-tick') return;
    try { await PUT(`/finance/reconciliations/${e.target.dataset.rec}/lines`, { line_ids: [Number(e.target.dataset.line)], cleared: e.target.checked }); render(); } catch (err) { toast(esc(err.message), true); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'dept-filter') return;
    ui.q[e.target.dataset.key] = e.target.value; render();
  });
  document.addEventListener('input', (e) => { if (e.target.dataset.calc === 'tender' || e.target.closest('form[data-form=pay-check]')) updatePayCalc(); });
  document.addEventListener('change', (e) => { if (e.target.closest('form[data-form=pay-check]')) updatePayCalc(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  window.addEventListener('hashchange', () => { closeModal(); render().then(() => $('#view')?.focus({ preventScroll: true })); window.scrollTo(0, 0); });

  async function boot() {
    try {
      const me = await GET('/auth/me'); ME = me.user; SETTINGS = me.settings;
      CAN = (await GET('/meta')).can;
      shell(); await render();
    } catch (e) { if (e.message !== 'Signed out') renderLogin(); }
  }
  // initial load: show login if not signed in
  fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => (r.ok ? boot() : renderLogin()));
})();
