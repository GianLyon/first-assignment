// Renders images/brand/azeli-email-logo.png (for the email header; email apps block SVG).
// Run: TOOLS=<node_modules with @fontsource/ibm-plex-sans|mono> node marketing/email/build-logo.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(process.env.TOOLS || process.cwd(), 'x.js'));
const { chromium } = createRequire(import.meta.url)('playwright');
const f = (p, w) => fs.readFileSync(req.resolve(`@fontsource/${p}/files/${p}-latin-${w}-normal.woff2`)).toString('base64');
const html = `<style>
@font-face{font-family:P;font-weight:600;src:url(data:font/woff2;base64,${f('ibm-plex-sans', 600)})}
@font-face{font-family:M;font-weight:500;src:url(data:font/woff2;base64,${f('ibm-plex-mono', 500)})}
*{margin:0}body{background:#142133}
#l{width:168px;height:40px;display:flex;align-items:center;gap:11px;background:#142133}
b{display:block;font:600 22px/1 P;color:#fff;letter-spacing:-.4px}
span{display:block;margin-top:4px;font:500 7.4px/1 M;letter-spacing:3.1px;color:#9fbaf0}
</style><div id="l"><svg width="40" height="40" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#fff"/>
<path d="M14 49 L32 15 L50 49" fill="none" stroke="#142133" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M23.5 49 A8.5 8.5 0 0 1 40.5 49 Z" fill="#1f5fd1"/></svg><div><b>Azeli</b><span>TECHNOLOGIES</span></div></div>`;
const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 3 });
await p.setContent(html); await p.evaluate(() => document.fonts.ready);
await (await p.$('#l')).screenshot({ path: path.join(here, '../../images/brand/azeli-email-logo.png') });
await b.close();
console.log('ok');
