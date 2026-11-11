// Phase 4: rate plans, rate calendar, website booking engine and channel manager (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, DAY0 } from './helpers.js';

let admin, fd, guest, hookServer, hookUrl;
const hooks = []; let hookStatus = 200;
const sig = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const plan = (q, typeCode, planCode) => q.room_types.find((t) => t.room_type.code === typeCode).plans.find((p) => p.code === planCode);

before(async () => {
  await startTestServer({ distribution: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  ok(await admin.post('/api/users', { username: 'frontdesk', full_name: 'FD', role: 'front_office', password: 'password-123' }));
  fd = client(); await fd.login('frontdesk', 'password-123');
  guest = client(); // not signed in
  hookServer = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hooks.push({ headers: req.headers, body: b }); res.writeHead(hookStatus); res.end('{}'); }); }).listen(0);
  hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;
});
after(async () => { hookServer?.close(); await stopTestServer(); });

test('prices: plans, calendar overrides, minimum stay and stop-sell', async () => {
  let q = ok(await guest.get(`/api/public/availability?arrival=${DAY0}&departure=2026-11-12&adults=2`));
  assert.equal(q.nights, 2);
  assert.equal(plan(q, 'DLX', 'BAR').total, 700000);
  assert.equal(plan(q, 'DLX', 'NRF').total, 630000); // 10% off
  assert.equal(plan(q, 'DLX', 'LONG').bookable, false); assert.match(plan(q, 'DLX', 'LONG').reason, /Minimum stay 3/);
  assert.equal((await fd.put('/api/distribution/calendar', { room_type_ids: [1], from: DAY0, to: DAY0, rate: 1 })).status, 403);
  const dlx = await typeId(admin, 'DLX'), ste = await typeId(admin, 'STE');
  ok(await admin.put('/api/distribution/calendar', { room_type_ids: [dlx], from: '2026-11-11', to: '2026-11-11', rate: 400000 }));
  ok(await admin.put('/api/distribution/calendar', { room_type_ids: [ste], from: '2026-11-20', to: '2026-11-21', stop_sell: true }));
  ok(await admin.put('/api/distribution/calendar', { room_type_ids: [dlx], from: '2026-11-25', to: '2026-11-25', min_stay: 2 }));
  q = ok(await guest.get(`/api/public/availability?arrival=${DAY0}&departure=2026-11-12&adults=2`));
  assert.equal(plan(q, 'DLX', 'BAR').total, 350000 + 400000);
  assert.deepEqual(plan(q, 'DLX', 'NRF').nightly.map((n) => n.rate), [315000, 360000]);
  q = ok(await guest.get('/api/public/availability?arrival=2026-11-19&departure=2026-11-21&adults=2'));
  assert.equal(plan(q, 'STE', 'BAR').bookable, false); assert.match(plan(q, 'STE', 'BAR').reason, /Not available/);
  q = ok(await guest.get('/api/public/availability?arrival=2026-11-25&departure=2026-11-26&adults=2'));
  assert.match(plan(q, 'DLX', 'BAR').reason, /Minimum stay 2/);
  q = ok(await guest.get(`/api/public/availability?arrival=${DAY0}&departure=2026-11-11&adults=4`));
  assert.match(plan(q, 'DLX', 'BAR').reason, /Up to 2 guests/);
  assert.equal((await guest.get('/api/public/availability?arrival=2026-11-01&departure=2026-11-02')).status, 400);
  const cal = ok(await fd.get('/api/distribution/calendar?from=2026-11-10&days=3'));
  assert.equal(cal.find((t) => t.code === 'DLX').nights[1].rate, 400000);
});

let webBooking;
test('website booking engine: book, look up, cancel within the rules', async () => {
  const book = (extra = {}) => guest.post('/api/public/bookings', { arrival: DAY0, departure: '2026-11-12', adults: 2, room_type_id: 2, rate_plan_id: 1,
    guest: { first_name: 'Amina', last_name: 'Nakato', email: 'amina@example.com', phone: '+256700111222' }, ...extra });
  assert.equal((await book({ website: 'http://spam' })).status, 400); // honeypot
  assert.equal((await book({ guest: { first_name: 'A', last_name: 'B', email: 'not-an-email', phone: '1' } })).status, 400);
  webBooking = ok(await book());
  assert.match(webBooking.code, /^R\d+$/); assert.equal(webBooking.total, 750000); assert.equal(webBooking.rate_plan, 'Best available rate');
  const res = ok(await fd.get('/api/reservations?view=arrivals')).find((r) => r.code === webBooking.code);
  assert.equal(res.source, 'Website');
  assert.equal((await guest.post('/api/public/bookings/lookup', { code: webBooking.code, email: 'wrong@example.com' })).status, 404);
  const look = ok(await guest.post('/api/public/bookings/lookup', { code: webBooking.code.toLowerCase(), email: 'AMINA@example.com' }));
  assert.equal(look.total, 750000);
  assert.equal(look.can_cancel, false); // arrival is today: cancel with the hotel
  assert.equal((await guest.post('/api/public/bookings/cancel', { code: webBooking.code, email: 'amina@example.com' })).status, 409);
  // future flexible booking can be cancelled online; non-refundable cannot
  const flex = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-01', departure: '2026-12-03', adults: 1, room_type_id: 1, rate_plan_id: 1, guest: { first_name: 'Tom', last_name: 'Baker', email: 'tom@example.com', phone: '123' } }));
  ok(await guest.post('/api/public/bookings/cancel', { code: flex.code, email: 'tom@example.com' }));
  const nrf = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-01', departure: '2026-12-03', adults: 1, room_type_id: 1, rate_plan_id: 2, guest: { first_name: 'Lea', last_name: 'Ross', email: 'lea@example.com', phone: '123' } }));
  const c = await guest.post('/api/public/bookings/cancel', { code: nrf.code, email: 'lea@example.com' });
  assert.equal(c.status, 409); assert.match(c.data.error, /non-refundable/);
  // booking engine switched off
  const s = ok(await admin.get('/api/settings'));
  ok(await admin.put('/api/distribution/booking-settings', { booking_enabled: false, booking_intro: s.booking_intro, cancellation_policy: s.cancellation_policy, check_in_time: '14:00', check_out_time: '11:00', booking_horizon_days: 365 }));
  assert.equal((await book()).status, 403);
  ok(await admin.put('/api/distribution/booking-settings', { booking_enabled: true, booking_intro: 'Welcome', cancellation_policy: s.cancellation_policy, check_in_time: '14:00', check_out_time: '11:00', booking_horizon_days: 365, contact_phone: '+256 787 000 000' }));
  assert.equal(ok(await guest.get('/api/public/info')).contact_phone, '+256 787 000 000');
});

test('two guests cannot both book the last suite online', async () => {
  const b = (n) => guest.post('/api/public/bookings', { arrival: '2026-12-10', departure: '2026-12-11', adults: 2, room_type_id: 3, rate_plan_id: 1, guest: { first_name: 'G' + n, last_name: 'X', email: `g${n}@example.com`, phone: '1' } });
  for (let i = 0; i < 3; i++) ok(await b(i));
  const [x, y] = await Promise.all([b(8), b(9)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
});

test('night audit charges each night at the price that was booked', async () => {
  ok(await fd.post(`/api/reservations/${(ok(await fd.get('/api/reservations?view=arrivals')).find((r) => r.code === webBooking.code)).id}/check-in`, { room_id: await roomId(fd, '201') }));
  ok(await admin.post('/api/night-audit'));
  ok(await admin.post('/api/night-audit'));
  const id = ok(await fd.get('/api/reservations?view=inhouse')).find((r) => r.code === webBooking.code).id;
  const f = ok(await fd.get(`/api/reservations/${id}`));
  assert.deepEqual(f.charges.filter((c) => c.department === 'rooms').map((c) => c.amount), [350000, 400000]);
});

let hookChannel;
test('channel manager pushes signed availability and rates; failures are recorded', async () => {
  assert.equal((await fd.get('/api/distribution/channels')).status, 403);
  let ch = ok(await admin.get('/api/distribution/channels'));
  assert.ok(ch.pending_changes > 0);
  assert.ok(ch.channels.every((c) => !('secret' in c)));
  // built-in simulator
  const sync = ok(await admin.post('/api/distribution/sync'));
  assert.ok(sync.results.find((r) => r.channel === 'simulator').pushed > 0);
  assert.equal(ok(await admin.get('/api/distribution/channels')).pending_changes, 0);
  // webhook channel to a provider endpoint
  assert.equal((await admin.post('/api/distribution/channels', { code: 'prov', name: 'Provider', adapter: 'webhook', endpoint_url: 'ftp://x' })).status, 400);
  hookChannel = ok(await admin.post('/api/distribution/channels', { code: 'provider', name: 'Booking.com (via provider)', adapter: 'webhook', endpoint_url: hookUrl, commission_pct: 15 }));
  assert.ok(hookChannel.secret.length > 20);
  const dlx = await typeId(admin, 'DLX'), ste = await typeId(admin, 'STE');
  ok(await admin.put(`/api/distribution/channels/${hookChannel.id}/mappings`, { mappings: [{ room_type_id: dlx, rate_plan_id: 1, external_room_code: 'DBL-DLX', external_rate_code: 'FLEX' }, { room_type_id: ste, rate_plan_id: 1, external_room_code: 'STE', external_rate_code: 'FLEX' }] }));
  ok(await admin.post(`/api/distribution/channels/${hookChannel.id}/full-sync`, { days: 60 }));
  const h = hooks.at(-1);
  assert.equal(h.headers['x-hk-signature'], sig(hookChannel.secret, h.body));
  const msg = JSON.parse(h.body);
  assert.equal(msg.event, 'ari.full_sync'); assert.equal(msg.currency, 'UGX');
  const d1213 = msg.items.find((i) => i.room_code === 'DBL-DLX' && i.date === '2026-12-13');
  assert.equal(d1213.rate, 350000); assert.equal(d1213.available, 10);
  assert.equal(msg.items.find((i) => i.room_code === 'STE' && i.date === '2026-11-20').closed, true); // stop-sell
  assert.equal(msg.items.find((i) => i.room_code === 'STE' && i.date === '2026-12-10').available, 0); // sold out
  // a change goes out automatically on the next sync
  hooks.length = 0;
  ok(await admin.put('/api/distribution/calendar', { room_type_ids: [dlx], from: '2026-12-24', to: '2026-12-26', rate: 500000 }));
  ok(await admin.post('/api/distribution/sync'));
  const upd = JSON.parse(hooks.at(-1).body);
  assert.equal(upd.event, 'ari.update');
  assert.ok(upd.items.every((i) => i.room_code === 'DBL-DLX' && i.date >= '2026-12-24' && i.date <= '2026-12-26'));
  assert.equal(upd.items.find((i) => i.date === '2026-12-25').rate, 500000);
  // provider down: recorded on the channel and in its log
  hookStatus = 503;
  const fail = ok(await admin.post(`/api/distribution/channels/${hookChannel.id}/full-sync`, { days: 3 }));
  assert.match(fail.error, /503/);
  ch = ok(await admin.get('/api/distribution/channels'));
  assert.match(ch.channels.find((c) => c.code === 'provider').last_error, /503/);
  const log = ok(await admin.get(`/api/distribution/channels/${hookChannel.id}/log`));
  assert.equal(log[0].status, 'error');
  hookStatus = 200;
});

test('signed OTA bookings: create, duplicate, modify, cancel, overbooking, bad signatures', async () => {
  const send = async (payload, secret = hookChannel.secret) => {
    const body = JSON.stringify(payload);
    return guest.post('/api/channels/provider/inbound', body, { raw: true, headers: { 'content-type': 'application/json', 'x-hk-signature': sig(secret, body) } });
  };
  const booking = { id: 'BDC-778899', room_code: 'DBL-DLX', rate_code: 'FLEX', arrival: '2026-12-20', departure: '2026-12-23', adults: 2,
    guest: { first_name: 'Hans', last_name: 'Weber', email: 'hans@example.de' }, nightly: [{ date: '2026-12-20', rate: 380000 }, { date: '2026-12-21', rate: 380000 }, { date: '2026-12-22', rate: 390000 }] };
  assert.equal((await send({ event: 'booking.created', booking }, 'wrong-secret')).status, 401);
  const created = ok(await send({ event: 'booking.created', booking }));
  assert.equal(created.status, 'reserved'); assert.equal(created.overbooked, false);
  const dup = ok(await send({ event: 'booking.created', booking }));
  assert.equal(dup.reservation_code, created.reservation_code); assert.equal(dup.duplicate, true);
  let r = ok(await fd.get('/api/reservations?view=upcoming')).find((x) => x.code === created.reservation_code);
  assert.equal(r.source, 'Booking.com (via provider)');
  assert.equal((await send({ event: 'booking.created', booking: { ...booking, id: 'X1', room_code: 'NOPE' } })).status, 422);
  // modification: one night shorter
  ok(await send({ event: 'booking.modified', booking: { ...booking, departure: '2026-12-22', nightly: booking.nightly.slice(0, 2) } }));
  r = ok(await fd.get('/api/reservations?view=upcoming')).find((x) => x.code === created.reservation_code);
  assert.equal(r.departure, '2026-12-22');
  // cancellation
  ok(await send({ event: 'booking.cancelled', booking: { id: 'BDC-778899' } }));
  r = ok(await fd.get('/api/reservations?view=past')).find((x) => x.code === created.reservation_code);
  assert.equal(r.status, 'cancelled');
  // the suite is sold out on 10 Dec, but an OTA booking is still accepted and flagged
  const over = ok(await send({ event: 'booking.created', booking: { id: 'BDC-OVER', room_code: 'STE', rate_code: 'FLEX', arrival: '2026-12-10', departure: '2026-12-11', adults: 2, guest: { first_name: 'Over', last_name: 'Booked' } } }));
  assert.equal(over.overbooked, true);
  const log = ok(await admin.get(`/api/distribution/channels/${hookChannel.id}/log`));
  assert.ok(log.some((l) => l.direction === 'in' && l.status === 'error' && /signature/i.test(l.summary)));
  assert.ok(log.some((l) => /OVERBOOKED/.test(l.summary || '')));
  // simulator test booking goes through the same signed path
  const sim = ok(await admin.get('/api/distribution/channels')).channels.find((c) => c.code === 'simulator');
  const t = ok(await admin.post(`/api/distribution/channels/${sim.id}/test-booking`, { arrival: '2026-12-05', departure: '2026-12-06' }));
  assert.match(t.reservation_code, /^R\d+/);
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
});

test('public booking requests are rate limited per visitor', async () => {
  const { createApp } = await import('../src/app.js');
  const { ctx } = await import('./helpers.js');
  process.env.PUBLIC_WRITE_LIMIT = '3';
  const srv = createApp(ctx.pool).listen(0);
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/public/bookings/lookup`;
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"R1","email":"a@b.c"}' })).status);
    assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
  } finally { srv.close(); process.env.PUBLIC_WRITE_LIMIT = '1000'; }
});
