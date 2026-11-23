// Phase 18: website booking widget, Pesapal online payments, OTA virtual cards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, stopTestServer, client, ok, ctx, typeId, roomId, book, DAY0 } from './helpers.js';
import { paymentHousekeeping } from '../src/services/onlinepay.js';
import { cardFacts, withoutCard, saveCard } from '../src/services/otacards.js';

/* ---------- a stand-in for Pesapal's API 3.0 ---------- */
const fake = { orders: new Map(), calls: [], status: {} };
let fakeServer;
function startFake() {
  fakeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = new URL(req.url, 'http://x'), b = body ? JSON.parse(body) : {};
      fake.calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/api/Auth/RequestToken') return b.consumer_key === 'key-1' && b.consumer_secret === 'secret-1'
        ? send({ token: 'tok-abc', expiryDate: new Date(Date.now() + 5 * 60e3).toISOString(), status: '200' }) : send({ error: { code: 'invalid_consumer_key_or_secret_provided', message: 'Invalid key' }, status: '500' });
      if (req.headers.authorization !== 'Bearer tok-abc') return send({ error: { message: 'Unauthorized' } }, 401);
      if (url.pathname === '/api/URLSetup/GetIpnList') return send([]);
      if (url.pathname === '/api/URLSetup/RegisterIPN') { fake.ipnUrl = b.url; fake.ipnType = b.ipn_notification_type; return send({ url: b.url, ipn_id: 'ipn-777', status: '200' }); }
      if (url.pathname === '/api/Transactions/SubmitOrderRequest') {
        assert.equal(b.notification_id, 'ipn-777');
        const id = `track-${fake.orders.size + 1}`; fake.orders.set(id, b);
        return send({ order_tracking_id: id, merchant_reference: b.id, redirect_url: `https://cybqa.pesapal.com/iframe/${id}`, status: '200' });
      }
      if (url.pathname === '/api/Transactions/GetTransactionStatus') {
        const id = url.searchParams.get('orderTrackingId'), o = fake.orders.get(id), st = fake.status[id] || { status_code: 0, payment_status_description: 'INVALID' };
        return send({ payment_method: st.payment_method || '', amount: st.amount ?? o.amount, currency: st.currency || o.currency, confirmation_code: st.code || '', merchant_reference: o.id, status: '200', ...st });
      }
      send({ error: { message: 'not found' } }, 404);
    });
  }).listen(0);
  return `http://127.0.0.1:${fakeServer.address().port}`;
}

before(async () => {
  Object.assign(process.env, { PESAPAL_BASE: startFake(), PESAPAL_CONSUMER_KEY: 'key-1', PESAPAL_CONSUMER_SECRET: 'secret-1', PUBLIC_URL: 'https://hotel.example.com' });
  await startTestServer({ distribution: true });
});
after(async () => { fakeServer.close(); for (const k of ['PESAPAL_BASE', 'PESAPAL_CONSUMER_KEY', 'PESAPAL_CONSUMER_SECRET', 'PUBLIC_URL']) delete process.env[k]; await stopTestServer(); });

const trial = async (c) => { const tb = ok(await c.get('/api/accounts/trial-balance')); assert.equal(tb.total_debit, tb.total_credit); };

test('the website widget sends guests to the booking page with their dates, and the booking remembers the site', async () => {
  const js = await fetch(ctx.base + '/book/widget.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /azeli-booking/);
  const guest = client();
  const b = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-01', departure: '2026-12-03', adults: 2, room_type_id: 1, rate_plan_id: 1, src: 'www.amayahotel.com',
    guest: { first_name: 'Web', last_name: 'Guest', email: 'web@example.com', phone: '+256700100200' } }));
  assert.equal(b.pay_required, false);
  const { rows: [r] } = await ctx.pool.query('SELECT booked_from, pay_by FROM reservations WHERE code=$1', [b.code]);
  assert.equal(r.booked_from, 'www.amayahotel.com'); assert.equal(r.pay_by, null);
  // anything that is not a plain host name is ignored
  const b2 = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-01', departure: '2026-12-02', adults: 1, room_type_id: 1, rate_plan_id: 1, src: '<script>',
    guest: { first_name: 'Web', last_name: 'Two', email: 'web2@example.com', phone: '1' } }));
  assert.equal((await ctx.pool.query('SELECT booked_from FROM reservations WHERE code=$1', [b2.code])).rows[0].booked_from, null);
  // the hotel's colour reaches the booking page
  const admin = client(); await admin.login('admin', 'admin-pass-123');
  const s = ok(await admin.get('/api/settings'));
  ok(await admin.put('/api/distribution/booking-settings', { booking_enabled: true, booking_intro: s.booking_intro, cancellation_policy: s.cancellation_policy, check_in_time: '14:00', check_out_time: '10:00', booking_horizon_days: 365, booking_accent: '#8a1c2b' }));
  assert.equal(ok(await guest.get('/api/public/info')).accent, '#8a1c2b');
});

test('Pesapal: pay at booking, confirmed only after asking Pesapal, unpaid rooms released', async () => {
  const admin = client(); await admin.login('admin', 'admin-pass-123');
  const guest = client();
  // keys missing → cannot switch on
  process.env.PESAPAL_CONSUMER_KEY = '';
  assert.equal((await admin.put('/api/finance/online-payments', { enabled: true, provider: 'pesapal', mode: 'required', hold_minutes: 30 })).status, 400);
  process.env.PESAPAL_CONSUMER_KEY = 'key-1';
  ok(await admin.put('/api/finance/online-payments', { enabled: true, provider: 'pesapal', mode: 'required', hold_minutes: 30 }));
  const info = ok(await guest.get('/api/public/info'));
  assert.equal(info.payment_mode, 'required'); assert.equal(info.online_payments, true);

  // booking a non-refundable rate: straight to Pesapal for the full amount
  const b = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-10', departure: '2026-12-12', adults: 1, room_type_id: 1, rate_plan_id: 2,
    guest: { first_name: 'Nora', last_name: 'Kato', email: 'nora@example.com', phone: '+256772000111' } }));
  assert.equal(b.pay_required, true);
  assert.match(b.payment.checkout_url, /^https:\/\/cybqa\.pesapal\.com\/iframe\/track-1$/);
  assert.equal(b.payment.amount, 450000);
  const order = fake.orders.get('track-1');
  assert.equal(order.currency, 'UGX'); assert.equal(order.amount, 450000);
  assert.equal(order.billing_address.country_code, 'UG'); assert.equal(order.billing_address.email_address, 'nora@example.com');
  assert.match(order.callback_url, /^https:\/\/hotel\.example\.com\/pay\/return\.html\?t=/);
  assert.equal(fake.ipnUrl, 'https://hotel.example.com/api/payments/pesapal/ipn'); assert.equal(fake.ipnType, 'GET');
  const token = order.id;
  const { rows: [r1] } = await ctx.pool.query('SELECT id, pay_by FROM reservations WHERE code=$1', [b.code]);
  assert.ok(r1.pay_by > new Date());

  // a notification is never trusted on its own: Pesapal still says "not paid"
  const ipn = (id, ref) => fetch(`${ctx.base}/api/payments/pesapal/ipn?OrderTrackingId=${id}&OrderMerchantReference=${ref}&OrderNotificationType=IPNCHANGE`).then((r) => r.json());
  assert.deepEqual(await ipn('track-1', token), { orderNotificationType: 'IPNCHANGE', orderTrackingId: 'track-1', orderMerchantReference: token, status: 200 });
  assert.equal(ok(await guest.get(`/api/public/pay/${token}`)).status, 'pending');

  // Pesapal says completed (paid by MTN mobile money): recorded once
  fake.status['track-1'] = { status_code: 1, payment_status_description: 'Completed', payment_method: 'MTN UG', code: 'MTN123' };
  await ipn('track-1', token);
  await ipn('track-1', token);
  assert.equal(ok(await guest.get(`/api/public/pay/${token}/status`)).status, 'paid');
  const { rows: pays } = await ctx.pool.query('SELECT method, amount FROM payments WHERE reservation_id=$1', [r1.id]);
  assert.deepEqual(pays.map((p) => [p.method, Number(p.amount)]), [['mobile_money', 450000]]);
  assert.equal((await ctx.pool.query('SELECT pay_by FROM reservations WHERE id=$1', [r1.id])).rows[0].pay_by, null);

  // a reported amount that does not match is refused, not recorded
  const b2 = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-14', departure: '2026-12-16', adults: 1, room_type_id: 1, rate_plan_id: 2,
    guest: { first_name: 'Sam', last_name: 'Odongo', email: 'sam@example.com', phone: '+256772000222' } }));
  const t2 = fake.orders.get('track-2').id;
  fake.status['track-2'] = { status_code: 1, payment_status_description: 'Completed', payment_method: 'Visa', amount: 1000 };
  const st = ok(await guest.get(`/api/public/pay/${t2}/status`));
  assert.equal(st.status, 'failed');
  const { rows: [r2] } = await ctx.pool.query('SELECT id FROM reservations WHERE code=$1', [b2.code]);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM payments WHERE reservation_id=$1', [r2.id])).rows[0].n, 0);

  // not paid in time: the room is released (only once the last payment attempt is old or failed)
  await ctx.pool.query("UPDATE reservations SET pay_by=now() - interval '1 minute' WHERE id=$1", [r2.id]);
  const hk = await paymentHousekeeping(ctx.pool);
  assert.equal(hk.released, 1);
  assert.equal((await ctx.pool.query('SELECT status FROM reservations WHERE id=$1', [r2.id])).rows[0].status, 'cancelled');

  // a guest still on the payment page keeps the room; the regular check picks up a payment the notification missed
  const b3 = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-18', departure: '2026-12-19', adults: 1, room_type_id: 1, rate_plan_id: 1,
    guest: { first_name: 'Ivy', last_name: 'Nambi', email: 'ivy@example.com', phone: '+256772000333' } }));
  const { rows: [r3] } = await ctx.pool.query('SELECT id FROM reservations WHERE code=$1', [b3.code]);
  await ctx.pool.query("UPDATE reservations SET pay_by=now() - interval '1 minute' WHERE id=$1", [r3.id]);
  assert.equal((await paymentHousekeeping(ctx.pool)).released, 0);
  fake.status['track-3'] = { status_code: 1, payment_status_description: 'Completed', payment_method: 'MasterCard' };
  await ctx.pool.query("UPDATE payment_intents SET created_at=now() - interval '5 minutes' WHERE provider_ref='track-3'");
  assert.equal((await paymentHousekeeping(ctx.pool)).checked, 1);
  const { rows: [p3] } = await ctx.pool.query('SELECT method, amount FROM payments WHERE reservation_id=$1', [r3.id]);
  assert.equal(p3.method, 'card'); assert.equal(Number(p3.amount), 250000); // flexible rate: the first night
  assert.equal((await ctx.pool.query('SELECT status FROM reservations WHERE id=$1', [r3.id])).rows[0].status, 'reserved');

  // staff see the payments
  const op = ok(await admin.get('/api/finance/online-payments'));
  assert.equal(op.recent.filter((x) => x.provider === 'pesapal').length, 3);
  await trial(admin);
});

test('OTA virtual cards: only safe facts are kept; charging closes the bill, with the OTA commission settled', async () => {
  // what arrives from the channel manager
  const attrs = { payment_collect: 'ota', payment_type: 'credit_card', ota_name: 'Expedia', ota_reservation_code: 'EX991',
    guarantee: { card_number: '5555 4444 3333 1111', cvv: '123', card_type: 'mastercard', cardholder_name: 'Expedia VCC', expiration_date: '11/2027', is_virtual: true, token: 'tok_pci_1',
      virtual_card_effective_date: '2026-11-12', virtual_card_expiration_date: '2027-02-12', virtual_card_current_balance: '410000', virtual_card_currency_code: 'UGX' } };
  const f = cardFacts(attrs);
  assert.deepEqual({ ...f }, { collect: 'ota', is_virtual: true, card_type: 'mastercard', last4: '1111', expiry: '11/2027', holder: 'Expedia VCC', token: 'tok_pci_1',
    charge_from: '2026-11-12', charge_until: '2027-02-12', amount: 410000, currency: 'UGX' });
  assert.ok(!JSON.stringify(f).includes('5555') && !JSON.stringify(f).includes('123'));
  assert.ok(!JSON.stringify(withoutCard(attrs)).includes('5555'));
  assert.equal(cardFacts({ payment_collect: 'property', guarantee: { card_number: '411111******1111', card_type: 'visa' } }).is_virtual, false);
  assert.equal(cardFacts({}), null);

  const admin = client(); await admin.login('admin', 'admin-pass-123');
  const std = await typeId(admin, 'STD');
  const r = ok(await book(admin, std, DAY0, '2026-11-12', 'Vcc'));
  await ctx.pool.query("UPDATE reservations SET source='Expedia', commission_pct=18 WHERE id=$1", [r.id]);
  await ctx.pool.query('BEGIN');
  await saveCard(ctx.pool, { reservationId: r.id, channelId: null, ota: 'Expedia', otaRef: 'EX991', facts: f });
  await ctx.pool.query('COMMIT');
  const { rows: [stored] } = await ctx.pool.query('SELECT row_to_json(oc)::text AS j FROM ota_cards oc WHERE reservation_id=$1', [r.id]);
  assert.ok(!stored.j.includes('5555') && !stored.j.includes('"123"'));

  // a receptionist without payment rights cannot see the cards
  ok(await admin.post('/api/users', { username: 'hk1', full_name: 'House Keeper', role: 'housekeeping', password: 'hk-pass-12345' }));
  const hk = client(); await hk.login('hk1', 'hk-pass-12345');
  assert.equal((await hk.get('/api/finance/cards')).status, 403);

  // check in, bill the stay (two nights posted by charges), then charge the virtual card for the net amount
  const list = ok(await admin.get('/api/finance/cards'));
  const c = list.cards.find((x) => x.reservation_id === r.id);
  assert.equal(c.status, 'to_charge'); assert.equal(c.last4, '1111'); assert.equal(c.ready, false); // active from 12 Nov
  ok(await admin.post(`/api/reservations/${r.id}/check-in`, { room_id: await roomId(admin, '101') }));
  ok(await admin.post(`/api/reservations/${r.id}/charges`, { department: 'rooms', description: 'Room 2 nights', amount: 500000 }));
  assert.equal((await admin.post(`/api/finance/cards/${r.id}/charge`, { amount: 100000, auth_code: 'A1', settle_commission: true })).status, 400); // leaves far more than a commission
  const done = ok(await admin.post(`/api/finance/cards/${r.id}/charge`, { amount: 410000, auth_code: 'APP77', card_brand: 'Mastercard', settle_commission: true }));
  assert.equal(done.settled_commission, 90000);
  const { rows: pays } = await ctx.pool.query('SELECT method, amount, details FROM payments WHERE reservation_id=$1 AND NOT voided ORDER BY id', [r.id]);
  assert.deepEqual(pays.map((p) => [p.method, Number(p.amount)]), [['card', 410000], ['ota_commission', 90000]]);
  assert.equal(pays[0].details.card_last4, '1111'); assert.equal(pays[0].details.auth_code, 'APP77');
  // the commission settlement lands on commission payable (2300), and the books still balance
  const { rows: [l] } = await ctx.pool.query(`SELECT COALESCE(SUM(debit),0)::bigint AS d FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='2300' AND je.ref_type='payment' AND je.ref_id=$1`, [r.id]);
  assert.equal(Number(l.d), 90000);
  assert.equal((await admin.post(`/api/finance/cards/${r.id}/charge`, { amount: 1, auth_code: 'x' })).status, 409);
  // nobody can pick "OTA commission" as a payment method at the desk
  assert.equal((await admin.post(`/api/reservations/${r.id}/payments`, { method: 'ota_commission', amount: 1000 })).status, 400);
  await trial(admin);
});
