// Phase 8: scheduled department reports by email, and the multi-property group dashboard (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, book, DAY0, ctx } from './helpers.js';
import { setMailer } from '../src/email/index.js';
import { periodsClosedBy } from '../src/services/reports.js';

let admin, mgr, acc, fd;
const sent = [];
let failMail = false;
const sendQueued = async () => ok(await mgr.post('/api/reporting/outbox/send'));

before(async () => {
  await startTestServer({ pos: true, operations: true, hr: true });
  setMailer(async (m) => { if (failMail) throw new Error('SMTP 451 try later'); sent.push(m); return {}; });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['manager1', 'manager'], ['accounts1', 'accountant'], ['frontdesk', 'front_office']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  mgr = client(); await mgr.login('manager1', 'password-123');
  acc = client(); await acc.login('accounts1', 'password-123');
  fd = client(); await fd.login('frontdesk', 'password-123');
});
after(async () => { setMailer(null); await stopTestServer(); });

test('periods: daily always, weekly on Sundays, monthly on the last day', () => {
  assert.deepEqual(periodsClosedBy('2026-11-10').map((p) => p.frequency), ['daily']);
  assert.deepEqual(periodsClosedBy('2026-11-15'), [{ frequency: 'daily', from: '2026-11-15', to: '2026-11-15' }, { frequency: 'weekly', from: '2026-11-09', to: '2026-11-15' }]);
  assert.deepEqual(periodsClosedBy('2026-11-30').at(-1), { frequency: 'monthly', from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(periodsClosedBy('2026-02-28').at(-1), { frequency: 'monthly', from: '2026-02-01', to: '2026-02-28' });
});

test('permissions', async () => {
  // front office sees only the reports for areas it already has: not finance
  ok(await fd.post('/api/reporting/run', { report: 'front_office', from: DAY0, to: DAY0 }));
  assert.equal((await fd.post('/api/reporting/run', { report: 'finance', from: DAY0, to: DAY0 })).status, 403);
  const finRun = ok(await acc.post('/api/reporting/run', { report: 'finance', from: DAY0, to: DAY0 }));
  assert.equal((await fd.get(`/api/reporting/runs/${finRun.id}`)).status, 404);
  assert.ok(ok(await fd.get('/api/reporting/runs')).every((r) => r.report !== 'finance'));
  assert.ok(!('finance' in ok(await fd.get('/api/reporting/setup')).reports));
  assert.equal((await fd.get('/api/reporting/group')).status, 403);
  assert.equal((await acc.post('/api/reporting/subscriptions', { report: 'finance', frequency: 'daily', recipients: 'a@b.co' })).status, 403);
  assert.equal((await acc.get('/api/reporting/outbox')).status, 403);
  // the accountant can produce a report on screen but not email it
  assert.equal((await acc.post('/api/reporting/run', { report: 'finance', from: DAY0, to: DAY0, recipients: 'x@y.co' })).status, 403);
  ok(await acc.get('/api/reporting/group'));
  assert.equal((await fd.post('/api/reporting/group/token')).status, 403); // settings managers only
});

test('schedules: validation and one per report and frequency', async () => {
  assert.equal((await mgr.post('/api/reporting/subscriptions', { report: 'manager', frequency: 'daily', recipients: 'not-an-email' })).status, 400);
  assert.equal((await mgr.post('/api/reporting/subscriptions', { report: 'nope', frequency: 'daily', recipients: 'gm@hotel.ug' })).status, 400);
  assert.equal((await mgr.post('/api/reporting/subscriptions', { report: 'manager', frequency: 'daily', recipients: '' })).status, 400);
  ok(await mgr.post('/api/reporting/subscriptions', { report: 'manager', frequency: 'daily', recipients: 'GM@hotel.ug, owner@hotel.ug; gm@hotel.ug' }));
  assert.equal((await mgr.post('/api/reporting/subscriptions', { report: 'manager', frequency: 'daily', recipients: 'x@hotel.ug' })).status, 409);
  ok(await mgr.post('/api/reporting/subscriptions', { report: 'fnb', frequency: 'weekly', recipients: 'chef@hotel.ug' }));
  const s = ok(await mgr.get('/api/reporting/setup'));
  assert.deepEqual(s.subscriptions.find((x) => x.report === 'manager').recipients, ['gm@hotel.ug', 'owner@hotel.ug']); // lower-cased, no duplicates
  assert.equal(s.email.mode, 'test');
});

test('night audit sends the daily report; weekly follows on Sunday; never twice', async () => {
  const stay = ok(await book(fd, await typeId(fd, 'STD'), DAY0, '2026-11-13', 'Report', { rate: 200000 }));
  ok(await fd.post(`/api/reservations/${stay.id}/check-in`, { room_id: await roomId(fd, '101') }));
  ok(await fd.post(`/api/reservations/${stay.id}/payments`, { method: 'mobile_money', amount: 300000 }));
  const audit = ok(await admin.post('/api/night-audit'));
  assert.equal(audit.reports_queued, 1);
  await sendQueued();
  assert.equal(sent.length, 2);
  const m = sent.find((x) => x.to === 'gm@hotel.ug');
  assert.match(m.subject, /^Test Hotel: General manager report, 10 Nov 2026$/);
  assert.match(m.text, /Occupancy: /);
  assert.match(m.text, /Mobile money \| 300,000/);
  assert.match(m.html, /General manager report/);
  assert.doesNotMatch(m.html, /<script/i);
  // calling the scheduler again changes nothing
  ok(await mgr.post('/api/reporting/outbox/send'));
  assert.equal(sent.length, 2);
  const runs = ok(await mgr.get('/api/reporting/runs'));
  assert.equal(runs.filter((r) => r.frequency === 'daily').length, 1);
  const full = ok(await mgr.get(`/api/reporting/runs/${runs[0].id}`));
  assert.equal(full.data.kpis[0][0], 'Occupancy');
  assert.equal(full.data.kpis[0][1], `${(Math.round(1000 / ok(await fd.get('/api/rooms')).filter((r) => r.active).length) / 10).toFixed(1)}%`);

  // audit through to Sunday 15 November: the weekly F&B report covers Mon 9 – Sun 15
  ok(await fd.post(`/api/reservations/${stay.id}/check-out`).catch(() => null));
  for (let i = 0; i < 5; i++) {
    const pre = ok(await admin.get('/api/night-audit'));
    for (const d of pre.due_out || []) await fd.post(`/api/reservations/${d.id}/check-out`);
    ok(await admin.post('/api/night-audit'));
  }
  await sendQueued();
  const weekly = sent.filter((x) => x.to === 'chef@hotel.ug');
  assert.equal(weekly.length, 1);
  assert.match(weekly[0].subject, /Food & beverage report, 9 Nov 2026 – 15 Nov 2026$/);
  assert.equal(sent.filter((x) => x.to === 'gm@hotel.ug').length, 6); // one per audited day
});

test('failed emails are retried with back-off, then given up and can be retried by hand', async () => {
  failMail = true;
  const run = ok(await mgr.post('/api/reporting/run', { report: 'maintenance', from: '2026-11-10', to: '2026-11-15', recipients: 'tech@hotel.ug' }));
  assert.equal(run.emailed, 1);
  await sendQueued();
  let box = ok(await mgr.get('/api/reporting/outbox'));
  let m = box.find((x) => x.to_address === 'tech@hotel.ug');
  assert.equal(m.status, 'queued');
  assert.equal(m.attempts, 1);
  assert.match(m.last_error, /451/);
  for (let i = 0; i < 6; i++) { await ctx.pool.query("UPDATE email_outbox SET next_attempt_at=now() WHERE id=$1", [m.id]); await sendQueued(); }
  m = ok(await mgr.get('/api/reporting/outbox')).find((x) => x.id === m.id);
  assert.equal(m.status, 'failed');
  assert.equal(m.attempts, 6);
  failMail = false;
  assert.equal((await mgr.post(`/api/reporting/outbox/${box[0].id === m.id ? 999999 : box[0].id}/retry`)).status, 409); // only failed ones
  ok(await mgr.post(`/api/reporting/outbox/${m.id}/retry`));
  await sendQueued();
  assert.equal(ok(await mgr.get('/api/reporting/outbox')).find((x) => x.id === m.id).status, 'test'); // delivered in test mode
  assert.ok(sent.find((x) => x.to === 'tech@hotel.ug'));
});

test('every department report builds from live data', async () => {
  const setup = ok(await mgr.get('/api/reporting/setup'));
  for (const report of Object.keys(setup.reports)) {
    const r = ok(await mgr.post('/api/reporting/run', { report, from: '2026-11-01', to: '2026-11-15' }));
    const d = ok(await mgr.get(`/api/reporting/runs/${r.id}`)).data;
    assert.equal(d.kpis.length, 4, report);
    assert.ok(d.sections.length >= 1, report);
    for (const s of d.sections) for (const row of s.rows) assert.equal(row.length, s.head.length, `${report}: ${s.title}`);
  }
  assert.equal((await mgr.post('/api/reporting/run', { report: 'manager', from: '2026-11-15', to: '2026-11-01' })).status, 400);
  assert.equal((await mgr.post('/api/reporting/run', { report: 'manager', from: '2025-01-01', to: '2026-11-15' })).status, 400); // over a year
});

test('group dashboard: access keys, linked properties, offline properties', async () => {
  assert.equal((await client().get('/api/group/summary?from=2026-11-01&to=2026-11-15')).status, 401);
  const { token } = ok(await admin.post('/api/reporting/group/token'));
  assert.match(token, /^azg_/);
  const pub = async (t) => fetch(`${ctx.base}/api/group/summary?from=2026-11-01&to=2026-11-15`, { headers: { authorization: `Bearer ${t}` } });
  assert.equal((await pub('azg_wrongwrongwrongwrongwrongwrong')).status, 401);
  const res = await pub(token);
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.equal(summary.property, 'Test Hotel');
  assert.ok(summary.revenue_total > 0);
  assert.doesNotMatch(JSON.stringify(summary), /Report Guest|first_name|phone/); // totals only, no guest data

  assert.equal((await admin.post('/api/reporting/group/properties', { name: 'Lakeside', base_url: 'http://example.com', token })).status, 400); // https only
  assert.equal((await admin.post('/api/reporting/group/properties', { name: 'Lakeside', base_url: ctx.base, token: 'secret' })).status, 400);
  ok(await admin.post('/api/reporting/group/properties', { name: 'Lakeside Resort', base_url: ctx.base + '/', token }));
  ok(await admin.post('/api/reporting/group/properties', { name: 'Hilltop Lodge', base_url: 'http://127.0.0.1:1', token }));
  const g = ok(await mgr.get('/api/reporting/group?from=2026-11-01&to=2026-11-15'));
  assert.equal(g.properties.length, 3);
  const self = g.properties.find((p) => p.self), lake = g.properties.find((p) => p.name === 'Lakeside Resort'), hill = g.properties.find((p) => p.name === 'Hilltop Lodge');
  assert.equal(lake.status, 'ok');
  assert.notEqual(hill.status, 'ok');
  assert.equal(g.total.properties, 2);
  assert.equal(g.total.revenue_total, self.revenue_total * 2);
  assert.equal(g.total.occupied, self.occupied * 2);

  ok(await admin.post('/api/reporting/group/token/revoke'));
  const g2 = ok(await mgr.get('/api/reporting/group?from=2026-11-01&to=2026-11-15'));
  assert.match(g2.properties.find((p) => p.name === 'Lakeside Resort').status, /refused/);
  const listed = ok(await admin.get('/api/reporting/group/properties'));
  assert.ok(listed.every((p) => !('token' in p)));
});
