// Builds the Azeli business card: print PDF (85 x 55 mm, 3 mm bleed, front + back)
// and PNG previews. Run: node marketing/business-card/build.mjs
// Needs `qrcode` and `@fontsource/ibm-plex-sans|mono` (npm i in any folder, pass that node_modules as TOOLS=...).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// TOOLS = a node_modules folder holding qrcode and the fonts; playwright comes from the normal module path.
const require = createRequire(path.join(process.env.TOOLS || process.cwd(), 'x.js'));
const QRCode = require('qrcode');
const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));

const CARD = {
  name: 'Samuel Gianni',
  title: 'Managing Director',
  phone: '+27 78 709 4814',
  phoneHref: '+27787094814',
  email: 'support@azelitech.com',
  web: 'azelitech.com',
};

const font = (pkg, w) => fs.readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${w}-normal.woff2`)).toString('base64');
const faces = [['ibm-plex-sans', 'IBM Plex Sans', [400, 500, 600, 700]], ['ibm-plex-mono', 'IBM Plex Mono', [400, 500]]]
  .flatMap(([pkg, fam, ws]) => ws.map((w) => `@font-face{font-family:'${fam}';font-weight:${w};src:url(data:font/woff2;base64,${font(pkg, w)}) format('woff2')}`)).join('\n');

const qr = await QRCode.toString(`https://${CARD.web}/contact.html`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#142133', light: '#0000' } });

const mark = (size, light = false) => `
<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="15" fill="${light ? '#ffffff' : '#142133'}"/>
  <path d="M14 49 L32 15 L50 49" fill="none" stroke="${light ? '#142133' : '#ffffff'}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M23.5 49 A8.5 8.5 0 0 1 40.5 49 Z" fill="#1f5fd1"/>
</svg>`;

const icon = {
  phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/>',
  mail: '<path d="M3 5h18c.6 0 1 .4 1 1v12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V6c0-.6.4-1 1-1zm9 7.2L20 7H4l8 5.2zM4 9v8h16V9l-8 5.2L4 9z"/>',
  web: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.6 15.6 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.4 1.1-2.8 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4H4.3zm.8 2h2.9c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16zM8 8H5.1a8 8 0 0 1 4.3-3.6C8.8 5.5 8.3 6.7 8 8zm4 12c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.4-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h2.9a8 8 0 0 1-4.3 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4z"/>',
};
const ic = (k) => `<svg class="ic" viewBox="0 0 24 24" fill="#1f5fd1">${icon[k]}</svg>`;

const css = `
${faces}
@page { size: 91mm 61mm; margin: 0 }
* { box-sizing: border-box; margin: 0; padding: 0 }
html, body { background: #fff }
body { font-family: 'IBM Plex Sans', sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.card { width: 91mm; height: 61mm; position: relative; overflow: hidden; page-break-after: always; break-after: page }
.safe { position: absolute; inset: 7mm 7mm 7mm 7mm } /* 3 mm bleed + 4 mm safe margin */

/* FRONT */
.front { background: #142133; color: #fff }
.front .grid { position: absolute; inset: 0; background-image:
  linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
  background-size: 5mm 5mm; background-position: 3mm 3mm }
.front .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 5.2mm; background: #1f5fd1 }
.front .brand { position: absolute; left: 7mm; top: 50%; transform: translateY(-58%); display: flex; align-items: center; gap: 3.6mm }
.front .word { line-height: 1 }
.front .word b { display: block; font-weight: 600; font-size: 7.4mm; letter-spacing: -.02em }
.front .word span { display: block; margin-top: 1.4mm; font-family: 'IBM Plex Mono', monospace; font-weight: 500; font-size: 2.15mm; letter-spacing: .42em; color: #9fbaf0 }
.front .tag { position: absolute; left: 7mm; right: 7mm; bottom: 8.6mm; font-family: 'IBM Plex Mono', monospace; font-size: 1.95mm; letter-spacing: .08em; color: #b6c2d3; text-transform: uppercase; display: flex; justify-content: space-between }
.front .tag i { font-style: normal; color: #1f5fd1; padding: 0 1.2mm }

/* BACK */
.back { background: #fff; color: #18212d }
.back .edge { position: absolute; left: 0; top: 0; bottom: 0; width: 5.2mm; background: #1f5fd1 }
.back .safe { left: 10mm }
.back .head { display: flex; justify-content: space-between; align-items: flex-start }
.back .name { font-weight: 600; font-size: 5.1mm; letter-spacing: -.01em; color: #142133; line-height: 1.1 }
.back .role { margin-top: 1.5mm; font-family: 'IBM Plex Mono', monospace; font-weight: 500; font-size: 2.05mm; letter-spacing: .16em; text-transform: uppercase; color: #1f5fd1 }
.back .co { margin-top: .9mm; font-size: 2.3mm; color: #5b6878 }
.back hr { border: 0; border-top: .25mm solid #dde3ea; margin: 3.6mm 0 3.2mm; width: 44mm }
.back ul { list-style: none; display: grid; gap: 1.75mm }
.back li { display: flex; align-items: center; gap: 2.2mm; font-size: 2.55mm; color: #18212d; font-weight: 500 }
.back .ic { width: 2.9mm; height: 2.9mm; flex: none }
.back .qr { position: absolute; right: 7mm; bottom: 7mm; width: 15mm; text-align: center }
.back .qr svg { width: 15mm; height: 15mm; display: block }
.back .qr small { display: block; margin-top: 1mm; font-family: 'IBM Plex Mono', monospace; font-size: 1.5mm; letter-spacing: .06em; color: #5b6878; text-transform: uppercase }
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<section class="card front">
  <div class="grid"></div>
  <div class="brand">${mark('15mm', true)}<div class="word"><b>Azeli</b><span>TECHNOLOGIES</span></div></div>
  <div class="tag"><span>Hotel PMS<i>/</i>POS<i>/</i>Marketing</span></div>
  <div class="bar"></div>
</section>
<section class="card back">
  <div class="edge"></div>
  <div class="safe">
    <div class="head"><div>
      <div class="name">${CARD.name}</div>
      <div class="role">${CARD.title}</div>
      <div class="co">Azeli Technologies</div>
    </div>${mark('7mm')}</div>
    <hr>
    <ul>
      <li>${ic('phone')}${CARD.phone}</li>
      <li>${ic('mail')}${CARD.email}</li>
      <li>${ic('web')}${CARD.web}</li>
    </ul>
  </div>
  <div class="qr">${qr}<small>Book a demo</small></div>
</section>
</body></html>`;

fs.writeFileSync(path.join(here, 'card.html'), html);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 520 }, deviceScaleFactor: 4 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ path: path.join(here, 'azeli-business-card-print.pdf'), width: '91mm', height: '61mm', printBackground: true, pageRanges: '1-2' });
// previews: trimmed to the final 85 x 55 mm size (bleed cut off)
const mm = 96 / 25.4;
for (const [i, side] of [[0, 'front'], [1, 'back']]) {
  const el = (await page.$$('.card'))[i];
  const b = await el.boundingBox();
  await page.screenshot({ path: path.join(here, `azeli-business-card-${side}.png`), clip: { x: b.x + 3 * mm, y: b.y + 3 * mm, width: 85 * mm, height: 55 * mm } });
}
await browser.close();
console.log('built', fs.readdirSync(here).join(', '));
