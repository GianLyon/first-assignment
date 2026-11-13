// Phase 12: phone book and WhatsApp (real PostgreSQL; WhatsApp itself is a fake server or practice mode).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, DAY0, ctx } from './helpers.js';
import { tx } from '../src/db.js';
import { normalizePhone, runAutomations, deliverQueued } from '../src/services/whatsapp.js';

process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
const NOON = new Date('2026-11-10T09:00:00Z'); // 12:00 in Kampala
const NIGHT = new Date('2026-11-10T20:00:00Z'); // 23:00 in Kampala

let admin, mgr, fd, hk;
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(body).digest('hex');
async function webhook(payload, sig) {
  const body = JSON.stringify(payload);
  const res = await fetch(ctx.base + '/api/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig ?? sign(body) }, body });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const inbound = (from, text, id = crypto.randomUUID(), name = 'Guest') => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id: 'wamid.' + id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const receipt = (wamid, status) => ({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status, timestamp: '1', recipient_id: '1' }] } }] }] });
async function reserve(first, phone, arrival, departure, extra = {}) {
  return ok(await fd.post('/api/reservations', { room_type_id: await typeId(fd, 'STD'), arrival, departure, guest: { first_name: first, last_name: 'Test', phone, ...extra } }));
}

before(async () => {
  await startTestServer();
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['manager1', 'manager'], ['frontdesk', 'front_office'], ['hk1', 'housekeeping']]) ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  mgr = client(); await mgr.login('manager1', 'password-123');
  fd = client(); await fd.login('frontdesk', 'password-123');
  hk = client(); await hk.login('hk1', 'password-123');
});
after(async () => { for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_API_BASE']) delete process.env[k]; await stopTestServer(); });

test('phone numbers in any local or international form become one WhatsApp number', () => {
  assert.equal(normalizePhone('0772 123 456'), '256772123456');
  assert.equal(normalizePhone('+256 (772) 123-456'), '256772123456');
  assert.equal(normalizePhone('00256772123456'), '256772123456');
  assert.equal(normalizePhone('772123456'), '256772123456');
  assert.equal(normalizePhone('+44 7700 900123'), '447700900123');
  assert.equal(normalizePhone('0712 345678', '254'), '254712345678');
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone('call reception'), null);
});

test('phone book: guests and other contacts, search, and export for phones', async () => {
  await reserve('Grace', '0772 100 200', '2026-11-12', '2026-11-14', { email: 'grace@example.com' });
  ok(await fd.post('/api/messages/contacts', { name: 'Kato Taxi', company: 'Kato Rides', category: 'transport', phone: '0701 555 666', notes: 'Airport runs' }));
  assert.equal((await fd.post('/api/messages/contacts', { name: 'No number' })).status, 400);
  assert.equal((await fd.post('/api/messages/contacts', { name: 'Bad', phone: '12' })).status, 400);
  const all = ok(await fd.get('/api/messages/phonebook'));
  const grace = all.find((r) => r.name === 'Grace Test');
  assert.equal(grace.phone_intl, '+256772100200');
  assert.equal(grace.whatsapp, 'no');
  assert.ok(all.find((r) => r.type === 'contact' && r.name === 'Kato Taxi' && r.phone_intl === '+256701555666'));
  // search by name and by digits as typed on a local number
  assert.deepEqual(ok(await fd.get('/api/messages/phonebook?q=grace')).map((r) => r.name), ['Grace Test']);
  assert.deepEqual(ok(await fd.get('/api/messages/phonebook?q=0701%20555')).map((r) => r.name), ['Kato Taxi']);
  assert.deepEqual(ok(await fd.get('/api/messages/phonebook?kind=transport')).map((r) => r.name), ['Kato Taxi']);
  // vCard for phones
  const vcf = await fetch(ctx.base + '/api/messages/phonebook/export?format=vcf', { headers: { cookie: await cookieOf('frontdesk') } });
  assert.equal(vcf.headers.get('content-type').split(';')[0], 'text/vcard');
  const card = await vcf.text();
  assert.match(card, /BEGIN:VCARD\r\nVERSION:3\.0\r\nN:Test;Grace;;;\r\nFN:Grace Test \(Test Hotel guest\)/);
  assert.match(card, /TEL;TYPE=CELL:\+256772100200/);
  assert.match(card, /ORG:Kato Rides/);
  // CSV: a value starting with = cannot run as a spreadsheet formula
  ok(await fd.post('/api/messages/contacts', { name: '=HYPERLINK("x")', phone: '0701 000 111' }));
  const csv = await (await fetch(ctx.base + '/api/messages/phonebook/export?format=csv', { headers: { cookie: await cookieOf('frontdesk') } })).text();
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  // housekeeping has no phone book
  assert.equal((await hk.get('/api/messages/phonebook')).status, 403);
});

const cookies = {};
async function cookieOf(username) {
  if (cookies[username]) return cookies[username];
  const res = await fetch(ctx.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password-123' }) });
  return (cookies[username] = res.headers.get('set-cookie').split(';')[0]);
}

test('webhook: Meta verification, signatures, guest matching, the 24-hour window, receipts, STOP and START', async () => {
  // the one-time check when the webhook is connected in Meta's dashboard
  const v = await fetch(ctx.base + '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(v.status, 200); assert.equal(await v.text(), '12345');
  assert.equal((await fetch(ctx.base + '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  assert.equal((await webhook(inbound('256772100200', 'hi'), 'sha256=' + '0'.repeat(64))).status, 401);
  assert.equal((await webhook(inbound('256772100200', 'hi'), 'nonsense')).status, 401);

  // Grace (booked with 0772 100 200) writes in: the conversation is linked to her profile
  const first = inbound('256772100200', 'Hello, can I get an airport pickup?', 'g1', 'Grace T');
  assert.equal(ok(await webhook(first)).received, 1);
  assert.equal(ok(await webhook(first)).received, 0); // Meta retries are ignored
  const list = ok(await fd.get('/api/messages/conversations'));
  const conv = list.conversations.find((c) => c.wa_id === '256772100200');
  assert.equal(conv.display_name, 'Grace Test');
  assert.equal(conv.unread, 1);
  assert.equal(conv.window_open, true);
  assert.equal(ok(await fd.get('/api/messages/unread')).unread, 1);
  const open = ok(await fd.get(`/api/messages/conversations/${conv.id}`));
  assert.equal(open.messages.length, 1);
  assert.equal(open.guest.first_name, 'Grace');
  assert.equal(open.stays[0].status, 'reserved');
  assert.equal(ok(await fd.get('/api/messages/unread')).unread, 0);

  // inside the window, free text goes out (practice mode: kept here and marked delivered)
  const sent = ok(await fd.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'Of course! What time does your flight land?' }));
  assert.equal(sent.status, 'delivered');
  // receipts move forward only
  const { rows: [m] } = await ctx.pool.query('SELECT wa_message_id FROM wa_messages WHERE id=$1', [sent.id]);
  ok(await webhook(receipt(m.wa_message_id, 'read')));
  ok(await webhook(receipt(m.wa_message_id, 'delivered')));
  assert.equal((await ctx.pool.query('SELECT status FROM wa_messages WHERE id=$1', [sent.id])).rows[0].status, 'read');

  // 25 hours later the window has closed: only a template, and only with the guest's permission
  await ctx.pool.query("UPDATE wa_conversations SET last_inbound_at = now() - interval '25 hours' WHERE id=$1", [conv.id]);
  const closed = await fd.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'Are you still coming?' });
  assert.equal(closed.status, 409); assert.match(closed.data.error, /24 hours/);
  const tpl = ok(await fd.get(`/api/messages/conversations/${conv.id}`)).templates;
  assert.equal(tpl.length, 0); // none approved yet
  const setup = ok(await mgr.get('/api/messages/setup'));
  const pre = setup.templates.find((t) => t.name === 'pre_arrival');
  ok(await mgr.put(`/api/messages/templates/${pre.id}`, { ...pre, approved: true }));
  const t2 = ok(await fd.get(`/api/messages/conversations/${conv.id}`)).templates.find((t) => t.name === 'pre_arrival');
  assert.deepEqual(t2.values, ['Grace', 'Test Hotel', 'Thursday 12 November', '14:00']);
  const noPerm = await fd.post(`/api/messages/conversations/${conv.id}/messages`, { template_id: t2.id, params: t2.values });
  assert.equal(noPerm.status, 409); assert.match(noPerm.data.error, /not agreed/);
  const gid = open.guest.id;
  ok(await fd.put(`/api/messages/guests/${gid}/whatsapp`, { opt_in: true }));
  assert.equal((await fd.post(`/api/messages/conversations/${conv.id}/messages`, { template_id: t2.id, params: ['Grace', '', 'x', 'y'] })).status, 400);
  assert.equal((await fd.post(`/api/messages/conversations/${conv.id}/messages`, { template_id: t2.id, params: ['Grace'] })).status, 400);
  const ts = ok(await fd.post(`/api/messages/conversations/${conv.id}/messages`, { template_id: t2.id, params: t2.values }));
  assert.equal(ts.status, 'delivered');
  const body = (await ctx.pool.query('SELECT body FROM wa_messages WHERE id=$1', [ts.id])).rows[0].body;
  assert.match(body, /welcoming you to Test Hotel on Thursday 12 November\. Check-in is from 14:00/);

  // STOP: no more messages, a confirmation goes out, the profile records it
  ok(await webhook(inbound('256772100200', 'STOP', 'g2')));
  await deliverQueued(ctx.pool);
  const after = ok(await fd.get(`/api/messages/conversations/${conv.id}`));
  assert.ok(after.conversation.opted_out_at);
  assert.match(after.messages.at(-1).body, /You will not receive any more WhatsApp messages from Test Hotel/);
  assert.equal(after.guest.whatsapp_opt_in, false);
  assert.equal((await fd.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'ok' })).status, 409);
  ok(await webhook(inbound('256772100200', 'start', 'g3')));
  assert.equal(ok(await fd.get(`/api/messages/conversations/${conv.id}`)).guest.whatsapp_opt_in, true);
  ok(await fd.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'Welcome back!' }));

  // an unknown number starts its own conversation; staff can also start one from the phone book
  ok(await webhook(inbound('447700900123', 'Do you have rooms on Friday?', 'u1', 'Oliver')));
  const o = ok(await fd.get('/api/messages/conversations?q=oliver')).conversations;
  assert.equal(o.length, 1); assert.equal(o[0].guest_id, null); assert.equal(o[0].display_name, 'Oliver');
  const k = ok(await fd.post('/api/messages/conversations', { phone: '+254 712 345678' }));
  assert.ok(k.id);
  assert.equal((await fd.post('/api/messages/conversations', { phone: '123' })).status, 400);
  // practice replies stand in for a guest while learning
  ok(await fd.post(`/api/messages/conversations/${k.id}/practice-reply`, { text: 'Thank you' }));
  assert.equal(ok(await fd.get(`/api/messages/conversations/${k.id}`)).conversation.window_open, true);
});

test('automations: opted-in guests only, once per stay, never in quiet hours, and only with approved templates', async () => {
  const setup = ok(await mgr.get('/api/messages/setup'));
  const auto = setup.automations.find((a) => a.trigger === 'pre_arrival');
  const welcome = setup.automations.find((a) => a.trigger === 'arrival_day');
  const wt = setup.templates.find((t) => t.id === welcome.template_id);
  const no = await mgr.put(`/api/messages/automations/${welcome.id}`, { ...welcome, enabled: true });
  assert.equal(no.status, 400); assert.match(no.data.error, /approved/);
  ok(await mgr.put(`/api/messages/templates/${wt.id}`, { ...wt, approved: true }));
  ok(await mgr.put(`/api/messages/automations/${auto.id}`, { ...auto, enabled: true, days: 2 }));
  ok(await mgr.put(`/api/messages/automations/${welcome.id}`, { ...welcome, enabled: true }));
  assert.equal((await fd.put(`/api/messages/automations/${auto.id}`, { ...auto, enabled: false })).status, 403);

  // three guests arriving within two days: one agreed to WhatsApp, one did not, one has no phone
  const yes = await reserve('Moses', '0752 000 111', '2026-11-11', '2026-11-13');
  await reserve('Ruth', '0752 000 222', '2026-11-11', '2026-11-13');
  await reserve('Isaac', null, '2026-11-12', '2026-11-13');
  ok(await fd.put(`/api/reservations/${yes.id}/registration`, { guest: { first_name: 'Moses', last_name: 'Test', phone: '0752 000 111', whatsapp_opt_in: true }, stay: {} }));
  // in quiet hours nothing happens
  assert.equal((await tx(ctx.pool, (db) => runAutomations(db, { now: NIGHT }))).queued, 0);
  const r1 = await tx(ctx.pool, (db) => runAutomations(db, { now: NOON }));
  // Grace (opted in again after START) and Moses get it; Ruth and Isaac are skipped with a reason
  assert.equal(r1.queued, 2);
  assert.equal(r1.skipped, 2);
  assert.equal((await tx(ctx.pool, (db) => runAutomations(db, { now: NOON }))).queued, 0); // once per stay
  await deliverQueued(ctx.pool);
  const { rows } = await ctx.pool.query(`SELECT m.body, m.status, c.wa_id FROM wa_messages m JOIN wa_conversations c ON c.id=m.conversation_id WHERE m.automation_id=$1 ORDER BY c.wa_id`, [auto.id]);
  assert.deepEqual(rows.map((r) => [r.wa_id, r.status]), [['256752000111', 'delivered'], ['256772100200', 'delivered']]);
  assert.match(rows[0].body, /Hello Moses, we look forward to welcoming you to Test Hotel on Wednesday 11 November/);
  const stats = ok(await mgr.get('/api/messages/setup')).stats[auto.id];
  assert.equal(stats.sent, 2); assert.equal(stats.skipped, 2);
  assert.deepEqual(stats.reasons.map((x) => x.reason).sort(), ['Guest has not agreed to WhatsApp messages', 'No usable phone number']);

  // the welcome goes after check-in, with the room number
  const today = await reserve('Agnes', '0752 000 333', DAY0, '2026-11-12');
  ok(await fd.post(`/api/reservations/${today.id}/check-in`, { room_id: await roomId(fd, '105'), guest: { whatsapp_opt_in: true } }));
  assert.equal((await tx(ctx.pool, (db) => runAutomations(db, { now: NOON }))).queued, 1);
  await deliverQueued(ctx.pool);
  const w = (await ctx.pool.query('SELECT body FROM wa_messages WHERE automation_id=$1', [welcome.id])).rows;
  assert.deepEqual(w.map((x) => x.body), ['Welcome to Test Hotel, Agnes! You are in room 105. This is the front desk on WhatsApp: message us any time for housekeeping, room service or help.']);
  // a manual run from the set-up page works too (nothing new is due)
  assert.equal(ok(await mgr.post('/api/messages/automations/run')).queued, 0);
});

test('live mode: messages go to the WhatsApp Cloud API with the right shape; refusals are shown', async () => {
  const calls = [];
  let fail = false;
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      if (fail) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: '(#131047) Re-engagement message', code: 131047, error_data: { details: 'More than 24 hours have passed since the customer last replied.' } } })); return; }
      res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: '1', wa_id: '1' }], messages: [{ id: 'wamid.live' + calls.length }] }));
    });
  }).listen(0);
  Object.assign(process.env, { WHATSAPP_TOKEN: 'tok-123', WHATSAPP_PHONE_NUMBER_ID: '1098765', WHATSAPP_API_BASE: `http://127.0.0.1:${fake.address().port}` });
  try {
    assert.equal(ok(await mgr.get('/api/messages/setup')).mode, 'live');
    const conv = ok(await fd.get('/api/messages/conversations?q=256772100200')).conversations[0];
    await ctx.pool.query('UPDATE wa_conversations SET last_inbound_at=now() WHERE id=$1', [conv.id]);
    const s = ok(await fd.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'Your driver is waiting at arrivals.' }));
    assert.equal(s.status, 'sent');
    assert.equal(calls[0].url, '/v25.0/1098765/messages');
    assert.equal(calls[0].auth, 'Bearer tok-123');
    assert.deepEqual(calls[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '256772100200', type: 'text', text: { preview_url: true, body: 'Your driver is waiting at arrivals.' } });
    const t = ok(await fd.get(`/api/messages/conversations/${conv.id}`)).templates.find((x) => x.name === 'pre_arrival');
    ok(await fd.post(`/api/messages/conversations/${conv.id}/messages`, { template_id: t.id, params: t.values }));
    assert.deepEqual(calls[1].body.template, { name: 'pre_arrival', language: { code: 'en' }, components: [{ type: 'body', parameters: t.values.map((text) => ({ type: 'text', text })) }] });
    fail = true;
    const bad = await fd.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'Hello?' });
    assert.equal(bad.status, 502); assert.match(bad.data.error, /More than 24 hours/);
    // the error stays on the message for the team to see
    assert.equal(ok(await fd.get(`/api/messages/conversations/${conv.id}`)).messages.at(-1).status, 'failed');
  } finally { fake.close(); for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_API_BASE']) delete process.env[k]; }
});
