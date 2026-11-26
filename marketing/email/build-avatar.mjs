// Square profile photos for email/WhatsApp accounts: images/brand/azeli-profile-*.png (1024 x 1024).
// Run: node marketing/email/build-avatar.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
// Circle crops (Zoho, Gmail, WhatsApp) cut the corners, so the mark sits inside the middle 70%.
const svg = (bg, fg) => `<svg width="1024" height="1024" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<rect width="64" height="64" fill="${bg}"/>
<g transform="translate(32 32) scale(.7) translate(-32 -32)">
<path d="M14 49 L32 15 L50 49" fill="none" stroke="${fg}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M23.5 49 A8.5 8.5 0 0 1 40.5 49 Z" fill="#1f5fd1"/></g></svg>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
for (const [name, bg, fg] of [['navy', '#142133', '#ffffff'], ['white', '#ffffff', '#142133']]) {
  await p.setContent(`<style>*{margin:0}</style>${svg(bg, fg)}`);
  await p.screenshot({ path: path.join(here, `../../images/brand/azeli-profile-${name}.png`), clip: { x: 0, y: 0, width: 1024, height: 1024 } });
}
await b.close(); console.log('ok');
