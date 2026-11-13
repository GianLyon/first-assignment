// Azeli Console: the Azeli Technologies admin panel.
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const fdate = (d) => (d ? new Date(String(d).length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: String(d).length === 10 ? 'UTC' : undefined }) : '');
  const ftime = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const pct = (v) => `${Math.round((Number(v) || 0) * 1000) / 10}%`;
  const LEAD = { new: ['New', 'info'], contacted: ['Contacted', 'warn'], proposal: ['Proposal sent', 'warn'], won: ['Won', 'ok'], lost: ['Lost', ''] };
  const CLIENT = { setup: ['Setting up', 'info'], active: ['Active', 'ok'], paused: ['Paused', 'warn'], ended: ['Ended', ''] };
  const PACKAGES = ['Essentials', 'Growth', 'Signature', 'PMS only', 'Other'];

  let ME = null, CAN = {}, META = {};
  const ui = { tab: {}, q: {} };

  async function api(method, path, body) {
    const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !['/auth/login', '/auth/mfa'].includes(path)) { ME = null; login('Your session has ended. Please sign in again.'); throw new Error('Signed out'); }
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const GET = (p) => api('GET', p), POST = (p, b) => api('POST', p, b), PUT = (p, b) => api('PUT', p, b);

  const pill = (t, c = '') => `<span class="pill ${c}">${esc(t)}</span>`;
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const table = (head, rows, empty = 'Nothing yet.') => `<div class="tbl-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith('#') ? 'num' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="empty">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  const tabs = (key, list, def) => { const c = ui.tab[key] || def; return `<div class="tabs">${list.map(([v, l]) => `<button type="button" class="${v === c ? 'on' : ''}" data-action="tab" data-key="${key}" data-val="${v}">${esc(l)}</button>`).join('')}</div>`; };
  const cur = (k, d) => ui.tab[k] || d;
  function toast(t, bad) { const d = document.createElement('div'); d.className = 'toast' + (bad ? ' toast-bad' : ''); d.textContent = t; $('#toasts').append(d); setTimeout(() => d.remove(), 5000); }
  let modalSubmit = null;
  function modal(title, body, onSubmit) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = body; modalSubmit = onSubmit; $('#modal').hidden = false; $('#modal-body input, #modal-body select, #modal-body textarea')?.focus(); }
  const closeModal = () => { $('#modal').hidden = true; modalSubmit = null; };
  const cancelBtn = '<button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>';
  const formErr = (form, msg) => { let n = form.querySelector('.form-err'); if (!n) { n = document.createElement('p'); n.className = 'note err form-err'; form.prepend(n); } n.textContent = msg; };

  function login(msg = '') {
    closeModal();
    $('#root').innerHTML = `<div class="login-wrap"><form class="login form" data-form="login">
      <div class="brand login-brand"><img class="mark" src="/brand/azeli-mark.svg" alt="" width="48" height="48"><span>Azeli<small>Console</small></span></div>
      <h1>Sign in</h1>${msg ? `<p class="note err">${esc(msg)}</p>` : ''}
      <label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-gold">Sign in</button></form></div>`;
  }

  const brand = '<div class="brand login-brand"><img class="mark" src="/brand/azeli-mark.svg" alt="" width="48" height="48"><span>Azeli<small>Console</small></span></div>';
  function mfaStep(challenge, msg = '') {
    $('#root').innerHTML = `<div class="login-wrap"><form class="login form" data-form="login-mfa" data-challenge="${esc(challenge)}">${brand}
      <h1>Two-step sign-in</h1><p class="muted">Enter the 6-digit code from your authenticator app, or a recovery code.</p>${msg ? `<p class="note err">${esc(msg)}</p>` : ''}
      <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus maxlength="12" class="code-input"></label>
      <button class="btn btn-gold">Continue</button><button type="button" class="btn btn-ghost" data-action="relogin">Back</button></form></div>`;
  }
  async function setupHtml(forced) {
    const st = await POST('/auth/mfa/setup');
    return `${forced ? '<p class="note">Two-step sign-in is required for your role. Set it up to continue.</p>' : ''}
      <ol class="steps-list"><li>Install <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> or <b>Authy</b> on your phone.</li><li>Add an account and scan:</li></ol>
      <div class="qr">${st.qr_svg}</div><p class="small muted center">Or enter this key: <code class="mono">${esc(st.secret)}</code></p>
      <form class="form" data-form="mfa-enable"><label>3. The 6-digit code from the app<input name="code" inputmode="numeric" maxlength="6" required class="code-input"></label>
      <div class="actions">${forced ? '<button type="button" class="btn btn-ghost" data-action="logout">Sign out</button>' : cancelBtn}<button class="btn btn-gold">Turn on</button></div></form>`;
  }
  function showCodes(codes) {
    const html = `<p><b>Keep these recovery codes safe.</b> Each signs you in once if you lose your phone. They are shown only now.</p><div class="recovery">${codes.map((c) => `<code class="mono">${esc(c)}</code>`).join('')}</div>
      <div class="actions"><button type="button" class="btn btn-gold" data-action="mfa-done">I have saved them</button></div>`;
    if ($('#modal').hidden) modal('Recovery codes', html); else { $('#modal-title').textContent = 'Recovery codes'; $('#modal-body').innerHTML = html; }
  }
  const NAV = [['dashboard', 'Overview', null], ['leads', 'Enquiries', 'leads.view'], ['content', 'Website', 'content.edit'], ['clients', 'Client hotels', 'clients.view'], ['team', 'Team', 'team.manage'], ['activity', 'Activity log', 'team.manage']];
  const route = () => { const [r, id] = (location.hash.slice(1) || 'dashboard').split('/'); return { r, id }; };
  function shell() {
    $('#root').innerHTML = `<div class="app"><aside class="side"><div class="brand"><img class="mark" src="/brand/azeli-mark-light.svg" alt="" width="32" height="32"><span>Azeli <em>Console</em></span></div><nav id="side-nav"></nav></aside>
      <div class="main"><header class="topbar"><button class="menu-btn" type="button" data-action="toggle-nav" aria-label="Show menu">☰</button><div class="prop"><b>Azeli Technologies</b><span>Admin panel</span></div>
      <div class="top-actions user-menu"><span class="user">${esc(ME.full_name)} · ${esc(META.roles[ME.role])}</span><button class="btn btn-ghost btn-sm" data-action="mfa">Two-step</button><button class="btn btn-ghost btn-sm" data-action="password">Password</button><button class="btn btn-ghost btn-sm" data-action="logout">Sign out</button></div></header>
      <main id="view" tabindex="-1"></main></div></div>`;
  }
  const VIEWS = {};
  let seq = 0;
  async function render() {
    if (!ME) return;
    const { r, id } = route();
    const perm = Object.fromEntries(NAV.map(([k, , p]) => [k, p]))[r] ?? { lead: 'leads.view', client: 'clients.view' }[r];
    const view = VIEWS[r] && (!perm || CAN[perm]) ? r : 'dashboard';
    if (view !== r) history.replaceState(null, '', '#' + view);
    $('#side-nav').innerHTML = NAV.filter(([, , p]) => !p || CAN[p]).map(([k, l]) => `<a href="#${k}" class="${k === view || (view === 'lead' && k === 'leads') || (view === 'client' && k === 'clients') ? 'on' : ''}">${l}</a>`).join('');
    document.body.classList.remove('nav-open');
    const s = ++seq;
    try { const html = await VIEWS[view](id); if (s === seq) $('#view').innerHTML = html; } catch (e) { if (e.message !== 'Signed out' && s === seq) $('#view').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  }

  /* ---------- overview ---------- */
  VIEWS.dashboard = async () => {
    const d = await GET('/dashboard');
    return `<div class="page-head"><div><h1 class="page">Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${esc(ME.full_name.split(' ')[0])}</h1><p class="sub">Everything at Azeli Technologies at a glance.</p></div></div>
      <div class="grid g4">
        ${d.leads ? `<a class="card kpi" href="#leads"><span>New enquiries</span><b>${d.leads.new}</b><small>${d.leads.last30} in the last 30 days</small></a><div class="card kpi"><span>In progress</span><b>${d.leads.open}</b><small>${d.leads.due ? `${d.leads.due} follow-up${d.leads.due === 1 ? '' : 's'} due` : 'no follow-ups due'}</small></div>` : ''}
        ${d.clients ? `<a class="card kpi" href="#clients"><span>Client hotels</span><b>${d.clients.clients}</b><small>${d.clients.offline ? `${d.clients.offline} offline` : 'all online'}</small></a><div class="card kpi"><span>Monthly fees</span><b>${num(d.clients.mrr)}</b><small>UGX from active clients</small></div>` : ''}
        ${CAN['content.edit'] ? `<a class="card kpi" href="#content"><span>Website</span><b>${d.unpublished ? d.unpublished : '✓'}</b><small>${d.unpublished ? 'section(s) waiting to be published' : 'everything is published'}</small></a>` : ''}
      </div>
      ${d.recent.length ? `<div class="card mt"><h2 class="sec">Latest enquiries</h2>${table(['Received', 'From', 'Status'], d.recent.map((l) => `<tr><td>${ftime(l.created_at)}</td><td><a href="#lead/${l.id}">${esc(l.business)}</a><br><span class="small muted">${esc(l.name)} · ${esc(l.ref)}</span></td><td>${pill(...LEAD[l.status])}</td></tr>`))}</div>` : ''}`;
  };

  /* ---------- enquiries ---------- */
  VIEWS.leads = async () => {
    const st = cur('ls', '');
    const rows = await GET(`/leads?status=${st}&q=${encodeURIComponent(ui.q.lq || '')}`);
    return `<div class="page-head"><div><h1 class="page">Enquiries</h1><p class="sub">Every contact and free-audit request from azelitech.com. New ones first.</p></div></div>
      ${tabs('ls', [['', 'All'], ...Object.entries(LEAD).map(([k, [l]]) => [k, l])], '')}
      <div class="card"><form class="form row" data-form="lead-search"><label>Search<input name="q" value="${esc(ui.q.lq || '')}" placeholder="Name, business or email"></label><button class="btn btn-ghost">Search</button></form></div>
      <div class="card mt">${table(['Received', 'Business', 'Interested in', 'Follow up', 'Status'], rows.map((l) => `<tr><td class="nowrap">${ftime(l.created_at)}</td>
        <td><a href="#lead/${l.id}">${esc(l.business)}</a><br><span class="small muted">${esc(l.name)}${l.business_type ? ' · ' + esc(l.business_type) : ''}</span></td>
        <td class="small">${esc([l.package && `${l.package} package`, ...l.services].filter(Boolean).join(', ') || '—')}</td>
        <td class="nowrap ${l.next_action_date && l.next_action_date <= new Date().toISOString().slice(0, 10) && !['won', 'lost'].includes(l.status) ? 'err' : ''}">${fdate(l.next_action_date)}</td><td>${pill(...LEAD[l.status])}${l.assigned_name ? `<br><span class="small muted">${esc(l.assigned_name)}</span>` : ''}</td></tr>`), 'No enquiries yet. They appear here as soon as someone sends the contact form on the website.')}</div>`;
  };
  VIEWS.lead = async (id) => {
    const { lead: l, notes, team } = await GET(`/leads/${id}`);
    const m = CAN['leads.manage'];
    const wa = l.phone ? l.phone.replace(/\D/g, '') : '';
    return `<div class="page-head"><div><p class="sub"><a href="#leads">← Enquiries</a></p><h1 class="page">${esc(l.business)}</h1><p class="sub">${esc(l.ref)} · received ${ftime(l.created_at)} ${pill(...LEAD[l.status])}</p></div>
      <div class="row"><a class="btn btn-gold" href="mailto:${esc(l.email)}?subject=${encodeURIComponent(`Your enquiry to Azeli Technologies (${l.ref})`)}">Reply by email</a>${wa ? `<a class="btn btn-ghost" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${CAN['clients.manage'] && l.status === 'won' ? `<button class="btn" data-action="client-edit" data-lead="${l.id}" data-name="${esc(l.business)}" data-contact="${esc(l.name)}" data-email="${esc(l.email)}" data-phone="${esc(l.phone || '')}" data-package="${esc(l.package || '')}">Add as client hotel</button>` : ''}</div></div>
      <div class="grid g2"><div class="card"><h2 class="sec">Details</h2><dl class="kv"><dt>Name</dt><dd>${esc(l.name)}</dd><dt>Email</dt><dd>${esc(l.email)}</dd><dt>Phone</dt><dd>${esc(l.phone || '–')}</dd><dt>Business</dt><dd>${esc(l.business)}${l.business_type ? ` (${esc(l.business_type)})` : ''}</dd>
        <dt>Package</dt><dd>${esc(l.package || '–')}</dd><dt>Interested in</dt><dd>${esc(l.services.join(', ') || '–')}</dd><dt>Sent from</dt><dd>${esc(l.page || '–')}</dd></dl>${l.message ? `<p class="mail-text">${esc(l.message)}</p>` : ''}</div>
      <div class="card"><h2 class="sec">Follow-up</h2>${m ? `<form class="form" data-form="lead" data-id="${l.id}"><div class="two"><label>Status<select name="status">${opts(Object.entries(LEAD).map(([k, [t]]) => [k, t]), l.status)}</select></label>
          <label>Handled by<select name="assigned_to"><option value="">Nobody yet</option>${opts(team.map((u) => [u.id, u.full_name]), l.assigned_to)}</select></label></div>
          <div class="two"><label>Next follow-up<input type="date" name="next_action_date" value="${esc(l.next_action_date || '')}"></label><label>Expected monthly fee (UGX)<input type="number" min="0" name="value_ugx" value="${l.value_ugx ?? ''}"></label></div>
          <div class="actions"><button class="btn btn-gold">Save</button></div></form>
          <form class="form mt" data-form="lead-note" data-id="${l.id}"><label>Add a note<textarea name="note" rows="2" required placeholder="What was discussed, what happens next"></textarea></label><div class="actions"><button class="btn">Add note</button></div></form>` : `<p>${pill(...LEAD[l.status])}</p>`}
        ${table(['When', 'Note'], notes.map((n) => `<tr><td class="nowrap small">${ftime(n.created_at)}<br><span class="muted">${esc(n.full_name || '')}</span></td><td>${esc(n.note)}</td></tr>`), 'No notes yet.')}</div></div>`;
  };

  /* ---------- website ---------- */
  const lines = (a) => (a || []).join('\n');
  const SECTION_FORM = {
    contact: (v) => `<div class="two"><label>Email shown on the website<input name="email" type="email" value="${esc(v.email)}" required></label><label>Phone (international, for the call link)<input name="phone" value="${esc(v.phone)}" required placeholder="+256700123456"></label></div>
      <div class="two"><label>Phone as shown to visitors<input name="phone_display" value="${esc(v.phone_display)}" required placeholder="+256 700 123 456"></label><label>WhatsApp number (with country code)<input name="whatsapp" value="${esc(v.whatsapp)}" required placeholder="256700123456"></label></div>
      <p class="small muted">Used on every page: header, footers, contact page and the details Google reads.</p>`,
    announcement: (v) => `<label class="row"><input type="checkbox" name="active" value="1" ${v.active ? 'checked' : ''}> Show a banner at the top of every page</label>
      <label>Message<input name="text" value="${esc(v.text)}" maxlength="160" placeholder="e.g. Free PMS demos all December"></label><div class="two"><label>Button text<input name="link_text" value="${esc(v.link_text)}" maxlength="40" placeholder="Book a demo"></label><label>Button goes to<input name="link_url" value="${esc(v.link_url)}" placeholder="contact.html or https://…"></label></div>`,
    hero: (v) => `<label>Small heading<input name="eyebrow" value="${esc(v.eyebrow)}" required maxlength="60"></label><div class="two"><label>Headline<input name="title" value="${esc(v.title)}" required maxlength="80"></label><label>Headline, gold part<input name="title_accent" value="${esc(v.title_accent)}" maxlength="80"></label></div>
      <label>Introduction<textarea name="lead" rows="3" maxlength="400" required>${esc(v.lead)}</textarea></label>`,
    packages: (v) => v.items.map((p, i) => `<fieldset class="card pkg-edit"><legend>Package ${i + 1}</legend><div class="three"><label>Name<input name="p${i}_name" value="${esc(p.name)}" required maxlength="30"></label><label>Tagline<input name="p${i}_tagline" value="${esc(p.tagline)}" maxlength="60"></label><label>Price (optional)<input name="p${i}_price" value="${esc(p.price)}" maxlength="60" placeholder="From UGX 1,500,000 / month"></label></div>
      <div class="two"><label class="row"><input type="checkbox" name="p${i}_featured" value="1" ${p.featured ? 'checked' : ''}> Highlight this package</label><label>Badge<input name="p${i}_badge" value="${esc(p.badge)}" maxlength="20" placeholder="Most popular"></label></div>
      <label>Features (one per line; **two stars** around words make them bold)<textarea name="p${i}_features" rows="7">${esc(lines(p.features))}</textarea></label></fieldset>`).join('')
      + `<div class="row"><button type="button" class="btn btn-ghost btn-sm" data-action="pkg-count" data-n="${v.items.length + 1}" ${v.items.length >= 4 ? 'disabled' : ''}>+ Add a package</button>${v.items.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-action="pkg-count" data-n="${v.items.length - 1}">Remove the last package</button>` : ''}</div>`,
    case_study: (v) => `<p class="small muted">The results and quote on the Amaya Hotel &amp; Luxury Suites case study.</p>${v.results.map((r, i) => `<div class="two"><label>Result ${i + 1}<input name="r${i}_value" value="${esc(r.value)}" maxlength="12" required placeholder="+35%"></label><label>What it measures<input name="r${i}_label" value="${esc(r.label)}" maxlength="40" required></label></div>`).join('')}
      <label>Quote<textarea name="quote" rows="3" maxlength="400" required>${esc(v.quote)}</textarea></label><label>Quote by<input name="cite" value="${esc(v.cite)}" maxlength="120" required></label>`,
    seo: (v) => `<label>Page title in Google (up to 70 characters)<input name="home_title" value="${esc(v.home_title)}" maxlength="70" required></label><label>Description in Google (up to 170 characters)<textarea name="home_description" rows="3" maxlength="170" required>${esc(v.home_description)}</textarea></label>
      <div class="serp"><span class="serp-url">azelitech.com</span><b>${esc(v.home_title)}</b><span>${esc(v.home_description)}</span></div>`,
  };
  function readSection(section, v, prev) {
    if (section === 'announcement') return { ...v, active: !!v.active };
    if (section === 'packages') return { items: prev.items.map((_, i) => ({ name: v[`p${i}_name`], tagline: v[`p${i}_tagline`], price: v[`p${i}_price`], featured: !!v[`p${i}_featured`], badge: v[`p${i}_badge`], features: String(v[`p${i}_features`] || '').split('\n').map((s) => s.trim()).filter(Boolean) })) };
    if (section === 'case_study') return { results: [0, 1, 2, 3].map((i) => ({ value: v[`r${i}_value`], label: v[`r${i}_label`] })), quote: v.quote, cite: v.cite };
    return v;
  }
  VIEWS.content = async () => {
    const d = await GET('/content'); ui.content = d;
    const section = cur('cs', 'contact'), s = d.sections[section];
    const value = ui.pkgDraft && section === 'packages' ? ui.pkgDraft : s.draft;
    const waiting = Object.entries(d.sections).filter(([, x]) => x.changed).map(([k]) => META.sections[k]);
    const last = d.publishes[0];
    return `<div class="page-head"><div><h1 class="page">Website</h1><p class="sub">Edit azelitech.com. Saving keeps a draft; <b>Publish</b> puts every saved change live in about a minute.</p></div>
      ${CAN['content.publish'] ? `<button class="btn btn-gold" data-action="publish" ${waiting.length ? '' : 'disabled'}>Publish${waiting.length ? ` ${waiting.length} change${waiting.length === 1 ? '' : 's'}` : 'ed'}</button>` : ''}</div>
      ${waiting.length ? `<p class="note">Saved but not live yet: ${waiting.map(esc).join(', ')}.</p>` : ''}${!META.deploy_hook ? '<p class="note err">Publishing saves the content, but the website will not rebuild until the Vercel deploy hook is set (VERCEL_DEPLOY_HOOK). See the go-live guide.</p>' : ''}
      ${tabs('cs', Object.entries(META.sections).map(([k, l]) => [k, d.sections[k].changed ? `${l} •` : l]), 'contact')}
      <div class="card"><form class="form" data-form="section" data-section="${section}">${SECTION_FORM[section](value)}
        <div class="actions"><span class="small muted">${s.updated_at ? `Saved ${ftime(s.updated_at)}${s.updated_by ? ' by ' + esc(s.updated_by) : ''}` : 'Not changed yet'}${s.published_at ? ` · live since ${ftime(s.published_at)}` : ''}</span><button class="btn btn-gold">Save draft</button></div></form></div>
      ${last ? `<p class="small muted mt">Last published ${ftime(last.created_at)} by ${esc(last.full_name || '')}: ${last.deploy === 'triggered' ? 'website rebuild started' : last.deploy === 'no_hook' ? 'saved (no deploy hook set)' : esc(last.deploy)}.</p>` : ''}`;
  };

  /* ---------- client hotels ---------- */
  VIEWS.clients = async () => {
    const rows = await GET('/clients'); ui.clients = rows;
    const m = CAN['clients.manage'];
    return `<div class="page-head"><div><h1 class="page">Client hotels</h1><p class="sub">Every hotel running Azeli PMS: online status every 10 minutes, and this month's figures when the hotel's group access key is added.</p></div>
      <div class="row"><button class="btn btn-ghost" data-action="check-all">Check all now</button>${m ? '<button class="btn btn-gold" data-action="client-edit">+ Add a hotel</button>' : ''}</div></div>
      <div class="card">${table(['Hotel', 'System', '#Occupancy (month)', '#Revenue (month, UGX)', '#Fee (UGX / month)', 'Status', ''], rows.map((c) => `<tr><td>${esc(c.name)}<br><span class="small muted">${esc(c.package || '')}${c.contact_name ? ` · ${esc(c.contact_name)}` : ''}</span></td>
        <td>${c.last_status === 'online' ? pill('Online', 'ok') : c.last_status ? `<span class="small err">${esc(c.last_status)}</span>` : pill('Not checked')}<br><a class="small" href="${esc(c.pms_url)}" target="_blank" rel="noopener">${esc(c.pms_url.replace('https://', ''))}</a>${c.last_check_at ? `<br><span class="small muted">checked ${ftime(c.last_check_at)}</span>` : ''}</td>
        <td class="num">${c.last_summary ? pct(c.last_summary.occupancy) : c.has_key ? '—' : '<span class="small muted">add key</span>'}</td><td class="num">${c.last_summary ? num(c.last_summary.revenue_total) : ''}</td><td class="num">${c.monthly_fee_ugx != null ? num(c.monthly_fee_ugx) : ''}</td>
        <td>${pill(...CLIENT[c.status])}</td><td class="right nowrap"><a class="btn btn-sm btn-gold" href="${esc(c.pms_url)}" target="_blank" rel="noopener">Open</a> <button class="btn btn-sm btn-ghost" data-action="client-check" data-id="${c.id}">Check</button>${m ? ` <button class="btn btn-sm btn-ghost" data-action="client-edit" data-id="${c.id}">Edit</button>` : ''}</td></tr>`), 'No client hotels yet. Add Amaya once its system is live.')}</div>`;
  };

  /* ---------- team & activity ---------- */
  VIEWS.team = async () => {
    const rows = await GET('/users'); ui.users = rows; META = { ...META, mfa: (await GET('/me')).mfa };
    return `<div class="page-head"><div><h1 class="page">Team</h1><p class="sub">Owner: everything · Website editor: website content and enquiries (read) · Sales: enquiries and client hotels (view).</p></div><button class="btn btn-gold" data-action="user-edit">+ Add a person</button></div>
      <div class="card">${table(['Name', 'Email', 'Role', 'Status', 'Two-step', ''], rows.map((u) => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(META.roles[u.role])}</td><td>${u.active ? pill('Active', 'ok') : pill('Switched off')}</td><td>${u.mfa_enabled ? pill('On', 'ok') : META.mfa.required_roles.includes(u.role) ? pill('Required', 'warn') : pill('Off')}</td><td class="right nowrap">${u.mfa_enabled ? `<button class="btn btn-sm btn-ghost" data-action="mfa-reset" data-id="${u.id}" data-name="${esc(u.full_name)}">Reset two-step</button> ` : ''}<button class="btn btn-sm btn-ghost" data-action="user-edit" data-id="${u.id}">Edit</button></td></tr>`))}</div>
      <div class="card mt"><h2 class="sec">Require two-step sign-in</h2><form class="form" data-form="security"><p class="small">These roles must use a code from an authenticator app as well as their password. Recommended for owners.</p>
        <div class="chips-row">${Object.entries(META.roles).map(([k, l]) => `<label class="row small"><input type="checkbox" name="r_${k}" value="1" ${META.mfa.required_roles.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div><div class="actions"><button class="btn btn-gold">Save</button></div></form></div>`;
  };
  VIEWS.activity = async () => {
    const rows = await GET('/audit');
    return `<div class="page-head"><div><h1 class="page">Activity log</h1><p class="sub">Who did what, latest first.</p></div></div>
      <div class="card">${table(['When', 'Who', 'What', 'Details'], rows.map((a) => `<tr><td class="nowrap">${ftime(a.created_at)}</td><td>${esc(a.full_name || 'Website')}</td><td>${esc(a.action)}</td><td class="small">${esc(Object.entries(a.details || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · '))}</td></tr>`))}</div>`;
  };

  /* ---------- actions ---------- */
  const A = {
    'close-modal': closeModal,
    relogin: () => login(),
    'mfa-done': async () => { closeModal(); toast('Two-step sign-in is ready.'); await boot(); },
    mfa: async () => {
      const m = await GET('/me');
      if (!m.mfa.enabled) { modal('Two-step sign-in', '<p>Loading…</p>'); $('#modal-body').innerHTML = await setupHtml(false); return; }
      modal('Two-step sign-in', `<p>${pill('On', 'ok')} ${m.mfa.recovery_codes_left} recovery codes left.</p>
        <form class="form" data-form="mfa-codes"><label>New recovery codes: current code from your app<input name="code" inputmode="numeric" maxlength="6" required class="code-input"></label><div class="actions"><button class="btn">Make new codes</button></div></form>
        ${m.mfa.required ? '<p class="small muted">Required for your role.</p>' : '<form class="form mt" data-form="mfa-off"><label>Turn off: your password<input type="password" name="password" required></label><div class="actions"><button class="btn btn-bad">Turn off</button></div></form>'}`);
    },
    'mfa-reset': async (d) => { if (!confirm(`Reset two-step sign-in for ${d.name}? They are signed out and set it up again with their new phone.`)) return; await POST(`/users/${d.id}/mfa-reset`); toast('Reset.'); render(); },
    'toggle-nav': () => document.body.classList.toggle('nav-open'),
    tab: (d) => { ui.tab[d.key] = d.val; ui.pkgDraft = null; render(); },
    logout: async () => { await POST('/auth/logout'); ME = null; login(); },
    password: () => modal('Change password', `<form class="form" data-form="m"><label>Current password<input type="password" name="current_password" required autocomplete="current-password"></label><label>New password (10+ characters)<input type="password" name="new_password" minlength="10" required autocomplete="new-password"></label><div class="actions">${cancelBtn}<button class="btn btn-gold">Change</button></div></form>`,
      async (v) => { await POST('/me/password', v); return 'Password changed. Other devices were signed out.'; }),
    publish: async () => {
      if (!confirm('Publish all saved changes to azelitech.com now?')) return;
      const r = await POST('/content/publish');
      toast(r.deploy === 'triggered' ? 'Published. The website updates in about a minute.' : r.deploy === 'no_hook' ? 'Saved as live content. Set the Vercel deploy hook so the website rebuilds.' : `Saved, but the rebuild did not start: ${r.deploy}`, r.deploy !== 'triggered'); render();
    },
    'pkg-count': (d) => {
      const f = $('form[data-form=section]'), cur = readSection('packages', Object.fromEntries(new FormData(f)), ui.pkgDraft || ui.content.sections.packages.draft);
      const n = Number(d.n); const items = cur.items.slice(0, n);
      while (items.length < n) items.push({ name: '', tagline: '', price: '', featured: false, badge: '', features: [] });
      ui.pkgDraft = { items }; render();
    },
    'check-all': async () => { const r = await POST('/clients/check-all'); toast(`${r.checked} hotel system(s) checked.`); render(); },
    'client-check': async (d) => { const r = await POST(`/clients/${d.id}/check`); toast(r.status === 'online' ? 'Online.' : r.status, r.status !== 'online'); render(); },
    'client-edit': (d) => {
      const c = d.id ? ui.clients.find((x) => x.id === Number(d.id)) : { name: d.name || '', contact_name: d.contact || '', contact_email: d.email || '', contact_phone: d.phone || '', package: d.package || '', status: 'setup' };
      modal(d.id ? `Edit ${c.name}` : 'Add a client hotel', `<form class="form" data-form="m"><div class="two"><label>Hotel name<input name="name" value="${esc(c.name)}" required></label><label>System address<input name="pms_url" value="${esc(c.pms_url || '')}" required placeholder="https://amaya.azelitech.com"></label></div>
        <label>Group access key ${d.id && c.has_key ? '(saved; leave empty to keep it)' : '(optional)'}<input name="group_token" autocomplete="off" placeholder="azg_…"></label><p class="small muted">Create it in the hotel's system under <b>Group dashboard → Create key</b>. It lets this console read the hotel's totals (occupancy, revenue), never guest details.</p>
        <div class="three"><label>Contact person<input name="contact_name" value="${esc(c.contact_name || '')}"></label><label>Email<input name="contact_email" type="email" value="${esc(c.contact_email || '')}"></label><label>Phone<input name="contact_phone" value="${esc(c.contact_phone || '')}"></label></div>
        <div class="three"><label>Package<select name="package"><option value="">—</option>${opts(PACKAGES.map((p) => [p, p]), c.package)}</select></label><label>Monthly fee (UGX)<input type="number" min="0" name="monthly_fee_ugx" value="${c.monthly_fee_ugx ?? ''}"></label><label>Status<select name="status">${opts(Object.entries(CLIENT).map(([k, [l]]) => [k, l]), c.status)}</select></label></div>
        <div class="two"><label>Client since<input type="date" name="started_on" value="${esc(c.started_on ? String(c.started_on).slice(0, 10) : '')}"></label><label>Notes<input name="notes" value="${esc(c.notes || '')}"></label></div>
        <div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { const body = { ...v, lead_id: d.lead ? Number(d.lead) : undefined }; if (d.id) await PUT(`/clients/${d.id}`, body); else { await POST('/clients', body); location.hash = '#clients'; } return 'Saved and checked.'; });
    },
    'user-edit': (d) => {
      const u = d.id ? ui.users.find((x) => x.id === Number(d.id)) : null;
      modal(u ? `Edit ${u.full_name}` : 'Add a person', `<form class="form" data-form="m"><div class="two"><label>Name<input name="full_name" value="${esc(u?.full_name || '')}" required></label><label>Email (they sign in with it)<input name="email" type="email" value="${esc(u?.email || '')}" ${u ? 'disabled' : 'required'}></label></div>
        <div class="two"><label>Role<select name="role">${opts(Object.entries(META.roles), u?.role || 'sales')}</select></label><label>${u ? 'New password (leave empty to keep)' : 'Password (10+ characters; they can change it)'}<input type="password" name="password" minlength="10" ${u ? '' : 'required'} autocomplete="new-password"></label></div>
        ${u ? `<label class="row"><input type="checkbox" name="active" value="1" ${u.active ? 'checked' : ''}> Can sign in</label>` : ''}<div class="actions">${cancelBtn}<button class="btn btn-gold">Save</button></div></form>`,
      async (v) => { if (u) await PUT(`/users/${u.id}`, { ...v, active: !!v.active }); else await POST('/users', v); return 'Saved.'; });
    },
  };
  const FORMS = {
    login: async (v) => { try { const r = await POST('/auth/login', v); if (r.mfa_required) { mfaStep(r.challenge); return; } ME = r.user; await boot(); } catch (e) { login(e.message); } },
    'login-mfa': async (v, f) => {
      try { const r = await POST('/auth/mfa', { challenge: f.dataset.challenge, code: v.code }); ME = r.user; if (r.recovery_codes_left !== undefined) toast(`Signed in with a recovery code: ${r.recovery_codes_left} left.`, r.recovery_codes_left < 3); await boot(); }
      catch (e) { if (/expired|password again/.test(e.message)) login(e.message); else mfaStep(f.dataset.challenge, e.message); }
    },
    'mfa-enable': async (v) => { const r = await POST('/auth/mfa/enable', { code: v.code }); showCodes(r.recovery_codes); },
    'mfa-off': async (v) => { await POST('/auth/mfa/disable', { password: v.password }); closeModal(); toast('Two-step sign-in is off.'); },
    'mfa-codes': async (v) => { const r = await POST('/auth/mfa/recovery-codes', { code: v.code }); showCodes(r.recovery_codes); },
    security: async (v) => { await PUT('/security', { mfa_required_roles: Object.keys(v).filter((k) => k.startsWith('r_')).map((k) => k.slice(2)) }); toast('Saved. These roles set up two-step sign-in at their next sign-in.'); render(); },
    'lead-search': (v) => { ui.q.lq = v.q; render(); },
    lead: async (v, f) => { await PUT(`/leads/${f.dataset.id}`, v); toast('Saved.'); render(); },
    'lead-note': async (v, f) => { await POST(`/leads/${f.dataset.id}/notes`, v); toast('Note added.'); render(); },
    section: async (v, f) => {
      const s = f.dataset.section;
      await PUT(`/content/${s}`, readSection(s, v, ui.pkgDraft || ui.content.sections[s].draft));
      ui.pkgDraft = null; toast('Draft saved. Press Publish to put it live.'); render();
    },
  };
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el || !A[el.dataset.action]) return;
    e.preventDefault();
    try { await A[el.dataset.action](el.dataset); } catch (err) { if (err.message !== 'Signed out') toast(err.message, true); }
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]'); if (!f) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f)), btn = f.querySelector('button:not([type=button])');
    if (btn) btn.disabled = true;
    try {
      if (FORMS[f.dataset.form]) await FORMS[f.dataset.form](v, f);
      else if (modalSubmit) { const msg = await modalSubmit(v); closeModal(); if (msg) toast(msg); await render(); }
    } catch (err) { if (err.message !== 'Signed out') formErr(f, err.message); } finally { if (btn && document.contains(btn)) btn.disabled = false; }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo(0, 0); });

  async function boot() {
    try {
      const m = await GET('/me'); ME = m.user; CAN = m.can; META = m;
      if (m.mfa?.setup_needed) { $('#root').innerHTML = `<div class="login-wrap"><div class="login form wide">${brand}<h1>Set up two-step sign-in</h1><div id="forced"></div></div></div>`; $('#forced').innerHTML = await setupHtml(true); return; }
      shell(); await render();
    } catch (e) { if (e.message !== 'Signed out') login(); }
  }
  fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? boot() : login()));
})();
