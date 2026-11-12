// Public page: a guest stops marketing emails with the link from an email. No sign-in.
(() => {
  const out = document.getElementById('out');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = new URLSearchParams(location.search).get('t') || '';
  const done = (p) => { out.innerHTML = `<p>You will no longer receive offers and news from <b>${esc(p)}</b>. Messages about a booking you make will still reach you.</p>`; };
  fetch('/api/marketing/unsubscribe/' + encodeURIComponent(token)).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then(({ ok, d }) => {
    if (!ok) { out.innerHTML = `<p class="err">${esc(d.error || 'This link is not valid.')}</p>`; return; }
    document.getElementById('title').textContent = d.property;
    if (!d.subscribed) { done(d.property); return; }
    out.innerHTML = `<p>Stop receiving offers and news from <b>${esc(d.property)}</b> at ${esc(d.email)}?</p><button class="btn btn-gold" id="go" type="button">Unsubscribe</button>`;
    document.getElementById('go').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const r = await fetch('/api/marketing/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      if (r.ok) done(d.property); else { e.target.disabled = false; out.insertAdjacentHTML('beforeend', '<p class="err">Something went wrong. Please try again.</p>'); }
    });
  }).catch(() => { out.innerHTML = '<p class="err">Could not load. Please try again.</p>'; });
})();
