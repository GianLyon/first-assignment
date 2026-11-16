// Phase 14: the full booking form, payment details, fuller company and supplier records.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, DAY0, ctx } from './helpers.js';

let admin, fd, hk, acc;
before(async () => {
  await startTestServer({ distribution: true, inventory: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['frontdesk', 'front_office'], ['hk1', 'housekeeping'], ['acc1', 'accountant']]) ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  fd = client(); await fd.login('frontdesk', 'password-123');
  hk = client(); await hk.login('hk1', 'password-123');
  acc = client(); await acc.login('acc1', 'password-123');
});
after(stopTestServer);

test('companies keep contacts, billing email, negotiated discount and notes; TIN is checked', async () => {
  const base = { name: 'Uganda Breweries', tin: '1000555666', contact: 'Ruth Akello', contact_role: 'Travel desk', phone: '0772 100 100', phone2: '0414 300 300', email: 'ruth@ubl.example',
    billing_email: 'accounts@ubl.example', address: 'Port Bell, Luzira', industry: 'Manufacturing', website: 'ubl.example', credit_limit: 10000000, terms_days: 45, discount_pct: 15, notes: 'Rooms on 2nd floor preferred.' };
  assert.equal((await acc.post('/api/finance/companies', { ...base, tin: '12345' })).status, 400);
  assert.equal((await acc.post('/api/finance/companies', { ...base, billing_email: 'nope' })).status, 400);
  assert.equal((await acc.post('/api/finance/companies', { ...base, discount_pct: 120 })).status, 400);
  const c = ok(await acc.post('/api/finance/companies', base));
  assert.equal(c.website, 'https://ubl.example');
  assert.equal(Number(c.discount_pct), 15);
  assert.equal(c.billing_email, 'accounts@ubl.example');
  assert.equal(c.contact_role, 'Travel desk');
});

test('suppliers keep bank and mobile money details, terms and category', async () => {
  const b = { name: 'Fresh Farms Ltd', category: 'Food', contact: 'Peter', contact_role: 'Sales', phone: '0700 111 222', address: 'Nakasero Market', tin: '1000777888', terms_days: 14,
    bank_name: 'Stanbic Bank', bank_branch: 'Garden City', bank_account_name: 'Fresh Farms Ltd', bank_account_no: '9030 0123 45678', momo_network: 'MTN', momo_number: '0772 000 999', notes: 'Delivers Mon/Thu' };
  assert.equal((await admin.post('/api/inventory/suppliers', { ...b, category: 'Toys' })).status, 400);
  assert.equal((await admin.post('/api/inventory/suppliers', { ...b, momo_network: 'Orange' })).status, 400);
  assert.equal((await admin.post('/api/inventory/suppliers', { ...b, bank_account_no: 'abc' })).status, 400);
  const s = ok(await admin.post('/api/inventory/suppliers', b));
  assert.deepEqual([s.category, s.terms_days, s.bank_name, s.bank_account_no, s.momo_network, s.momo_number], ['Food', 14, 'Stanbic Bank', '9030 0123 45678', 'MTN', '0772 000 999']);
  const u = ok(await admin.put(`/api/inventory/suppliers/${s.id}`, { ...b, terms_days: 30, active: true }));
  assert.equal(u.terms_days, 30);
});

test('quote: every room type and plan, with rooms left and the company discount', async () => {
  const co = (await ctx.pool.query("SELECT id FROM companies WHERE name='Uganda Breweries'")).rows[0];
  const q = ok(await fd.get(`/api/reservations/quote?arrival=${DAY0}&departure=2026-11-13`));
  assert.equal(q.nights, 3);
  const std = q.room_types.find((t) => t.code === 'STD');
  assert.equal(std.available, 10);
  const flex = std.plans[0];
  assert.equal(flex.nightly.length, 3);
  const qc = ok(await fd.get(`/api/reservations/quote?arrival=${DAY0}&departure=2026-11-13&company_id=${co.id}`));
  assert.equal(qc.company.discount_pct, 15);
  assert.equal(qc.room_types.find((t) => t.code === 'STD').plans[0].nightly[0].rate, Math.round(flex.nightly[0].rate * 0.85 / 100) * 100);
  assert.equal((await fd.get('/api/reservations/quote?arrival=2020-01-01&departure=2020-01-02')).status, 400);
  const opts = ok(await fd.get('/api/booking-options'));
  assert.ok(opts.titles.includes('Dr')); assert.ok(opts.segments.includes('corporate'));
  assert.ok(opts.companies.some((c) => c.name === 'Uganda Breweries'));
});

test('a booking for several rooms: one guest, a group code, prices per night, details, and a deposit with its details', async () => {
  const co = (await ctx.pool.query("SELECT id FROM companies WHERE name='Uganda Breweries'")).rows[0];
  const std = await typeId(fd, 'STD'), dlx = await typeId(fd, 'DLX');
  const body = {
    guest: { title: 'Dr', first_name: 'Ruth', last_name: 'Nakato', phone: '0772 123 456', email: 'ruth.nakato@example.com', nationality: 'Ugandan' },
    arrival: DAY0, departure: '2026-11-12', eta: '15:30', source: 'Phone', market_segment: 'corporate', company_id: co.id, guarantee: 'company',
    booker_reference: 'PO-7781', special_requests: 'Quiet rooms, extra pillows', notes: 'Bill rooms to UBL; extras to guest',
    rooms: [{ room_type_id: dlx, rate_plan_id: 1, adults: 2, children: 1 }, { room_type_id: std, rate: 200000, adults: 1 }, { room_type_id: std, rate_plan_id: 1, adults: 1 }],
    deposit: { amount: 300000, method: 'mobile_money', reference: 'MP2611AB12', payer_name: 'Uganda Breweries', details: { network: 'MTN', momo_number: '0772 555 777' } },
  };
  // validation
  assert.equal((await fd.post('/api/bookings', { ...body, eta: '25:00' })).status, 400);
  assert.equal((await fd.post('/api/bookings', { ...body, market_segment: 'pirates' })).status, 400);
  assert.equal((await fd.post('/api/bookings', { ...body, guest: { ...body.guest, title: 'King' } })).status, 400);
  assert.equal((await fd.post('/api/bookings', { ...body, rooms: [] })).status, 400);
  assert.equal((await fd.post('/api/bookings', { ...body, rooms: Array.from({ length: 11 }, () => ({ room_type_id: std, rate: 1, adults: 1 })) })).status, 409); // only 10 Standard
  assert.equal((await fd.post('/api/bookings', { ...body, deposit: { ...body.deposit, method: 'card', details: { card_last4: '4111111111111111' } } })).status, 400);
  assert.equal((await hk.post('/api/bookings', body)).status, 403);
  const b = ok(await fd.post('/api/bookings', body));
  assert.equal(b.reservations.length, 3); assert.equal(b.nights, 2);
  assert.equal(b.group_code, b.reservations[0].code);
  const { rows } = await ctx.pool.query(`SELECT r.*, to_char(r.eta,'HH24:MI') AS eta_s, g.title, g.first_name FROM reservations r JOIN guests g ON g.id=r.guest_id WHERE r.group_code=$1 ORDER BY r.id`, [b.group_code]);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.guest_id)).size, 1); // one guest profile
  assert.deepEqual([rows[0].title, rows[0].eta_s, rows[0].market_segment, rows[0].guarantee, rows[0].booker_reference, rows[0].special_requests, rows[0].company_name],
    ['Dr', '15:30', 'corporate', 'company', 'PO-7781', 'Quiet rooms, extra pillows', 'Uganda Breweries']);
  assert.deepEqual(rows.map((r) => [r.adults, r.children]), [[2, 1], [1, 0], [1, 0]]);
  assert.equal(Number(rows[1].rate), 200000); // a fixed rate
  // plan prices per night, with the company's 15% off
  const nights = (await ctx.pool.query('SELECT rate FROM reservation_nights WHERE reservation_id=$1 ORDER BY night', [rows[0].id])).rows.map((x) => Number(x.rate));
  assert.equal(nights.length, 2); assert.equal(nights[0], Math.round(350000 * 0.85 / 100) * 100);
  assert.equal(b.total, nights[0] * 2 + 400000 + Math.round(250000 * 0.85 / 100) * 100 * 2);
  // the deposit, with its details, on the first room
  const p = (await ctx.pool.query('SELECT * FROM payments WHERE reservation_id=$1', [rows[0].id])).rows[0];
  assert.deepEqual([Number(p.amount), p.method, p.reference, p.payer_name, p.details], [300000, 'mobile_money', 'MP2611AB12', 'Uganda Breweries', { network: 'MTN', momo_number: '0772 555 777' }]);
  // the bill shows the other rooms of the booking
  const f = ok(await fd.get(`/api/reservations/${rows[1].id}`));
  assert.deepEqual(f.group.map((x) => x.code), rows.map((r) => r.code));
  assert.equal(f.reservation.eta, '15:30');
  // a returning guest is found by name or phone and booked without retyping
  const found = ok(await fd.get('/api/guests/search?q=0772123456'));
  assert.equal(found[0].first_name, 'Ruth');
  const again = ok(await fd.post('/api/bookings', { guest_id: found[0].id, arrival: '2026-12-01', departure: '2026-12-02', rooms: [{ room_type_id: std, adults: 1 }] }));
  assert.equal((await ctx.pool.query('SELECT guest_id FROM reservations WHERE id=$1', [again.reservations[0].id])).rows[0].guest_id, rows[0].guest_id);
  assert.equal(again.group_code, null);
  // details can be changed later
  ok(await fd.put(`/api/reservations/${rows[0].id}`, { eta: '18:00', special_requests: 'Late arrival' }));
  const g2 = ok(await fd.get(`/api/reservations/${rows[0].id}`)).reservation;
  assert.deepEqual([g2.eta, g2.special_requests, g2.market_segment], ['18:00', 'Late arrival', 'corporate']);
});

test('payment details per method: card last 4 only, cash change, bank date', async () => {
  const r = ok(await fd.post('/api/reservations', { room_type_id: await typeId(fd, 'STD'), arrival: DAY0, departure: '2026-11-11', guest: { first_name: 'Pay', last_name: 'Test' } }));
  const pay = (b) => fd.post(`/api/reservations/${r.id}/payments`, b);
  assert.equal((await pay({ amount: 50000, method: 'card', details: { card_brand: 'Diners', card_last4: '1234' } })).status, 400);
  assert.equal((await pay({ amount: 50000, method: 'card', details: { card_brand: 'Visa', card_last4: '12345' } })).status, 400);
  const c = ok(await pay({ amount: 50000, method: 'card', reference: 'POS 3321', details: { card_brand: 'Visa', card_last4: '4242', auth_code: 'A1B2C3', ignored: 'x' } }));
  assert.deepEqual(c.details, { card_brand: 'Visa', card_last4: '4242', auth_code: 'A1B2C3' });
  assert.equal((await pay({ amount: 50000, method: 'cash', details: { tendered: 40000 } })).status, 400);
  const cash = ok(await pay({ amount: 70000, method: 'cash', details: { tendered: 100000 } }));
  assert.deepEqual(cash.details, { tendered: 100000, change: 30000 });
  const bank = ok(await pay({ amount: 10000, method: 'bank_transfer', reference: 'FT2611', details: { bank: 'Centenary Bank', bank_date: '2026-11-09' } }));
  assert.deepEqual(bank.details, { bank: 'Centenary Bank', bank_date: '2026-11-09' });
  const folio = ok(await fd.get(`/api/reservations/${r.id}`));
  assert.ok(folio.payments.some((x) => x.details?.card_last4 === '4242'));
});
