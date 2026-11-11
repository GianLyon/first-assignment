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
  const ROLE = { admin: 'Administrator', manager: 'Manager', front_office: 'Front office', housekeeping: 'Housekeeping', accountant: 'Accountant', night_auditor: 'Night auditor', waiter: 'Waiter / cashier', kitchen: 'Kitchen / bar', storekeeper: 'Storekeeper' };
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
    ['Food & beverage', [['pos', 'Point of sale', 'pos.use'], ['kitchen', 'Kitchen & bar screen', 'pos.kitchen'], ['menu', 'Menu & tables', 'pos.manage'], ['possales', 'F&B sales', 'reports.view']]],
    ['Stores & purchasing', [['stock', 'Stock', 'inventory.view'], ['requisitions', 'Requisitions', 'requisition.create'], ['purchasing', 'Purchasing', 'inventory.receive'], ['counts', 'Stock counts', 'stock.count'], ['stockitems', 'Items & recipes', 'inventory.manage'], ['invreports', 'Inventory reports', 'inventory.view']]],
    ['Finance', [['reports', 'Reports', 'reports.view'], ['accounts', 'Accounts', 'accounts.view']]],
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
    $('#side-nav').innerHTML = NAV.map(([g, items]) => { const vis = items.filter(([, , p]) => CAN[p]); return vis.length ? `<div class="grp">${g}</div>` + vis.map(([id, l]) => `<a href="#${id}" class="${r === id || (r === 'res' && id === 'reservations') ? 'on' : ''}">${l}</a>`).join('') : ''; }).join('');
    $('#prop-name').textContent = SETTINGS.property_name;
    $('#biz-date').textContent = 'Business date: ' + fdateLong(SETTINGS.business_date);
  }
  async function refreshSettings() { const me = await GET('/auth/me'); SETTINGS = me.settings; }

  const VIEWS = {};
  let renderSeq = 0;
  async function render() {
    if (!ME) return;
    const { r, id } = route();
    const need = VIEW_PERM[r] || { res: 'reservations.view', check: 'pos.use', count: 'stock.count' }[r] || null;
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
        <dl class="kv"><dt>Room</dt><dd>${esc(r.room_number || 'Not assigned')} · ${esc(r.room_type_name)}</dd><dt>Stay</dt><dd>${fdate(r.arrival)} → ${fdate(r.departure)} (${nights(r.arrival, r.departure)} nights)</dd><dt>Rate</dt><dd>${ugx(r.rate)} / night</dd><dt>Guests</dt><dd>${r.adults} adult(s)${r.children ? `, ${r.children} child(ren)` : ''}</dd><dt>Source</dt><dd>${esc(r.source)}</dd></dl></div>
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
      <div class="card mt"><h2 class="sec">What each role can do</h2>${table(['Role', 'Access'], [['Administrator', 'Everything, including users'], ['Manager', 'All operations, voids, night audit, accounts, settings'], ['Front office', 'Reservations, check-in/out, charges and payments'], ['Night auditor', 'Front office plus the night audit and accounts'], ['Housekeeping', 'Room status only'], ['Accountant', 'Accounts, reports, voids and the audit log'], ['Waiter / cashier', 'Point of sale only: bills, sending orders, payments, own shift'], ['Kitchen / bar', 'Kitchen and bar ticket screen, stock levels, requisitions'], ['Storekeeper', 'Stock, deliveries, purchase orders (not approval), issuing requisitions, stock counts']].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`))}</div>`;
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
  function paymentForm(id, bal, company) {
    modal('Take payment', `<form class="form" data-form="pay">
      <div class="two"><label>Amount (UGX)<input name="amount" type="number" min="1" step="1" value="${Math.max(0, bal)}" required></label><label>Method<select name="method">${opts(Object.entries(METHOD), 'cash')}</select></label></div>
      <div class="two"><label>Reference (receipt / transaction no.)<input name="reference" maxlength="80"></label><label>Company (for company account)<input name="company_name" value="${esc(company || '')}" maxlength="120"></label></div>
      <p class="note">“Company account” moves the balance to the company's account to invoice later.</p>
      <div class="actions">${cancelBtn}<button class="btn btn-gold">Record payment</button></div></form>`,
      async (v) => { await POST(`/reservations/${id}/payments`, { amount: Number(v.amount), method: v.method, reference: v.reference, company_name: v.company_name }); return `${ugx(v.amount)} recorded.`; });
  }

  const A = {

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
