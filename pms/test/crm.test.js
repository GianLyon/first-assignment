// Phase 9: guest CRM & marketing (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, book, DAY0, ctx } from './helpers.js';
import { setMailer } from '../src/email/index.js';

let admin, mgr, fd, acc, web;
const sent = [];
const flush = async () => ok(await mgr.post('/api/reporting/outbox/send'));
const audit = async () => {
  const pre = ok(await admin.get('/api/night-audit'));
  for (const d of pre.preview?.pending_departures || []) await fd.post(`/api/reservations/${d.id}/check-out`);
  return ok(await admin.post('/api/night-audit'));
};
let amina; // a returning guest

before(async () => {
  await startTestServer({ distribution: true });
  setMailer(async (m) => { sent.push(m); return {}; });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['manager1', 'manager'], ['frontdesk', 'front_office'], ['accounts1', 'accountant']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  mgr = client(); await mgr.login('manager1', 'password-123');
  fd = client(); await fd.login('frontdesk', 'password-123');
  acc = client(); await acc.login('accounts1', 'password-123');
  web = client();
});
after(async () => { setMailer(null); await stopTestServer(); });

test('returning guests keep one profile; stays and spend add up; website consent is recorded', async () => {
  const w = ok(await web.post('/api/public/bookings', { arrival: DAY0, departure: '2026-11-11', adults: 1, room_type_id: 1, rate_plan_id: 1,
    guest: { first_name: 'Amina', last_name: 'Okello', email: 'Amina@Example.com', phone: '+256700111222', marketing_consent: true } }));
  const r1 = ok(await fd.get('/api/reservations?view=arrivals')).find((r) => r.code === w.code) || (await ctx.pool.query('SELECT * FROM reservations WHERE code=$1', [w.code])).rows[0];
  ok(await fd.post(`/api/reservations/${r1.id}/check-in`, { room_id: await roomId(fd, '101') }));
  ok(await fd.post(`/api/reservations/${r1.id}/charges`, { description: 'Dinner', department: 'fnb', amount: 90000 }));
  // a later booking by the front desk with the same email (different case) joins the same profile
  const r2 = ok(await book(fd, await typeId(fd, 'DLX'), '2026-11-20', '2026-11-22', 'Amina', { guest: { first_name: 'Amina', last_name: 'Okello', email: 'amina@example.com' } }));
  const ids = (await ctx.pool.query('SELECT DISTINCT guest_id FROM reservations WHERE id = ANY($1)', [[r1.id, r2.id]])).rows;
  assert.equal(ids.length, 1);
  amina = ids[0].guest_id;
  const p = ok(await fd.get(`/api/crm/guests/${amina}`));
  assert.equal(p.guest.marketing_consent, true);
  assert.equal(p.guest.consent_source, 'booking_engine');
  assert.equal(p.guest.stays, 1);
  assert.equal(p.stays.length, 2);
  assert.ok(p.guest.spend >= 90000);
  assert.equal(p.guest.next_arrival, '2026-11-20');
  // without the tick there is no consent
  ok(await web.post('/api/public/bookings', { arrival: '2026-12-01', departure: '2026-12-02', adults: 1, room_type_id: 1, rate_plan_id: 1, guest: { first_name: 'Ben', last_name: 'Kato', email: 'ben@example.com', phone: '1' } }));
  const ben = ok(await fd.get('/api/crm/guests?q=ben@example.com')).guests[0];
  assert.equal(ben.marketing_consent, false);
});

test('permissions', async () => {
  assert.equal((await acc.put(`/api/crm/guests/${amina}`, { first_name: 'X' })).status, 403);
  assert.equal((await fd.get('/api/crm/campaigns')).status, 403);
  assert.equal((await fd.post(`/api/crm/guests/${amina}/erase`)).status, 403);
  assert.equal((await fd.get('/api/crm/settings')).status, 403);
  ok(await acc.get('/api/crm/guests'));
});

test('profiles: edit, tags, VIP, consent and segments', async () => {
  assert.equal((await fd.put(`/api/crm/guests/${amina}`, { first_name: 'Amina', email: 'nope' })).status, 400);
  ok(await fd.put(`/api/crm/guests/${amina}`, { first_name: 'Amina', last_name: 'Okello', email: 'amina@example.com', phone: '+256700111222', nationality: 'Ugandan', birth_date: '1990-11-25',
    vip: true, tags: 'Corporate, honeymoon, corporate', preferences: 'High floor, feather-free pillows' }));
  const g = ok(await fd.get(`/api/crm/guests/${amina}`)).guest;
  assert.deepEqual(g.tags.sort(), ['corporate', 'honeymoon']);
  assert.equal(g.vip, true);
  const seg = async (qs) => ok(await mgr.get('/api/crm/guests?' + qs)).guests.map((x) => x.id);
  assert.ok((await seg('vip=yes')).includes(amina));
  assert.ok((await seg('tag=honeymoon')).includes(amina));
  assert.ok((await seg('birth_month=11')).includes(amina));
  assert.ok(!(await seg('min_stays=2')).includes(amina));
  assert.ok((await seg('consent=yes')).includes(amina));
  ok(await fd.post(`/api/crm/guests/${amina}/consent`, { consent: false }));
  assert.ok(!(await seg('consent=yes')).includes(amina));
  ok(await fd.post(`/api/crm/guests/${amina}/consent`, { consent: true }));
  assert.equal(ok(await fd.get(`/api/crm/guests/${amina}`)).guest.consent_source, 'front_desk');
});

test('campaigns reach only guests who agreed, carry an unsubscribe link, and are sent once', async () => {
  // a second consenting guest and one without consent
  for (const [f, e, c] of [['Grace', 'grace@example.com', true], ['Henry', 'henry@example.com', false]]) {
    const r = ok(await book(fd, await typeId(fd, 'STD'), '2026-12-05', '2026-12-06', f, { guest: { first_name: f, last_name: 'Test', email: e, marketing_consent: c } }));
    assert.ok(r.id);
  }
  const draft = { name: 'Festive offer', subject: 'A festive treat for you, {first_name}', body: 'Dear {first_name},\n\nStay two nights in December and the third is on us.\nBook: https://lakeview.example/book\n\n{property}', segment: {} };
  assert.equal((await mgr.post('/api/crm/campaigns', { ...draft, body: 'Hi {firstname}' })).status, 400); // typo in placeholder
  const c = ok(await mgr.post('/api/crm/campaigns', draft));
  const a = ok(await mgr.post('/api/crm/audience', { segment: {} }));
  assert.equal(a.recipients, 2); // Amina and Grace, not Ben or Henry
  assert.ok(a.matching >= 4);
  assert.equal((await mgr.post(`/api/crm/campaigns/${c.id}/send`)).status, 400); // no public address yet
  ok(await mgr.put('/api/crm/settings', { public_url: 'https://pms.lakeview.example/', review_url: 'https://g.page/r/lakeview/review' }));
  ok(await mgr.post(`/api/crm/campaigns/${c.id}/test`, { to: 'me@lakeview.example' }));
  const r = ok(await mgr.post(`/api/crm/campaigns/${c.id}/send`));
  assert.equal(r.recipients, 2);
  assert.equal((await mgr.post(`/api/crm/campaigns/${c.id}/send`)).status, 409);
  assert.equal((await mgr.put(`/api/crm/campaigns/${c.id}`, draft)).status, 409);
  await flush();
  const toAmina = sent.find((m) => m.to === 'amina@example.com');
  assert.equal(toAmina.subject, 'A festive treat for you, Amina');
  assert.match(toAmina.html, /<a href="https:\/\/lakeview\.example\/book"/);
  const link = /https:\/\/pms\.lakeview\.example\/unsubscribe\/\?t=([a-f0-9]{64})/.exec(toAmina.text);
  assert.ok(link, 'unsubscribe link');
  assert.ok(sent.find((m) => m.to === 'me@lakeview.example' && m.subject.startsWith('[TEST]')));
  assert.ok(!sent.find((m) => m.to === 'henry@example.com'));

  // the guest unsubscribes from the link (no sign-in)
  const info = ok(await web.get(`/api/marketing/unsubscribe/${link[1]}`));
  assert.equal(info.subscribed, true);
  assert.equal(info.email, 'a•••@example.com');
  ok(await web.post('/api/marketing/unsubscribe', { token: link[1] }));
  assert.equal(ok(await web.get(`/api/marketing/unsubscribe/${link[1]}`)).subscribed, false);
  assert.equal((await web.get('/api/marketing/unsubscribe/abc')).status, 404);
  const list = ok(await mgr.get('/api/crm/campaigns'));
  assert.equal(list[0].unsubscribed, 1);
  assert.equal(list[0].delivered, 2);
  assert.equal(ok(await mgr.post('/api/crm/audience', { segment: {} })).recipients, 1); // only Grace now
});

test('automatic pre-arrival and thank-you emails, once per stay', async () => {
  assert.equal((await mgr.put('/api/crm/templates/post_stay', { enabled: true, days: 1, subject: 'Thanks', body: 'Hi {name}' })).status, 400);
  const tpl = ok(await mgr.get('/api/crm/settings')).templates;
  const pre = tpl.find((t) => t.key === 'pre_arrival'), post = tpl.find((t) => t.key === 'post_stay');
  ok(await mgr.put('/api/crm/templates/pre_arrival', { ...pre, enabled: true, days: 2 }));
  ok(await mgr.put('/api/crm/templates/post_stay', { ...post, enabled: true, days: 1 }));
  const soon = ok(await book(fd, await typeId(fd, 'STD'), '2026-11-12', '2026-11-13', 'Ivy', { guest: { first_name: 'Ivy', last_name: 'Nambi', email: 'ivy@example.com' } }));
  const later = ok(await book(fd, await typeId(fd, 'STD'), '2026-11-30', '2026-12-01', 'Jo', { guest: { first_name: 'Jo', last_name: 'Mukasa', email: 'jo@example.com' } }));
  await flush(); await flush();
  const ivy = sent.filter((m) => m.to === 'ivy@example.com');
  assert.equal(ivy.length, 1);
  assert.match(ivy[0].subject, /See you soon at Test Hotel/);
  assert.match(ivy[0].text, /Thursday, 12 November 2026/);
  assert.match(ivy[0].text, new RegExp(soon.code));
  assert.ok(!sent.find((m) => m.to === 'jo@example.com'));
  assert.ok(later.id);

  // Amina checks out; after the audit closes the next day she gets the thank-you with the review link
  const stay = (await ctx.pool.query("SELECT id FROM reservations WHERE guest_id=$1 AND status='in_house'", [amina])).rows[0];
  ok(await fd.post(`/api/reservations/${stay.id}/payments`, { method: 'cash', amount: ok(await fd.get(`/api/reservations/${stay.id}`)).totals.balance }));
  ok(await fd.post(`/api/reservations/${stay.id}/check-out`));
  await audit(); // closes 10 Nov: Amina left 11 Nov
  await flush();
  // she unsubscribed in the campaign test, so the thank-you (which is promotional) is not sent
  assert.ok(!sent.find((m) => m.to === 'amina@example.com' && /Thank you for staying/.test(m.subject)));
  ok(await fd.post(`/api/crm/guests/${amina}/consent`, { consent: true }));
  await audit(); // closes 11 Nov
  const res = await flush();
  const thanks = sent.filter((m) => m.to === 'amina@example.com' && /Thank you for staying/.test(m.subject));
  assert.equal(thanks.length, 1, JSON.stringify(res));
  assert.match(thanks[0].text, /https:\/\/g\.page\/r\/lakeview\/review/);
  assert.match(thanks[0].text, /Unsubscribe: https:\/\/pms\.lakeview\.example\/unsubscribe\/\?t=/);
  await flush();
  assert.equal(sent.filter((m) => m.to === 'amina@example.com' && /Thank you for staying/.test(m.subject)).length, 1);
});

test('duplicates are merged; an unsubscribe on either profile wins', async () => {
  const a = ok(await book(fd, await typeId(fd, 'STD'), '2026-12-10', '2026-12-11', 'Kim', { guest: { first_name: 'Kim', last_name: 'Lubega', email: 'kim@work.example', phone: '+256 701 000 999', marketing_consent: true } }));
  const b = ok(await book(fd, await typeId(fd, 'STD'), '2026-12-15', '2026-12-16', 'Kim', { guest: { first_name: 'Kim', last_name: 'Lubega', email: 'kim@home.example', phone: '0701000999' } }));
  const [ga, gb] = await Promise.all([a, b].map(async (r) => (await ctx.pool.query('SELECT guest_id FROM reservations WHERE id=$1', [r.id])).rows[0].guest_id));
  assert.notEqual(ga, gb);
  ok(await fd.post(`/api/crm/guests/${gb}/consent`, { consent: false }));
  const p = ok(await fd.get(`/api/crm/guests/${ga}`));
  assert.ok(p.possible_duplicates.find((d) => d.id === gb));
  ok(await fd.post(`/api/crm/guests/${ga}/merge`, { duplicate_id: gb }));
  const after = ok(await fd.get(`/api/crm/guests/${ga}`));
  assert.equal(after.stays.length, 2);
  assert.equal(after.guest.marketing_consent, false);
  assert.ok(after.guest.unsubscribed_at);
  assert.equal(ok(await fd.get(`/api/crm/guests/${gb}`)).redirect, ga);
  assert.equal((await fd.post(`/api/crm/guests/${ga}/merge`, { duplicate_id: gb })).status, 404);
});

test('data protection: export and erase', async () => {
  const ben = ok(await mgr.get('/api/crm/guests?q=ben@example.com')).guests[0];
  assert.equal((await mgr.post(`/api/crm/guests/${ben.id}/erase`)).status, 409); // has an upcoming booking
  const grace = ok(await mgr.get('/api/crm/guests?q=grace@example.com')).guests[0];
  const ex = ok(await mgr.get(`/api/crm/guests/${grace.id}/export`));
  assert.equal(ex.profile.email, 'grace@example.com');
  await ctx.pool.query("UPDATE reservations SET status='cancelled' WHERE guest_id=$1", [grace.id]);
  ok(await mgr.post(`/api/crm/guests/${grace.id}/erase`));
  const g = ok(await mgr.get(`/api/crm/guests/${grace.id}`)).guest;
  assert.equal(g.first_name, 'Erased');
  assert.equal(g.email, null);
  assert.ok(!ok(await mgr.get('/api/crm/guests?q=grace')).guests.length);
  const box = (await ctx.pool.query('SELECT to_address, html FROM email_outbox WHERE guest_id=$1', [grace.id])).rows;
  assert.ok(box.length && box.every((m) => m.to_address === 'erased' && m.html === ''));
});
