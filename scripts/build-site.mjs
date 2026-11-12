// Build the public website into dist-site/.
// 1. Copies only the website's own files (never the PMS or console source).
// 2. If CONSOLE_URL is set, fetches the content published in the Azeli Console and writes it into the
//    pages (between <!-- cms:… --> markers), so search engines see it in the HTML itself.
//    If the console cannot be reached, the site is built exactly as it is in the repository.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-site');
const SITE = 'https://azelitech.com';
const PAGES = ['index.html', 'services.html', 'work.html', 'how-we-work.html', 'packages.html', 'contact.html', 'pms.html'];
const CONSOLE_URL = (process.env.CONSOLE_URL || '').replace(/\/+$/, '');

// what the pages contain in the repository (replaced by the published values)
const SOURCE_CONTACT = { email: 'hello@azelitech.com', phone: '+27787094814', phone_display: '+27 78 709 4814', whatsapp: '27787094814' };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const safeHref = (u) => (/^(https:\/\/|[a-z0-9-]+\.html|#)/i.test(u || '') ? u : 'contact.html');

function block(html, name, inner) {
  const re = new RegExp(`(<!-- cms:${name} -->)[\\s\\S]*?(<!-- /cms:${name} -->)`, 'g');
  return html.replace(re, (_m, a, b) => `${a}${inner}${b}`);
}

const render = {
  announcement: (a) => (a.active && a.text ? `<div class="announce" role="note"><div class="container"><span>${esc(a.text)}</span>${a.link_url && a.link_text ? ` <a href="${esc(safeHref(a.link_url))}">${esc(a.link_text)} →</a>` : ''}</div></div>` : ''),
  hero: (h) => `\n          <p class="eyebrow">${esc(h.eyebrow)}</p>\n          <h1>${esc(h.title)}${h.title_accent ? ` <span class="accent">${esc(h.title_accent)}</span>` : ''}</h1>\n          <p class="lead">${esc(h.lead)}</p>\n          `,
  packages: (p) => '\n' + p.items.map((k) => `          <article class="package${k.featured ? ' featured' : ''}">
            ${k.badge ? `<span class="badge">${esc(k.badge)}</span>\n            ` : ''}<h3>${esc(k.name)}</h3>
            ${k.tagline ? `<p class="pkg-tag">${esc(k.tagline)}</p>` : ''}${k.price ? `\n            <p class="pkg-price">${esc(k.price)}</p>` : ''}
            <ul class="ticks">
${k.features.map((f) => `              <li>${bold(f)}</li>`).join('\n')}
            </ul>
            <a href="contact.html?package=${encodeURIComponent(k.name)}" class="btn ${k.featured ? 'btn-gold' : 'btn-outline'}">Ask about ${esc(k.name)}</a>
          </article>`).join('\n') + '\n          ',
  case_results: (c) => '\n' + c.results.map((r) => `              <div class="result"><b>${esc(r.value)}</b><span>${esc(r.label)}</span></div>`).join('\n') + '\n              ',
  case_quote: (c) => `\n            <blockquote class="case-quote">\n              <p>“${esc(c.quote)}”</p>\n              <cite>${esc(c.cite)}</cite>\n            </blockquote>\n            `,
};

async function fetchContent() {
  if (!CONSOLE_URL) { console.log('CONSOLE_URL not set: building the pages as they are in the repository.'); return null; }
  try {
    const r = await fetch(`${CONSOLE_URL}/api/public/site`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    const c = await r.json();
    if (!c?.contact?.email || !Array.isArray(c?.packages?.items)) throw new Error('unexpected content');
    console.log('Using content published in the Azeli Console.');
    return c;
  } catch (e) {
    console.warn(`Could not read the Azeli Console (${e.message}): building the pages as they are in the repository.`);
    return null;
  }
}

function applyContact(text, c) {
  return text.split(`wa.me/${SOURCE_CONTACT.whatsapp}`).join(`wa.me/${c.whatsapp}`)
    .split(SOURCE_CONTACT.phone).join(c.phone)
    .split(SOURCE_CONTACT.phone_display).join(esc(c.phone_display))
    .split(SOURCE_CONTACT.email).join(c.email);
}

export async function build() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const content = await fetchContent();
  for (const page of PAGES) {
    let html = await readFile(path.join(ROOT, page), 'utf8');
    if (content) {
      html = applyContact(html, content.contact);
      html = block(html, 'announcement', render.announcement(content.announcement));
      if (page === 'index.html') {
        html = block(html, 'hero', render.hero(content.hero));
        const t = esc(content.seo.home_title), d = esc(content.seo.home_description);
        html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
          .replace(/(<meta name="description" content=")[^"]*(")/, `$1${d}$2`)
          .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
          .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${d}$2`);
      }
      if (page === 'packages.html') html = block(html, 'packages', render.packages(content.packages));
      if (page === 'work.html') { html = block(html, 'case_results', render.case_results(content.case_study)); html = block(html, 'case_quote', render.case_quote(content.case_study)); }
    }
    await writeFile(path.join(OUT, page), html);
  }
  let js = await readFile(path.join(ROOT, 'script.js'), 'utf8');
  if (content) js = applyContact(js, content.contact);
  // enquiries go to the console when it is configured
  if (CONSOLE_URL) js = js.replace(/const FORM_ENDPOINT = "[^"]*";/, `const FORM_ENDPOINT = ${JSON.stringify(CONSOLE_URL + '/api/public/leads')};`);
  await writeFile(path.join(OUT, 'script.js'), js);
  await cp(path.join(ROOT, 'styles.css'), path.join(OUT, 'styles.css'));
  for (const dir of ['images', 'pms-demo']) await cp(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true, filter: (src) => !/README[^/]*$/i.test(src) });
  await writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['', ...PAGES.filter((p) => p !== 'index.html')].map((p) => `  <url><loc>${SITE}/${p}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  const count = async (d) => (await readdir(d, { withFileTypes: true })).reduce(async (n, e) => (await n) + (e.isDirectory() ? await count(path.join(d, e.name)) : 1), Promise.resolve(0));
  console.log(`Website built in dist-site/ (${await count(OUT)} files).`);
}

if (import.meta.url === `file://${process.argv[1]}`) await build();
