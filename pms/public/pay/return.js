// The guest is back from the payment provider: ask the hotel's system what happened (it checks with the provider).
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = new URLSearchParams(location.search).get('t') || '';
  const ugx = (n) => 'UGX ' + Number(n).toLocaleString('en-US');
  let tries = 0;
  const show = (title, html) => { $('#title').textContent = title; $('#box').innerHTML = html + '<p><a class="btn btn-ghost" href="/book/">Back to the booking page</a></p>'; };
  async function check() {
    tries++;
    try {
      const r = await fetch(`/api/public/pay/${encodeURIComponent(token)}/status`);
      const i = await r.json().catch(() => ({}));
      if (!r.ok) return show('Payment not found', `<p class="err">${esc(i.error || 'We could not find this payment.')}</p>`);
      document.title = `Payment · ${i.property_name}`;
      if (i.status === 'paid') return show('Payment received. Thank you!', `<p class="ok">${ugx(i.amount)} has been paid for booking <b>${esc(i.code)}</b>. A receipt is on your bill at ${esc(i.property_name)}.</p>`);
      if (i.status === 'failed' || i.status === 'expired') return show('The payment did not go through', `<p>Nothing was recorded for booking <b>${esc(i.code)}</b>. You can try again from “Manage a booking”, or pay at the hotel.</p>`);
      if (tries < 8) { setTimeout(check, 2500 * tries); return; }
      show('Still waiting for confirmation', `<p>The payment for booking <b>${esc(i.code)}</b> has not been confirmed yet. Mobile money can take a few minutes: approve it on your phone if asked. The hotel's system keeps checking, so you do not need to pay again.</p>`);
    } catch { if (tries < 8) setTimeout(check, 3000); else show('We could not check the payment', '<p>Please check your connection. The hotel will see the payment as soon as it is confirmed.</p>'); }
  }
  check();
})();
