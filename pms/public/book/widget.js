/*
 * Azeli booking widget: put the hotel's booking engine on any website (WordPress, Wix, a hand-made site …).
 *
 *   <div id="azeli-booking"></div>
 *   <script src="https://HOTEL.azelitech.com/book/widget.js" async></script>
 *
 * Options (attributes on the <script> tag):
 *   data-style="bar"      a search bar with dates and guests (default)
 *   data-style="button"   a single "Book now" button (put it where the button should appear)
 *   data-style="floating" a "Book now" button fixed to the bottom corner of every page
 *   data-color="#1f5fd1"  button colour
 *   data-label="Book now" button text
 *   data-target="_blank"  open the booking page in a new tab (default: same tab)
 *   data-lang="en"        reserved for later
 * The widget only links to the booking page; prices, rooms and payment are all handled there, so the hotel's
 * website never sees guest or card details.
 */
(() => {
  'use strict';
  const me = document.currentScript;
  if (!me) return;
  const base = new URL(me.src).origin;
  const opt = (k, d) => me.getAttribute('data-' + k) || d;
  const style = opt('style', 'bar');
  const color = /^#[0-9a-f]{3,8}$/i.test(opt('color', '')) ? opt('color') : '#1f5fd1';
  const label = opt('label', 'Book now').slice(0, 40);
  const target = opt('target', '') === '_blank' ? '_blank' : '_self';
  const site = location.hostname.slice(0, 100);

  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const plus = (s, n) => { const t = new Date(s + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const today = iso(new Date());
  const go = (q) => {
    const u = new URL('/book/', base);
    for (const [k, v] of Object.entries({ ...q, src: site })) if (v) u.searchParams.set(k, v);
    window.open(u.toString(), target, target === '_blank' ? 'noopener' : '');
  };

  const host = document.createElement('div');
  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; padding: 14px; background: #fff; border: 1px solid #dde3ea; border-radius: 10px; box-shadow: 0 6px 24px rgba(16,26,40,.08); color: #18212d; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: #5b6878; flex: 1 1 140px; }
    input, select { font: inherit; font-size: 15px; font-weight: 400; color: #18212d; padding: 9px 10px; border: 1px solid #c4ccd6; border-radius: 6px; background: #fff; min-height: 42px; width: 100%; }
    .guests { flex: 0 1 110px; }
    button { font: inherit; font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 15px; font-weight: 600; color: #fff; background: ${color}; border: 0; border-radius: 6px; padding: 0 22px; min-height: 42px; cursor: pointer; flex: 0 0 auto; }
    button:hover { filter: brightness(.92); }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid ${color}; outline-offset: 2px; }
    .floating { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; box-shadow: 0 8px 24px rgba(0,0,0,.22); padding: 0 24px; min-height: 48px; border-radius: 24px; }
    .note { flex-basis: 100%; margin: 0; font-size: 12px; color: #5b6878; }
    @media (max-width: 560px) { .bar { flex-direction: column; align-items: stretch; } label, .guests { flex: 1 1 auto; } button { min-height: 46px; } }
  `;
  const s = document.createElement('style'); s.textContent = css; root.appendChild(s);

  if (style === 'button' || style === 'floating') {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    if (style === 'floating') b.className = 'floating';
    b.addEventListener('click', () => go({}));
    root.appendChild(b);
  } else {
    const f = document.createElement('form'); f.className = 'bar'; f.setAttribute('aria-label', 'Check availability');
    f.innerHTML = `<label>Arrival<input type="date" name="arrival" required></label>
      <label>Departure<input type="date" name="departure" required></label>
      <label class="guests">Guests<select name="adults">${[1, 2, 3, 4, 5, 6].map((n) => `<option${n === 2 ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="submit"></button><p class="note">Best rate when you book direct.</p>`;
    f.querySelector('button').textContent = label === 'Book now' ? 'Check availability' : label;
    const a = f.elements.arrival, d = f.elements.departure;
    a.min = today; a.value = today; d.min = plus(today, 1); d.value = plus(today, 2);
    a.addEventListener('change', () => { d.min = plus(a.value, 1); if (d.value <= a.value) d.value = plus(a.value, 1); });
    f.addEventListener('submit', (e) => { e.preventDefault(); go({ arrival: a.value, departure: d.value, adults: f.elements.adults.value }); });
    root.appendChild(f);
  }

  const place = () => {
    const slot = style === 'floating' ? document.body : document.getElementById('azeli-booking');
    if (slot) slot.appendChild(host);
    else if (me.parentNode && me.parentNode !== document.head) me.parentNode.insertBefore(host, me.nextSibling);
    else document.body.appendChild(host);
  };
  if (document.body) place(); else document.addEventListener('DOMContentLoaded', place);
})();
