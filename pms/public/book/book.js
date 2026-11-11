// Public website booking engine (no sign-in). Talks to /api/public.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ugx = (n) => 'UGX ' + Math.round(n).toLocaleString('en-US');
  const fdate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  async function api(method, path, body) {
    const res = await fetch('/api/public' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }
  let INFO = null, QUOTE = null, CHOICE = null;

  async function init() {
    INFO = await api('GET', '/info');
    document.title = `Book your stay · ${INFO.property_name}`;
    $('#hotel-name').textContent = INFO.property_name;
    $('#intro').textContent = INFO.intro;
    $('#policy').textContent = INFO.cancellation_policy;
    $('#foot').textContent = `Check-in from ${INFO.check_in_time} · check-out by ${INFO.check_out_time}` + (INFO.contact_phone ? ` · ${INFO.contact_phone}` : '') + (INFO.contact_email ? ` · ${INFO.contact_email}` : '');
    const f = $('#search');
    f.arrival.min = INFO.today; f.departure.min = addDays(INFO.today, 1);
    f.arrival.max = addDays(INFO.today, INFO.horizon_days);
    f.arrival.value = INFO.today; f.departure.value = addDays(INFO.today, 2);
    if (!INFO.booking_enabled) { $('#results').innerHTML = '<div class="card"><p>Online booking is not available right now. Please contact the hotel.</p></div>'; f.querySelector('button').disabled = true; }
  }

  function renderResults() {
    const q = QUOTE;
    const types = q.room_types.filter((t) => t.plans.length);
    $('#results').innerHTML = `<h2>${q.nights} night${q.nights > 1 ? 's' : ''} · ${fdate(q.arrival)} to ${fdate(q.departure)}</h2>` + (types.map((t) => `
      <article class="card room"><div class="thumb" aria-hidden="true"></div><div>
        <h3>${esc(t.room_type.name)}</h3><p class="muted">Up to ${t.room_type.max_occupancy} guests${t.available > 0 && t.available <= 3 ? ` · <b>only ${t.available} left</b>` : ''}</p>
        ${t.plans.map((p) => `<div class="plan"><div><b>${esc(p.name)}</b><span class="muted">${esc(p.description || '')}</span><br>
            ${p.breakfast ? '<span class="tag">Breakfast included</span>' : ''}${p.refundable ? '<span class="tag">Free cancellation</span>' : '<span class="tag no">Non-refundable</span>'}</div>
          <div class="price">${p.bookable ? `<strong>${ugx(p.total)}</strong><small>${ugx(p.total / q.nights)} per night</small><button class="btn btn-gold" data-type="${t.room_type.id}" data-plan="${p.id}">Book</button>` : `<small>${esc(p.reason)}</small>`}</div></div>`).join('')}
      </div></article>`).join('') || '<div class="card"><p class="empty">No rooms available for these dates.</p></div>');
  }

  $('#search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    btn.disabled = true; $('#details').hidden = true; $('#confirm').hidden = true;
    try {
      QUOTE = await api('GET', `/availability?arrival=${encodeURIComponent(f.arrival.value)}&departure=${encodeURIComponent(f.departure.value)}&adults=${encodeURIComponent(f.adults.value)}`);
      renderResults();
    } catch (err) { $('#results').innerHTML = `<div class="card"><p class="err">${esc(err.message)}</p></div>`; }
    finally { btn.disabled = false; }
  });
  $('#search').arrival.addEventListener('change', (e) => { const f = $('#search'); f.departure.min = addDays(e.target.value, 1); if (f.departure.value <= e.target.value) f.departure.value = addDays(e.target.value, 1); });

  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-plan]'); if (!b) return;
    const t = QUOTE.room_types.find((x) => x.room_type.id === Number(b.dataset.type)); const p = t.plans.find((x) => x.id === Number(b.dataset.plan));
    CHOICE = { t, p };
    $('#summary').innerHTML = `<b>${esc(t.room_type.name)}</b> · ${esc(p.name)}<br>${fdate(QUOTE.arrival)} to ${fdate(QUOTE.departure)} · ${QUOTE.nights} night(s) · ${QUOTE.adults} guest(s)<br><b>Total ${ugx(p.total)}</b> <span class="muted">(taxes included)</span>`;
    $('#book-err').textContent = ''; $('#results').hidden = true; $('#details').hidden = false; $('#details').scrollIntoView({ behavior: 'smooth' });
    $('#guest-form').first_name.focus();
  });
  $('#back').addEventListener('click', () => { $('#details').hidden = true; $('#results').hidden = false; });

  $('#guest-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]'); btn.disabled = true; $('#book-err').textContent = '';
    try {
      const r = await api('POST', '/bookings', { arrival: QUOTE.arrival, departure: QUOTE.departure, adults: QUOTE.adults, room_type_id: CHOICE.t.room_type.id, rate_plan_id: CHOICE.p.id,
        guest: { first_name: f.first_name.value, last_name: f.last_name.value, email: f.email.value, phone: f.phone.value }, notes: f.notes.value, website: f.website.value });
      $('#details').hidden = true;
      $('#confirm').hidden = false;
      $('#confirm').innerHTML = `<h2>You're booked!</h2><p>Your booking code</p><p class="code">${esc(r.code)}</p>
        <div class="summary"><b>${esc(r.room_type)}</b> · ${esc(r.rate_plan)}<br>${fdate(r.arrival)} to ${fdate(r.departure)} · ${r.nights} night(s)<br>Total <b>${ugx(r.total)}</b>, payable at the hotel</div>
        <p class="note">Keep your code and the email you used (${esc(r.email)}) to view or ${r.refundable ? 'cancel' : 'check'} your booking below.</p>
        ${INFO.online_payments ? `<button class="btn btn-gold pay-now" data-code="${esc(r.code)}" data-email="${esc(r.email)}">${r.refundable ? 'Pay the first night now (optional)' : 'Pay now'}</button>` : ''}`;
      $('#confirm').scrollIntoView({ behavior: 'smooth' });
      f.reset();
    } catch (err) { $('#book-err').textContent = err.message; } finally { btn.disabled = false; }
  });

  $('#lookup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, out = $('#lookup-result');
    try {
      const b = await api('POST', '/bookings/lookup', { code: f.code.value, email: f.email.value });
      const status = { reserved: 'Confirmed', in_house: 'Checked in', checked_out: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' }[b.status] || b.status;
      out.innerHTML = `<div class="summary mt"><b>${esc(b.code)} · ${status}</b><br>${esc(b.first_name)} ${esc(b.last_name)}<br>${esc(b.room_type)}${b.rate_plan ? ' · ' + esc(b.rate_plan) : ''}<br>${fdate(b.arrival)} to ${fdate(b.departure)} · ${b.nights} night(s) · ${ugx(b.total)}</div>
        ${b.can_cancel ? '<button class="btn btn-ghost" id="cancel-booking">Cancel this booking</button>' : b.status === 'reserved' ? '<p class="note">To change or cancel this booking, please contact the hotel.</p>' : ''}
        ${INFO.online_payments && b.status === 'reserved' ? `<button class="btn btn-gold pay-now" data-code="${esc(b.code)}" data-email="${esc(f.email.value)}">Pay online</button>` : ''}`;
      const c = $('#cancel-booking');
      if (c) c.addEventListener('click', async () => {
        if (!confirm('Cancel this booking?')) return;
        try { await api('POST', '/bookings/cancel', { code: f.code.value, email: f.email.value }); out.innerHTML = '<p>Your booking has been cancelled.</p>'; } catch (err) { out.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
      });
    } catch (err) { out.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });

  // online payment: start a checkout with the hotel's payment provider
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.pay-now'); if (!b) return;
    b.disabled = true;
    try { const r = await api('POST', '/bookings/pay', { code: b.dataset.code, email: b.dataset.email }); location.href = r.checkout_url; }
    catch (err) { b.insertAdjacentHTML('afterend', `<p class="err">${esc(err.message)}</p>`); b.disabled = false; }
  });

  init().catch((err) => { $('#results').innerHTML = `<div class="card"><p class="err">${esc(err.message)}</p></div>`; });
})();
