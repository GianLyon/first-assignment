// Test checkout used while the "simulator" payment provider is active.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = new URLSearchParams(location.search).get('t') || '';
  const call = async (method, path, body) => { const r = await fetch('/api/public' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Failed'); return d; };
  const done = (msg) => { $('#box').innerHTML = `<p>${msg}</p><p><a href="/book/">Back to the booking page</a></p>`; };
  call('GET', `/pay/${encodeURIComponent(token)}`).then((i) => {
    $('#title').textContent = `${i.property_name}: booking ${i.code}`;
    if (i.status !== 'pending') return done(`This payment is already ${esc(i.status)}.`);
    $('#box').innerHTML = `<p>Amount: <b>UGX ${Number(i.amount).toLocaleString('en-US')}</b></p>
      <label>Pay with<select id="method"><option value="mobile_money">Mobile money (MTN / Airtel)</option><option value="card">Card</option></select></label>
      <div class="row"><button class="btn btn-ghost" id="fail">Simulate a failed payment</button><button class="btn btn-gold" id="ok">Pay (test)</button></div>`;
    const go = async (outcome) => { try { const r = await call('POST', '/pay/test', { token, outcome, method: $('#method').value }); done(r.status === 'paid' ? 'Payment received. Thank you!' : 'The payment did not go through. You can try again from the booking page or pay at the hotel.'); } catch (e) { done(esc(e.message)); } };
    $('#ok').addEventListener('click', () => go('paid')); $('#fail').addEventListener('click', () => go('failed'));
  }).catch((e) => done(esc(e.message)));
})();
