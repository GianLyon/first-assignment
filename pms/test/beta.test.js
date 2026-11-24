// Phase 19: the installable app and the beta essentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, ctx } from './helpers.js';
import { recordError, goLive } from '../src/services/beta.js';

before(async () => { process.env.SUPPORT_EMAIL = 'support@azelitech.com'; await startTestServer({ distribution: true }); });
after(async () => { delete process.env.SUPPORT_EMAIL; await stopTestServer(); });

test('the app installs: manifest, icons and a service worker that never keeps hotel data', async () => {
  const v = ok(await client().get('/api/version'));
  assert.equal(v.beta, true); assert.match(v.version, /^\d+\.\d+\.\d+$/);
  const sw = await fetch(ctx.base + '/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const swText = await sw.text();
  assert.ok(swText.includes(`const VERSION = '${v.label}'`) && swText.includes('azeli-pms-${VERSION}'), 'each version gets its own cache');
  assert.match(swText, /startsWith\('\/api\/'\)/); // API answers are passed straight through, never cached
  const man = await fetch(ctx.base + '/manifest.webmanifest');
  assert.match(man.headers.get('content-type'), /application\/manifest\+json/);
  const m = await man.json();
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) assert.equal((await fetch(ctx.base + i.src)).status, 200, i.src);
  const html = await (await fetch(ctx.base + '/')).text();
  assert.match(html, /rel="manifest"/); assert.match(html, /apple-touch-icon/);
  assert.equal((await fetch(ctx.base + '/offline.html')).status, 200);
});

test('feedback from staff reaches the administrator and Azeli support; errors are kept once and counted', async () => {
  const admin = client(); await admin.login('admin', 'admin-pass-123');
  ok(await admin.post('/api/users', { username: 'fd1', full_name: 'Front Desk', role: 'front_office', password: 'fd-pass-12345' }));
  const fd = client(); await fd.login('fd1', 'fd-pass-12345');
  assert.equal((await client().post('/api/feedback', { message: 'hello there' })).status, 401);
  assert.equal((await fd.post('/api/feedback', { kind: 'problem', message: 'x' })).status, 400);
  const f = ok(await fd.post('/api/feedback', { kind: 'problem', message: 'The print button does nothing on the room board.', page: '#board' }));
  assert.equal(f.forwarded, true);
  const { rows: [mail] } = await ctx.pool.query("SELECT to_address, subject, text_body FROM email_outbox WHERE kind='support'");
  assert.equal(mail.to_address, 'support@azelitech.com');
  assert.match(mail.subject, /Test Hotel.*Problem from Front Desk/); assert.match(mail.text_body, /print button/);
  // only administrators see and close reports
  assert.equal((await fd.get('/api/feedback')).status, 403);
  const list = ok(await admin.get('/api/feedback'));
  assert.equal(list[0].full_name, 'Front Desk'); assert.equal(list[0].page, '#board'); assert.equal(list[0].status, 'new');
  ok(await admin.put(`/api/feedback/${list[0].id}`, { status: 'done', reply: 'Fixed in the next version.' }));
  assert.equal(ok(await admin.get('/api/feedback')).length, 0);
  assert.equal(ok(await admin.get('/api/feedback?status=done'))[0].reply, 'Fixed in the next version.');

  // errors from screens: the same one is counted, not repeated
  for (let i = 0; i < 3; i++) ok(await fd.post('/api/client-errors', { message: 'TypeError: x is undefined', source: '/app.js:120', stack: 'at render (/app.js:120:5)', page: '#board' }));
  await recordError(ctx.pool, { kind: 'server', message: 'boom', source: 'GET /api/x', stack: 'Error: boom\n    at y (/srv/a.js:1:1)' });
  const h = ok(await admin.get('/api/system/health'));
  const screen = h.errors.find((e) => e.kind === 'client');
  assert.equal(screen.count, 3); assert.equal(h.errors.filter((e) => e.kind === 'client').length, 1);
  assert.ok(h.errors.some((e) => e.kind === 'server' && e.message === 'boom'));
  assert.equal(h.errors_24h, 4);
  assert.equal(h.integrations.find((i) => i.key === 'support').state, 'live');
  assert.equal((await fd.get('/api/system/health')).status, 403);
  // a flood from one device is cut off
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await fd.post('/api/client-errors', { message: `e${i}` })).status === 429;
  assert.ok(limited);
});

test('the go-live checklist shows what is missing before real guests', async () => {
  const admin = client(); await admin.login('admin', 'admin-pass-123');
  let g = ok(await admin.get('/api/system/golive'));
  const item = (k) => g.items.find((i) => i.key === k);
  assert.equal(item('rooms').done, true);
  assert.equal(item('mfa').done, false);
  assert.equal(item('url').done, false);
  assert.ok(g.required_done < g.required_total);
  assert.ok(g.items.filter((i) => !i.required).every((i) => 'paid' in i || ['booking', 'review'].includes(i.key)));
  // requiring two-step sign-in for the managers ticks it off
  const s = ok(await admin.get('/api/settings'));
  await ctx.pool.query("UPDATE settings SET mfa_required_roles=ARRAY['admin','general_manager']");
  process.env.PUBLIC_URL = 'https://hotel.example.com';
  g = await goLive(ctx.pool); // (the administrator must now set up two-step sign-in before the API answers)
  assert.equal(item('mfa').done, true); assert.equal(item('url').done, true);
  delete process.env.PUBLIC_URL;
  await ctx.pool.query("UPDATE settings SET mfa_required_roles='{}'");
  void s;
});
