// Phase 7: amenity sales, events & banqueting, assets & maintenance (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, book, DAY0 } from './helpers.js';

let admin, fd, mgr, acc, hk, tech;
const lastJournal = async () => ok(await admin.get('/api/accounts/journal?limit=1'))[0].lines.map((l) => [l.account, l.debit, l.credit]);
const balance = async (code) => { const l = ok(await admin.get('/api/accounts/trial-balance')).lines.find((x) => x.code === code); return l.debit - l.credit; };
const balanced = async () => { const tb = ok(await admin.get('/api/accounts/trial-balance')); assert.equal(tb.total_debit, tb.total_credit); };

before(async () => {
  await startTestServer({ operations: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['frontdesk', 'front_office'], ['manager1', 'manager'], ['accounts1', 'accountant'], ['hk1', 'housekeeping'], ['tech1', 'maintenance']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  fd = client(); await fd.login('frontdesk', 'password-123');
  mgr = client(); await mgr.login('manager1', 'password-123');
  acc = client(); await acc.login('accounts1', 'password-123');
  hk = client(); await hk.login('hk1', 'password-123');
  tech = client(); await tech.login('tech1', 'password-123');
});
after(stopTestServer);

test('permissions', async () => {
  assert.equal((await hk.get('/api/ops/amenities')).status, 403);
  assert.equal((await fd.post('/api/ops/amenities', { name: 'X', price: 1 })).status, 403);
  assert.equal((await hk.get('/api/ops/events')).status, 403);
  assert.equal((await acc.post('/api/ops/events', {})).status, 403);
  assert.equal((await fd.get('/api/ops/depreciation')).status, 403);
  assert.equal((await hk.put('/api/ops/work-orders/1', {})).status, 403);
  // reporters see asset names only, not values
  const a = ok(await admin.post('/api/ops/assets', { name: 'Walk-in freezer', category: 'kitchen', location: 'Main kitchen', purchase_date: '2026-01-01', cost: 24000000, useful_life_years: 10, funding: 'none' }));
  const seen = ok(await hk.get('/api/ops/assets')).find((x) => x.id === a.id);
  assert.equal(seen.cost, undefined);
  assert.equal(ok(await tech.get('/api/ops/assets')).find((x) => x.id === a.id).cost, undefined);
});

test('amenities: book with staff clash check, charge to room, pay direct', async () => {
  const list = ok(await fd.get('/api/ops/amenities'));
  const massage = list.find((x) => x.name.startsWith('Full body massage'));
  const transfer = list.find((x) => x.name.startsWith('Airport transfer'));
  const stay = ok(await book(fd, await typeId(fd, 'STD'), DAY0, '2026-11-12', 'Spa'));
  ok(await fd.post(`/api/reservations/${stay.id}/check-in`, { room_id: await roomId(fd, '101') }));
  const guests = ok(await fd.get(`/api/ops/amenity-guests?date=${DAY0}`));
  assert.ok(guests.find((g) => g.id === stay.id && g.room === '101'));

  const b1 = ok(await fd.post('/api/ops/amenity-bookings', { amenity_id: massage.id, reservation_id: stay.id, service_date: DAY0, start_time: '10:00', staff: 'Sarah' }));
  assert.match(b1.code, /^A\d+$/);
  // Sarah is busy 10:00-11:00
  assert.equal((await fd.post('/api/ops/amenity-bookings', { amenity_id: massage.id, guest_name: 'Walk-in', service_date: DAY0, start_time: '10:30', staff: 'sarah' })).status, 409);
  ok(await fd.post('/api/ops/amenity-bookings', { amenity_id: massage.id, guest_name: 'Walk-in', service_date: DAY0, start_time: '11:00', staff: 'Sarah' }));
  assert.equal((await fd.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0 })).status, 400); // no guest
  assert.equal((await fd.post('/api/ops/amenity-bookings', { amenity_id: massage.id, guest_name: 'X', service_date: '2026-11-01' })).status, 400); // past

  ok(await fd.post(`/api/ops/amenity-bookings/${b1.id}/complete`, { settle_by: 'room' }));
  const folio = ok(await fd.get(`/api/reservations/${stay.id}`));
  const ch = folio.charges.find((c) => c.department === 'amenities');
  assert.equal(ch.amount, massage.price);
  assert.equal((await fd.post(`/api/ops/amenity-bookings/${b1.id}/complete`, { settle_by: 'room' })).status, 409); // already done

  const walk = ok(await fd.post('/api/ops/amenity-bookings', { amenity_id: transfer.id, guest_name: 'Visitor', qty: 2, service_date: DAY0 }));
  assert.equal((await fd.post(`/api/ops/amenity-bookings/${walk.id}/complete`, { settle_by: 'room' })).status, 409); // not a hotel guest
  ok(await fd.post(`/api/ops/amenity-bookings/${walk.id}/complete`, { settle_by: 'mobile_money' }));
  const amount = transfer.price * 2, vat = Math.round(amount * 18 / 118);
  assert.deepEqual((await lastJournal()).sort(), [['1020', amount, 0], ['2100', 0, vat], ['4200', 0, amount - vat]].sort());

  const day = ok(await fd.get(`/api/ops/amenity-bookings?date=${DAY0}`));
  assert.equal(day.totals.completed, massage.price + amount);
  assert.equal(day.totals.room, massage.price);
  const later = day.bookings.find((x) => x.status === 'booked');
  ok(await fd.post(`/api/ops/amenity-bookings/${later.id}/close`, { status: 'no_show' }));
  await balanced();
});

test('events: quote, no double booking, deposits, BEO, complete and invoice', async () => {
  const setup = ok(await fd.get('/api/ops/events/setup'));
  const hall = setup.rooms.find((r) => r.name === 'Nile Hall'), board = setup.rooms.find((r) => r.name === 'Boardroom');
  const conf = setup.packages.find((p) => p.name === 'Full-day conference');
  const company = ok(await acc.post('/api/finance/companies', { name: 'Uganda Bankers Ltd', credit_limit: 50000000, terms_days: 30 }));
  const base = { title: 'Annual strategy retreat', event_type: 'conference', event_date: DAY0, start_time: '08:00', end_time: '17:00', function_room_id: hall.id,
    contact_name: 'Peter Okello', contact_phone: '+256772000000', pax: 80, package_id: conf.id, hire_type: 'full_day', setup_style: 'Classroom', company_id: company.id,
    beo_notes: { kitchen: 'Lunch at 13:00; 6 vegetarian', technical: '2 microphones, projector' }, extras: [{ description: 'Printed banner', qty: 1, unit_price: 250000 }] };
  assert.equal((await fd.post('/api/ops/events', { ...base, function_room_id: board.id })).status, 409); // over capacity
  assert.equal((await fd.post('/api/ops/events', { ...base, end_time: '07:00' })).status, 400);
  const ev = ok(await fd.post('/api/ops/events', { ...base, status: 'tentative' }));
  assert.match(ev.code, /^EV\d+$/);
  let d = ok(await fd.get(`/api/ops/events/${ev.id}`));
  assert.equal(d.event.per_person, conf.per_person);
  assert.equal(d.totals.total, 80 * conf.per_person + hall.hire_full_day + 250000);
  assert.equal(d.event.beo_notes.kitchen, 'Lunch at 13:00; 6 vegetarian');

  // the hall is held: an overlapping booking is refused; an enquiry does not block; after hours is fine
  assert.equal((await fd.post('/api/ops/events', { ...base, title: 'Clash', start_time: '16:00', end_time: '20:00', status: 'tentative', extras: [] })).status, 409);
  const enq = ok(await fd.post('/api/ops/events', { ...base, title: 'Maybe', status: 'enquiry', company_id: null, extras: [] }));
  assert.equal((await fd.put(`/api/ops/events/${enq.id}`, { ...base, title: 'Maybe', status: 'confirmed', company_id: null, extras: [] })).status, 409);
  const evening = ok(await fd.post('/api/ops/events', { ...base, title: 'Cocktail', start_time: '18:00', end_time: '22:00', pax: 60, package_id: setup.packages.find((p) => p.name === 'Cocktail evening').id, hire_type: 'none', company_id: null, extras: [], status: 'tentative' }));

  // deposit: Dr cash, Cr guest deposits; confirms the booking
  const t = ok(await fd.post(`/api/ops/events/${ev.id}/payments`, { kind: 'deposit', account_code: '1030', amount: 5000000, reference: 'TT 8812' }));
  assert.equal(t.deposits, 5000000);
  assert.deepEqual((await lastJournal()).sort(), [['1030', 5000000, 0], ['2200', 0, 5000000]].sort());
  d = ok(await fd.get(`/api/ops/events/${ev.id}`));
  assert.equal(d.event.status, 'confirmed');
  assert.equal((await fd.post(`/api/ops/events/${ev.id}/payments`, { kind: 'refund', account_code: '1000', amount: 9000000 })).status, 400);

  // pax rises to 90 on the day
  ok(await fd.put(`/api/ops/events/${ev.id}`, { ...base, pax: 90 }));
  d = ok(await fd.get(`/api/ops/events/${ev.id}`));
  const total = 90 * conf.per_person + hall.hire_full_day + 250000;
  assert.equal(d.totals.total, total);
  assert.equal(d.totals.balance, total - 5000000);

  // complete and invoice the balance to the company
  const before = await balance('2200');
  const r = ok(await fd.post(`/api/ops/events/${ev.id}/complete`, { settle_by: 'invoice' }));
  assert.ok(r.invoice_id);
  const vat = Math.round(total * 18 / 118);
  assert.deepEqual((await lastJournal()).sort(), [['1200', total - 5000000, 0], ['2100', 0, vat], ['2200', 5000000, 0], ['4300', 0, total - vat]].sort());
  assert.equal(await balance('2200'), before + 5000000); // the deposit liability is cleared
  const inv = ok(await acc.get(`/api/finance/invoices/${r.invoice_id}`));
  assert.equal(inv.invoice?.total ?? inv.total, total - 5000000);
  assert.equal((await acc.post(`/api/finance/invoices/${r.invoice_id}/void`, { reason: 'test' })).status, 409);
  assert.equal((await fd.put(`/api/ops/events/${ev.id}`, base)).status, 409); // closed

  // cancellation: deposit must be refunded or kept
  ok(await fd.post(`/api/ops/events/${evening.id}/payments`, { kind: 'deposit', account_code: '1000', amount: 1000000 }));
  assert.equal((await fd.post(`/api/ops/events/${evening.id}/cancel`, { reason: 'Client postponed' })).status, 409);
  ok(await fd.post(`/api/ops/events/${evening.id}/cancel`, { reason: 'Client postponed', deposit: 'forfeit' }));
  assert.deepEqual((await lastJournal()).sort(), [['2200', 1000000, 0], ['4920', 0, 1000000]].sort());
  // after cancelling, the evening slot is free again
  ok(await fd.post('/api/ops/events', { ...base, title: 'Dinner', start_time: '18:00', end_time: '22:00', status: 'confirmed', company_id: null, extras: [], package_id: null, per_person: 80000, hire_type: 'none', event_date: '2026-11-20' }));
  const list = ok(await fd.get('/api/ops/events?filter=past'));
  assert.ok(list.events.find((e) => e.id === ev.id && e.status === 'completed'));
  await balanced();
});

test('events: pay balance in cash; nothing before the event date', async () => {
  const setup = ok(await fd.get('/api/ops/events/setup'));
  const board = setup.rooms.find((r) => r.name === 'Boardroom');
  const ev = ok(await fd.post('/api/ops/events', { title: 'Board meeting', event_date: '2026-11-20', start_time: '09:00', end_time: '12:00', function_room_id: board.id, contact_name: 'Jane', pax: 10, per_person: 50000, hire_type: 'half_day', status: 'confirmed' }));
  assert.equal((await fd.post(`/api/ops/events/${ev.id}/complete`, { settle_by: 'cash' })).status, 409); // date not reached
  const ev2 = ok(await fd.post('/api/ops/events', { title: 'Lunch meeting', event_date: DAY0, start_time: '12:00', end_time: '14:00', function_room_id: board.id, contact_name: 'Jane', pax: 10, per_person: 50000, status: 'confirmed' }));
  assert.equal((await fd.post(`/api/ops/events/${ev2.id}/complete`, { settle_by: 'invoice' })).status, 400); // no company
  ok(await fd.post(`/api/ops/events/${ev2.id}/complete`, { settle_by: 'card' }));
  const vat = Math.round(500000 * 18 / 118);
  assert.deepEqual((await lastJournal()).sort(), [['1010', 500000, 0], ['2100', 0, vat], ['4300', 0, 500000 - vat]].sort());
});

test('assets: capitalise, depreciate once a month, dispose with gain or loss', async () => {
  const gen = ok(await acc.post('/api/ops/assets', { name: 'Standby generator 100kVA', category: 'equipment', location: 'Plant room', purchase_date: '2026-10-01', cost: 120000000, residual_value: 0, useful_life_years: 10, funding: 'opening', service_interval_days: 90 }));
  assert.deepEqual((await lastJournal()).sort(), [['1500', 120000000, 0], ['3000', 0, 120000000]].sort());
  const van = ok(await acc.post('/api/ops/assets', { name: 'Shuttle van', category: 'vehicle', purchase_date: DAY0, cost: 90000000, residual_value: 18000000, useful_life_years: 5, funding: 'paid', paid_from: '1030' }));
  assert.deepEqual((await lastJournal()).sort(), [['1030', 0, 90000000], ['1500', 90000000, 0]].sort());
  assert.equal((await acc.post('/api/ops/assets', { name: 'Bad', purchase_date: DAY0, cost: 10, residual_value: 20, useful_life_years: 1, funding: 'none' })).status, 400);
  assert.equal((await acc.post('/api/ops/assets', { name: 'Future', purchase_date: '2027-01-01', cost: 10, useful_life_years: 1, funding: 'none' })).status, 400);

  assert.equal((await acc.post('/api/ops/depreciation', { period: '2026-12' })).status, 400); // future
  const oct = ok(await acc.post('/api/ops/depreciation', { period: '2026-10' }));
  // generator 1,000,000/month; freezer from the first test 200,000; van bought in November is not depreciated in October
  assert.equal(oct.total, 1000000 + 200000);
  assert.deepEqual((await lastJournal()).sort(), [['1590', 0, 1200000], ['6800', 1200000, 0]].sort());
  assert.equal((await acc.post('/api/ops/depreciation', { period: '2026-10' })).status, 409);
  const nov = ok(await acc.post('/api/ops/depreciation', { period: '2026-11' }));
  assert.equal(nov.total, 1000000 + 200000 + 1200000);

  // sell the van for more than its book value: 90m − 1.2m = 88.8m, sold for 89.5m → gain 0.7m
  const sale = ok(await acc.post(`/api/ops/assets/${van.id}/dispose`, { proceeds: 89500000, account_code: '1030', reason: 'Replaced' }));
  assert.equal(sale.gain, 700000);
  assert.deepEqual((await lastJournal()).sort(), [['1030', 89500000, 0], ['1500', 0, 90000000], ['1590', 1200000, 0], ['4910', 0, 700000]].sort());
  assert.equal((await acc.post(`/api/ops/assets/${van.id}/dispose`, {})).status, 409);
  const reg = ok(await acc.get('/api/ops/assets?status=disposed'));
  assert.ok(reg.find((a) => a.id === van.id));
  const a = ok(await acc.get(`/api/ops/assets/${gen.id}`));
  assert.equal(a.asset.accumulated_dep, 2000000);
  assert.equal(a.asset.book_value, 118000000);
  await balanced();
});

test('maintenance: report, room out of order, complete, preventive schedule', async () => {
  const room = await roomId(fd, '102');
  const w = ok(await hk.post('/api/ops/work-orders', { title: 'Shower leaking', priority: 'high', room_id: room, room_out_of_order: true }));
  assert.match(w.code, /^WO\d+$/);
  assert.equal(w.due_date.slice?.(0, 10) ?? w.due_date, '2026-11-11');
  assert.equal(ok(await fd.get('/api/rooms')).find((r) => r.id === room).hk_status, 'out_of_order');
  // an occupied room cannot be taken out of order
  const occupied = await roomId(fd, '101');
  assert.equal((await hk.post('/api/ops/work-orders', { title: 'TV', room_id: occupied, room_out_of_order: true })).status, 409);
  ok(await hk.post('/api/ops/work-orders', { title: 'TV remote missing', room_id: occupied, priority: 'low' }));

  // reporters see only their own jobs; the technician sees all
  const mine = ok(await fd.get('/api/ops/work-orders'));
  assert.equal(mine.work_orders.length, 0);
  const all = ok(await tech.get('/api/ops/work-orders'));
  assert.equal(all.work_orders[0].code, w.code); // high before low
  ok(await tech.put(`/api/ops/work-orders/${w.id}`, { status: 'in_progress', assigned_to: 'Moses' }));
  assert.equal((await tech.put(`/api/ops/work-orders/${w.id}`, { status: 'done' })).status, 400); // say what was done
  ok(await tech.put(`/api/ops/work-orders/${w.id}`, { status: 'done', completion_notes: 'Replaced mixer cartridge', cost: 85000 }));
  assert.equal(ok(await fd.get('/api/rooms')).find((r) => r.id === room).hk_status, 'dirty'); // back to housekeeping
  assert.equal((await tech.put(`/api/ops/work-orders/${w.id}`, { status: 'open' })).status, 409);
  assert.ok(ok(await tech.get('/api/ops/work-orders?status=closed')).work_orders.find((x) => x.id === w.id));

  // an asset fault marks it under repair until fixed
  const freezer = ok(await tech.get('/api/ops/assets')).find((a) => a.name === 'Walk-in freezer');
  const f = ok(await hk.post('/api/ops/work-orders', { title: 'Freezer not cooling', priority: 'urgent', asset_id: freezer.id }));
  assert.equal(ok(await tech.get(`/api/ops/assets/${freezer.id}`)).asset.status, 'under_repair');
  ok(await tech.put(`/api/ops/work-orders/${f.id}`, { status: 'done', completion_notes: 'Regassed' }));
  assert.equal(ok(await tech.get(`/api/ops/assets/${freezer.id}`)).asset.status, 'in_use');

  // generator bought 2026-10-01 with a 90-day interval: due 2026-12-30, not yet within a week
  let s = ok(await tech.post('/api/ops/work-orders/schedule'));
  assert.equal(s.created, 0);
  ok(await tech.put(`/api/ops/assets/${freezer.id}`, { name: 'Walk-in freezer', location: 'Main kitchen', service_interval_days: 30 }));
  s = ok(await tech.post('/api/ops/work-orders/schedule'));
  assert.equal(s.created, 1);
  assert.equal(ok(await tech.post('/api/ops/work-orders/schedule')).created, 0); // not twice
  const pm = ok(await tech.get('/api/ops/work-orders')).work_orders.find((x) => x.kind === 'preventive');
  ok(await tech.put(`/api/ops/work-orders/${pm.id}`, { status: 'done', completion_notes: 'Serviced, seals checked' }));
  assert.equal(ok(await tech.get(`/api/ops/assets/${freezer.id}`)).asset.serviced, DAY0);
});
