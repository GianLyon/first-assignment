// Azeli Console against a real PostgreSQL database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { setMailer } from '../src/mailer.js';
import { config } from '../src/config.js';
import * as totp from '../src/totp.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://hk:hk_dev_pw@localhost:5432/azeli_console_test';
let pool, server, base, owner, editor, sales;
const mails = [];

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
  };
  return { get: (p, h) => call('GET', p, undefined, h), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b),
    login: async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); } };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };

before(async () => {
  pool = createPool(DB);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  for (const [email, role] of [['owner@azelitech.com', 'owner'], ['editor@azelitech.com', 'editor'], ['sales@azelitech.com', 'sales']]) {
    await pool.query('INSERT INTO users (email, full_name, role, password_hash) VALUES ($1,$2,$3,$4)', [email, role.toUpperCase(), role, await hashPassword('password-1234')]);
  }
  config.leadNotify = ['team@azelitech.com'];
  setMailer(async (m) => { mails.push(m); });
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  owner = client(); await owner.login('owner@azelitech.com', 'password-1234');
  editor = client(); await editor.login('editor@azelitech.com', 'password-1234');
  sales = client(); await sales.login('sales@azelitech.com', 'password-1234');
});
after(async () => { setMailer(null); server.close(); await pool.end(); });

test('sign-in, throttling and roles', async () => {
  const c = client();
  assert.equal((await c.get('/api/me')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { email: 'nobody@x.com', password: 'wrong-password' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'nobody@x.com', password: 'wrong-password' })).status, 429);
  assert.equal((await editor.get('/api/clients')).status, 403);
  assert.equal((await editor.put('/api/leads/1', { status: 'won' })).status, 403);
  assert.equal((await sales.put('/api/content/hero', {})).status, 403);
  assert.equal((await sales.get('/api/users')).status, 403);
  assert.equal((await owner.post('/api/users', { email: 'x@y.com' }, { 'content-type': 'text/plain' })).status, 415);
  const me = ok(await editor.get('/api/me'));
  assert.equal(me.can['content.publish'], true);
  assert.equal(me.can['leads.manage'], false);
});

test('website enquiries: CORS for the site only, honeypot, rate limit, follow-up', async () => {
  const pub = (body, origin = 'https://azelitech.com') => fetch(base + '/api/public/leads', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  const pre = await fetch(base + '/api/public/leads', { method: 'OPTIONS', headers: { origin: 'https://azelitech.com', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://azelitech.com');
  const evil = await fetch(base + '/api/public/leads', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  assert.equal((await pub({ name: 'X', email: 'bad', business: 'Y' })).status, 400);
  const r = await pub({ name: 'Sarah N', email: 'Sarah@LakeHotel.ug', business: 'Lake Hotel', type: 'Hotel', services: ['SEO & GEO', 'Hotel software (PMS)'], message: 'We need more direct bookings', package: 'Growth', page: '/contact.html' });
  assert.equal(r.status, 200);
  const { ref } = await r.json();
  assert.match(ref, /^L\d+$/);
  ok(await (async () => { const x = await pub({ name: 'Bot', email: 'b@b.co', business: 'B', website: 'http://spam' }); return { status: x.status, data: await x.json() }; })());
  await new Promise((s) => setTimeout(s, 50));
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /New enquiry: Lake Hotel/);
  assert.equal(mails[0].replyTo, 'sarah@lakehotel.ug');

  const list = ok(await sales.get('/api/leads'));
  assert.equal(list.length, 1); // the bot's honeypot submission was not stored
  const lead = list[0];
  assert.deepEqual(lead.services, ['SEO & GEO', 'Hotel software (PMS)']);
  assert.equal(lead.status, 'new');
  ok(await sales.put(`/api/leads/${lead.id}`, { status: 'contacted', assigned_to: lead.assigned_to, value_ugx: 1500000, next_action_date: '2026-11-20' }));
  ok(await sales.post(`/api/leads/${lead.id}/notes`, { note: 'Called Sarah; sending a proposal on Friday.' }));
  const d = ok(await editor.get(`/api/leads/${lead.id}`));
  assert.equal(d.lead.status, 'contacted');
  assert.equal(d.notes[0].note, 'Called Sarah; sending a proposal on Friday.');
  const dash = ok(await owner.get('/api/dashboard'));
  assert.equal(dash.leads.open, 1);
  assert.equal(dash.leads.last30, 1);

  // rate limit: 5 attempts an hour per address (1 invalid + 1 real + 1 bot so far)
  for (let i = 0; i < 2; i++) assert.equal((await pub({ name: 'N' + i, email: `n${i}@x.co`, business: 'B' })).status, 200);
  assert.equal((await pub({ name: 'N9', email: 'n9@x.co', business: 'B' })).status, 429);
});

test('website content: defaults, validation, draft, publish with deploy hook', async () => {
  let site = await (await fetch(base + '/api/public/site')).json();
  assert.equal(site.contact.email, 'hello@azelitech.com');
  assert.equal(site.packages.items.length, 3);
  assert.equal((await editor.put('/api/content/contact', { email: 'x', phone: '+256', phone_display: 'x', whatsapp: '1' })).status, 400);
  assert.equal((await editor.put('/api/content/hero', { eyebrow: 'A', title: '<script>', lead: 'L' })).status, 400);
  assert.equal((await editor.put('/api/content/packages', { items: [{ name: 'A', features: ['x'], featured: true }, { name: 'B', features: ['y'], featured: true }] })).status, 400);
  ok(await editor.put('/api/content/contact', { email: 'Hello@Azelitech.com', phone: '+256 700 123 456', phone_display: '+256 700 123 456', whatsapp: '+256 700 123 456' }));
  ok(await editor.put('/api/content/announcement', { active: true, text: 'Now booking PMS demos for December', link_text: 'Book a demo', link_url: 'contact.html?package=Growth' }));
  // drafts are not live until published
  site = await (await fetch(base + '/api/public/site')).json();
  assert.equal(site.contact.email, 'hello@azelitech.com');
  const c = ok(await editor.get('/api/content'));
  assert.equal(c.sections.contact.changed, true);
  assert.equal(c.sections.contact.draft.phone, '+256700123456');
  assert.equal(c.sections.contact.draft.whatsapp, '256700123456');

  // a fake Vercel deploy hook
  const hooks = [];
  const hookServer = (await import('node:http')).createServer((req, res) => { hooks.push(req.method); res.end('{}'); }).listen(0);
  config.deployHook = `http://127.0.0.1:${hookServer.address().port}/hook`;
  const p = ok(await editor.post('/api/content/publish'));
  assert.deepEqual(p.sections.sort(), ['announcement', 'contact']);
  assert.equal(p.deploy, 'triggered');
  assert.deepEqual(hooks, ['POST']);
  site = await (await fetch(base + '/api/public/site')).json();
  assert.equal(site.contact.email, 'hello@azelitech.com');
  assert.equal(site.contact.phone, '+256700123456');
  assert.equal(site.announcement.active, true);
  assert.equal(ok(await editor.post('/api/content/publish')).sections.length, 0); // nothing new
  hookServer.close(); config.deployHook = '';
  assert.equal(ok(await owner.get('/api/dashboard')).unpublished, 0);
});

test('client hotels: online check and month-to-date figures with the group key', async () => {
  // a stand-in for a hotel's Azeli PMS
  const http = await import('node:http');
  const key = 'azg_' + 'k'.repeat(30);
  const pms = http.createServer((req, res) => {
    if (req.url === '/healthz') return res.end('{"ok":true}');
    if (req.url.startsWith('/api/group/summary')) {
      if (req.headers.authorization !== `Bearer ${key}`) { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify({ property: 'Amaya Hotel & Luxury Suites', occupancy: 0.72, revenue_total: 48000000, adr: 380000 }));
    }
    res.statusCode = 404; res.end();
  }).listen(0);
  const url = `http://127.0.0.1:${pms.address().port}`;
  assert.equal((await sales.post('/api/clients', { name: 'X', pms_url: url })).status, 403);
  assert.equal((await owner.post('/api/clients', { name: 'Amaya', pms_url: 'http://example.com' })).status, 400); // https only
  assert.equal((await owner.post('/api/clients', { name: 'Amaya', pms_url: url, group_token: 'wrong' })).status, 400);
  const c = ok(await owner.post('/api/clients', { name: 'Amaya Hotel & Luxury Suites', pms_url: url, group_token: key, package: 'Growth', monthly_fee_ugx: 1500000, status: 'active' }));
  let list = ok(await sales.get('/api/clients'));
  assert.equal(list[0].last_status, 'online');
  assert.equal(list[0].last_summary.occupancy, 0.72);
  assert.equal(list[0].has_key, true);
  assert.ok(!('group_token' in list[0]));
  assert.equal(ok(await owner.get('/api/dashboard')).clients.mrr, 1500000);
  pms.close();
  await new Promise((s) => setTimeout(s, 50));
  const chk = ok(await sales.post(`/api/clients/${c.id}/check`));
  assert.match(chk.status, /Not reachable/);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(mails.some((m) => /^OFFLINE: Amaya Hotel/.test(m.subject)), 'the team is told the hotel is offline');
  const before = mails.length;
  await sales.post(`/api/clients/${c.id}/check`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.length, before); // told once, not on every check
  list = ok(await sales.get('/api/clients'));
  assert.equal(list[0].last_summary.occupancy, 0.72); // last known figures are kept
  assert.equal(ok(await owner.get('/api/dashboard')).clients.offline, 1);
});

test('team: add members, roles, never lock out the last owner', async () => {
  assert.equal((await owner.post('/api/users', { email: 'ann@azelitech.com', full_name: 'Ann', role: 'sales', password: 'short' })).status, 400);
  const u = ok(await owner.post('/api/users', { email: 'Ann@azelitech.com', full_name: 'Ann', role: 'sales', password: 'long-password-1' }));
  assert.equal((await owner.post('/api/users', { email: 'ann@azelitech.com', full_name: 'Ann', role: 'sales', password: 'long-password-1' })).status, 409);
  const ann = client(); await ann.login('ann@azelitech.com', 'long-password-1');
  ok(await owner.put(`/api/users/${u.id}`, { role: 'sales', active: false }));
  assert.equal((await ann.get('/api/me')).status, 401); // switched off: signed out at once
  const me = ok(await owner.get('/api/me')).user;
  assert.equal((await owner.put(`/api/users/${me.id}`, { role: 'editor', active: true })).status, 409);
  const log = ok(await owner.get('/api/audit'));
  assert.ok(log.some((a) => a.action === 'content.publish'));
  assert.ok(log.some((a) => a.action === 'lead.received'));
});

test('two-step sign-in for the team: set up, code at sign-in, required for owners, reset by an owner', async () => {
  const secretOf = async (email, col) => (await pool.query(`SELECT ${col} AS s FROM users WHERE email=$1`, [email])).rows[0].s;
  const st = ok(await editor.post('/api/auth/mfa/setup'));
  assert.match(st.qr_svg, /^<svg/);
  const rc = ok(await editor.post('/api/auth/mfa/enable', { code: totp.codeAt(await secretOf('editor@azelitech.com', 'totp_pending'), totp.stepNow()) }));
  assert.equal(rc.recovery_codes.length, 10);
  const c = client();
  const r1 = await c.post('/api/auth/login', { email: 'editor@azelitech.com', password: 'password-1234' });
  assert.equal(r1.data.mfa_required, true);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/auth/mfa', { challenge: r1.data.challenge, code: '000000' })).status, 401);
  ok(await c.post('/api/auth/mfa', { challenge: r1.data.challenge, code: rc.recovery_codes[0] }));
  ok(await c.get('/api/me'));
  // owners must use it: an owner without it can only set it up
  assert.equal((await editor.put('/api/security', { mfa_required_roles: ['owner'] })).status, 403);
  ok(await owner.put('/api/security', { mfa_required_roles: ['owner'] }));
  const me = ok(await owner.get('/api/me'));
  assert.equal(me.mfa.setup_needed, true);
  assert.equal((await owner.get('/api/leads')).status, 403);
  ok(await owner.post('/api/auth/mfa/setup'));
  ok(await owner.post('/api/auth/mfa/enable', { code: totp.codeAt(await secretOf('owner@azelitech.com', 'totp_pending'), totp.stepNow()) }));
  ok(await owner.get('/api/leads'));
  assert.equal((await owner.post('/api/auth/mfa/disable', { password: 'password-1234' })).status, 409);
  const ed = ok(await owner.get('/api/users')).find((u) => u.email === 'editor@azelitech.com');
  assert.equal(ed.mfa_enabled, true);
  ok(await owner.post(`/api/users/${ed.id}/mfa-reset`));
  assert.equal((await c.get('/api/me')).status, 401); // signed out everywhere
  ok(await owner.put('/api/security', { mfa_required_roles: [] }));
});
