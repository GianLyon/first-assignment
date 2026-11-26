// Phase 20: deeper POS, spa, health club, hotel-network-only access, reports library.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, ctx, typeId, roomId, book, DAY0 } from './helpers.js';
import { ipAllowed, cleanNetworks } from '../src/netlock.js';
import { REPORTS } from '../src/reports/library.js';

let admin, waiter, mgr, setup;
const item = (name) => setup.items.find((i) => i.name === name);
const outlet = (name) => setup.outlets.find((o) => o.name === name);
const tableOf = (o, name) => setup.tables.find((t) => t.outlet_id === outlet(o).id && t.name === name);
const trial = async () => { const tb = ok(await admin.get('/api/accounts/trial-balance')); assert.equal(tb.total_debit, tb.total_credit); };

before(async () => {
  await startTestServer({ pos: true, inventory: true, distribution: true, hr: true, operations: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['waiter2', 'waiter'], ['manager2', 'manager'], ['fd2', 'front_office']]) ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  waiter = client(); await waiter.login('waiter2', 'password-123');
  mgr = client(); await mgr.login('manager2', 'password-123');
  setup = ok(await waiter.get('/api/pos/setup'));
  ok(await waiter.post('/api/pos/shift/open', { outlet_id: outlet('Restaurant').id, opening_float: 0 }));
  ok(await mgr.post('/api/pos/shift/open', { outlet_id: outlet('Restaurant').id, opening_float: 0 }));
});
after(stopTestServer);

test('ordering: choices, courses held and fired, happy hour, outlet menus', async () => {
  const c = ok(await waiter.post('/api/pos/checks', { table_id: tableOf('Restaurant', 'T1').id, covers: 2 }));
  // a steak needs a cooking choice from the list
  assert.equal((await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item('Beef fillet steak').id })).status, 400);
  assert.equal((await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item('Beef fillet steak').id, option: 'Blue' })).status, 400);
  ok(await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item('Beef fillet steak').id, option: 'Medium', hold: true }));
  ok(await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item('Soda').id, qty: 2 }));
  // spa shop items are not sold in the restaurant
  assert.equal((await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item('Gym day pass').id })).status, 400);
  // send: the soda goes to the bar now, the held steak waits
  let r = ok(await waiter.post(`/api/pos/checks/${c.id}/send`));
  assert.deepEqual(r.tickets.map((t) => t.station), ['bar']);
  let d = ok(await waiter.get(`/api/pos/checks/${c.id}`));
  const steak = d.lines.find((l) => l.name === 'Beef fillet steak');
  assert.equal(steak.status, 'pending'); assert.equal(steak.held, true); assert.equal(steak.course, 2); assert.equal(steak.option, 'Medium');
  // fire the mains: a kitchen ticket for course 2, with the choice on it
  r = ok(await waiter.post(`/api/pos/checks/${c.id}/fire`, {}));
  assert.deepEqual(r.tickets.map((t) => t.station), ['kitchen']);
  const chef = admin;
  const kt = ok(await chef.get('/api/pos/tickets?station=kitchen')).find((t) => t.code === c.code);
  assert.equal(kt.course, 2); assert.equal(kt.items[0].option, 'Medium'); assert.equal(kt.waiter_name, 'WAITER2');
  assert.equal((await waiter.post(`/api/pos/checks/${c.id}/fire`, {})).status, 409);
  // happy hour all day at the restaurant: the lager sells at its happy-hour price
  const rest = outlet('Restaurant');
  ok(await admin.put(`/api/pos/outlets/${rest.id}`, { name: rest.name, happy_from: '00:00', happy_to: '23:59' }));
  const hh = ok(await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item('Local lager (500ml)').id }));
  assert.equal(hh.happy, true);
  d = ok(await waiter.get(`/api/pos/checks/${c.id}`));
  assert.equal(d.lines.find((l) => l.name === 'Local lager (500ml)').unit_price, 6000);
  ok(await admin.put(`/api/pos/outlets/${rest.id}`, { name: rest.name }));
  ok(await waiter.post(`/api/pos/checks/${c.id}/settle`, { payments: [{ method: 'cash', amount: d.total }] }));
});

test('discounts within limits, complimentary and house use by a manager, split and merge', async () => {
  const c = ok(await waiter.post('/api/pos/checks', { table_id: tableOf('Restaurant', 'T2').id, covers: 4 }));
  for (const n of ['Chicken luwombo', 'Chicken luwombo', 'Vegetable curry & rice', 'Soda']) ok(await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item(n).id }));
  let d = ok(await waiter.get(`/api/pos/checks/${c.id}`));
  assert.equal(d.gross, 45000 * 2 + 35000 + 4000);
  // a waiter may give up to 10%; more needs a manager; a reason is always required
  assert.equal((await waiter.post(`/api/pos/checks/${c.id}/discount`, { pct: 10 })).status, 400);
  assert.equal((await waiter.post(`/api/pos/checks/${c.id}/discount`, { pct: 20, reason: 'Birthday' })).status, 403);
  d = ok(await mgr.post(`/api/pos/checks/${c.id}/discount`, { pct: 20, reason: 'Birthday' }));
  assert.equal(d.discount, Math.round(d.gross * 0.2)); assert.equal(d.total, d.gross - d.discount);
  // the payment must match the discounted total; the sale is booked net of the discount
  assert.equal((await waiter.post(`/api/pos/checks/${c.id}/settle`, { payments: [{ method: 'cash', amount: d.gross }] })).status, 400);
  ok(await waiter.post(`/api/pos/checks/${c.id}/settle`, { payments: [{ method: 'card', amount: d.total, reference: 'A1' }] }));

  // split: one guest's items move to their own bill on the same table
  const s = ok(await waiter.post('/api/pos/checks', { table_id: tableOf('Restaurant', 'T3').id, covers: 2 }));
  for (const n of ['Goat stew with matoke', 'Whole grilled tilapia & chips', 'Soda']) ok(await waiter.post(`/api/pos/checks/${s.id}/lines`, { item_id: item(n).id }));
  d = ok(await waiter.get(`/api/pos/checks/${s.id}`));
  const tilapia = d.lines.find((l) => l.name.startsWith('Whole grilled tilapia'));
  const n = ok(await waiter.post(`/api/pos/checks/${s.id}/split`, { line_ids: [tilapia.id] }));
  assert.equal(n.table_id, s.table_id); assert.equal(n.parent_id, s.id);
  assert.equal(ok(await waiter.get(`/api/pos/checks/${n.id}`)).total, 55000);
  assert.equal(ok(await waiter.get(`/api/pos/checks/${s.id}`)).total, 40000 + 4000);
  assert.equal((await waiter.post(`/api/pos/checks/${s.id}/split`, { line_ids: d.lines.filter((l) => l.id !== tilapia.id).map((l) => l.id) })).status, 400); // something must stay
  // merge: another table's bill joins this one
  const m = ok(await waiter.post('/api/pos/checks', { table_id: tableOf('Restaurant', 'T4').id, covers: 1 }));
  ok(await waiter.post(`/api/pos/checks/${m.id}/lines`, { item_id: item('Chocolate cake').id }));
  d = ok(await waiter.post(`/api/pos/checks/${s.id}/merge`, { from_id: m.id }));
  assert.equal(d.total, 44000 + 18000); assert.equal(d.check.covers, 3);
  assert.equal(ok(await waiter.get(`/api/pos/checks/${m.id}`)).check.status, 'merged');
  // a table freed by the merge can be used again
  ok(await waiter.post('/api/pos/checks', { table_id: tableOf('Restaurant', 'T4').id, covers: 1 }));

  // complimentary: no money and no sale, a manager and a reason
  assert.equal((await waiter.post(`/api/pos/checks/${n.id}/settle`, { kind: 'complimentary', reason: 'Complaint' })).status, 403);
  assert.equal((await mgr.post(`/api/pos/checks/${n.id}/settle`, { kind: 'complimentary' })).status, 400);
  d = ok(await mgr.post(`/api/pos/checks/${n.id}/settle`, { kind: 'complimentary', reason: 'Long wait for food' }));
  assert.equal(d.check.settle_kind, 'complimentary'); assert.equal(d.payments.length, 0);
  ok(await waiter.post(`/api/pos/checks/${s.id}/settle`, { payments: [{ method: 'mobile_money', amount: 62000 }] }));
  await trial();
});

test('printing: bills before payment, receipts after, every reprint is a COPY; kitchen tickets too', async () => {
  const c = ok(await waiter.post('/api/pos/checks', { table_id: tableOf('Restaurant', 'T5').id, covers: 1 }));
  ok(await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: item('Full breakfast').id }));
  assert.equal((await waiter.post('/api/pos/prints', { check_id: c.id, kind: 'receipt' })).status, 409);
  assert.deepEqual(ok(await waiter.post('/api/pos/prints', { check_id: c.id, kind: 'bill' })), { copy: false, n: 1 });
  assert.deepEqual(ok(await waiter.post('/api/pos/prints', { check_id: c.id, kind: 'bill' })), { copy: true, n: 2 });
  ok(await waiter.post(`/api/pos/checks/${c.id}/send`));
  const t = ok(await admin.get('/api/pos/tickets?station=kitchen')).find((x) => x.code === c.code);
  assert.equal(ok(await waiter.post('/api/pos/prints', { ticket_id: t.id, kind: 'kot' })).copy, false);
  assert.equal(ok(await waiter.post('/api/pos/prints', { ticket_id: t.id, kind: 'kot' })).copy, true);
  ok(await waiter.post(`/api/pos/checks/${c.id}/settle`, { payments: [{ method: 'cash', amount: 35000 }] }));
  assert.equal((await waiter.post('/api/pos/prints', { check_id: c.id, kind: 'bill' })).status, 409);
  assert.equal(ok(await waiter.post('/api/pos/prints', { check_id: c.id, kind: 'receipt' })).copy, false);
  assert.equal(ok(await waiter.post('/api/pos/prints', { check_id: c.id, kind: 'receipt' })).copy, true);
  const rep = ok(await admin.get(`/api/library/pos_reprints?from=${DAY0}&to=${DAY0}`));
  assert.equal(rep.rows.filter((x) => x.bill === c.code).length, 3); // bill copy, KOT copy, receipt copy
});

test('spa: therapists and rooms are never double-booked; treatments are paid or charged to the room', async () => {
  const spa = ok(await admin.get(`/api/wellness/spa?date=${DAY0}`));
  const massage = spa.treatments.find((x) => x.name.startsWith('Full body massage'));
  const grace = spa.therapists.find((x) => x.name === 'Grace'), room1 = spa.rooms.find((x) => x.name === 'Treatment room 1'), couples = spa.rooms.find((x) => x.name === 'Couples suite');
  const a = ok(await admin.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0, start_time: '10:00', therapist_id: grace.id, spa_room_id: room1.id, guest_name: 'Walk-in One' }));
  assert.equal(String(a.end_time).slice(0, 5), '11:00');
  // Grace at 10:30 overlaps; room 1 at 10:30 is taken; the couples suite has two beds
  assert.equal((await admin.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0, start_time: '10:30', therapist_id: grace.id, guest_name: 'X' })).status, 409);
  assert.equal((await admin.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0, start_time: '10:30', spa_room_id: room1.id, guest_name: 'X' })).status, 409);
  ok(await admin.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0, start_time: '14:00', spa_room_id: couples.id, guest_name: 'Couple A' }));
  ok(await admin.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0, start_time: '14:00', spa_room_id: couples.id, guest_name: 'Couple B' }));
  assert.equal((await admin.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0, start_time: '14:30', spa_room_id: couples.id, guest_name: 'Couple C' })).status, 409);
  // Grace is free again at 11:00
  ok(await admin.post('/api/ops/amenity-bookings', { amenity_id: massage.id, service_date: DAY0, start_time: '11:00', therapist_id: grace.id, guest_name: 'Walk-in Two' }));
  // arrived → in treatment → done and paid
  ok(await admin.post(`/api/ops/amenity-bookings/${a.id}/close`, { status: 'arrived' }));
  ok(await admin.post(`/api/ops/amenity-bookings/${a.id}/close`, { status: 'in_progress' }));
  ok(await admin.post(`/api/ops/amenity-bookings/${a.id}/complete`, { settle_by: 'card' }));
  const perf = ok(await admin.get(`/api/library/therapist_performance?from=${DAY0}&to=${DAY0}`));
  assert.equal(perf.rows.find((r) => r.therapist === 'Grace').done, 1);
  await trial();
});

test('health club: plans, members, renewals and check-in at the door', async () => {
  const list = ok(await admin.get('/api/wellness/club/members'));
  const monthly = list.plans.find((p) => p.name === 'Monthly');
  const m = ok(await admin.post('/api/wellness/club/members', { first_name: 'Joan', last_name: 'Akello', phone: '+256 772 555 111', health_notes: 'Asthma' }));
  assert.match(m.code, /^M\d+/);
  // not paid yet: refused at the door
  let r = await admin.post('/api/wellness/club/checkin', { member: m.code });
  assert.equal(r.status, 409); assert.match(r.data.error, /not been paid/);
  const sale = ok(await admin.post(`/api/wellness/club/members/${m.id}/renew`, { plan_id: monthly.id, method: 'mobile_money', reference: 'MM55' }));
  assert.equal(sale.from, DAY0); assert.equal(sale.amount, 250000);
  // renewing early starts the day after the current period
  const again = ok(await admin.post(`/api/wellness/club/members/${m.id}/renew`, { plan_id: monthly.id, method: 'cash' }));
  assert.equal(again.from > sale.to, true);
  // check in by phone number, once per visit
  r = ok(await admin.post('/api/wellness/club/checkin', { member: '0772555111' }));
  assert.equal(r.name, 'Joan Akello'); assert.equal(r.health_notes, 'Asthma');
  assert.equal(ok(await admin.post('/api/wellness/club/checkin', { member: m.code })).already, true);
  ok(await admin.post(`/api/wellness/club/members/${m.id}/status`, { status: 'frozen' }));
  assert.equal((await admin.post('/api/wellness/club/checkin', { member: m.code })).status, 409);
  const visits = ok(await admin.get(`/api/library/club_visits?from=${DAY0}&to=${DAY0}`));
  assert.equal(visits.totals.members, 1);
  await trial();
});

test('hotel network only: staff off the hotel network are refused; managers and exempt people are not', async () => {
  // address matching
  assert.equal(ipAllowed('41.210.140.17', ['41.210.140.16/28']), true);
  assert.equal(ipAllowed('41.210.140.32', ['41.210.140.16/28']), false);
  assert.equal(ipAllowed('::ffff:41.210.140.17', ['41.210.140.17']), true);
  assert.equal(ipAllowed('2001:db8:5::1', ['2001:db8::/32']), true);
  assert.equal(ipAllowed('2001:db9::1', ['2001:db8::/32']), false);
  assert.throws(() => cleanNetworks(['hotel wifi']), /not an internet address/);
  assert.throws(() => cleanNetworks(['0.0.0.0/0']), /not an internet address/);
  // a waiter cannot change it; the lock needs at least one address
  assert.equal((await waiter.put('/api/settings/network', { network_lock: true, allowed_networks: ['10.1.2.3'] })).status, 403);
  assert.equal((await admin.put('/api/settings/network', { network_lock: true, allowed_networks: [] })).status, 400);
  const net = ok(await admin.get('/api/settings/network'));
  assert.ok(net.your_address);
  ok(await admin.put('/api/settings/network', { network_lock: true, allowed_networks: ['10.20.30.0/24'], network_exempt_roles: ['admin', 'general_manager'] }));
  // the waiter is now outside the hotel network: their open session and a new sign-in are both refused
  let r = await waiter.get('/api/pos/shift');
  assert.equal(r.status, 403); assert.equal(r.data.details.code, 'network');
  const w2 = client();
  r = await w2.post('/api/auth/login', { username: 'waiter2', password: 'password-123' });
  assert.equal(r.status, 403); assert.match(r.data.error, /hotel's Wi-Fi/);
  // the administrator still works from anywhere; a person can be exempted
  ok(await admin.get('/api/settings/network'));
  const users = ok(await admin.get('/api/users'));
  ok(await admin.put(`/api/users/${users.find((u) => u.username === 'waiter2').id}`, { network_exempt: true }));
  ok(await waiter.get('/api/pos/shift'));
  ok(await admin.put(`/api/users/${users.find((u) => u.username === 'waiter2').id}`, { network_exempt: false }));
  // adding this network lets everyone in again
  ok(await admin.put('/api/settings/network', { network_lock: true, allowed_networks: ['10.20.30.0/24', net.your_address], network_exempt_roles: ['admin'] }));
  ok(await waiter.get('/api/pos/shift'));
  ok(await admin.put('/api/settings/network', { network_lock: false, allowed_networks: [], network_exempt_roles: ['admin', 'general_manager', 'finance_manager'] }));
});

test('reports library: every report runs, rights decide who sees which, CSV export', async () => {
  // some data in places the other tests did not touch
  const r = ok(await book(admin, await typeId(admin, 'STD'), DAY0, '2026-11-12', 'Rep'));
  ok(await admin.post(`/api/reservations/${r.id}/check-in`, { room_id: await roomId(admin, '102') }));
  const lib = ok(await admin.get('/api/library'));
  const all = lib.departments.flatMap((d) => d.reports);
  assert.equal(all.length, REPORTS.length);
  assert.ok(lib.departments.length >= 10);
  for (const rep of all) {
    const res = await admin.get(`/api/library/${rep.key}?from=2026-10-01&to=2026-11-30`);
    assert.equal(res.status, 200, `${rep.key}: ${JSON.stringify(res.data)}`);
    assert.ok(Array.isArray(res.data.rows), rep.key);
    if (rep.outlet) assert.equal((await admin.get(`/api/library/${rep.key}?from=2026-10-01&to=2026-11-30&outlet=${outlet('Restaurant').id}`)).status, 200, rep.key);
  }
  const rooming = ok(await admin.get('/api/library/rooming_list'));
  assert.ok(rooming.rows.some((x) => x.room === '102'));
  const sales = ok(await admin.get(`/api/library/pos_sales_summary?from=${DAY0}&to=${DAY0}`));
  assert.ok(sales.totals.net > 0); assert.ok(sales.totals.discount > 0);
  // the front desk sees front desk reports, not the accounts
  const fd = client(); await fd.login('fd2', 'password-123');
  const fdLib = ok(await fd.get('/api/library'));
  assert.ok(fdLib.departments.some((d) => d.key === 'frontdesk'));
  assert.ok(!fdLib.departments.some((d) => d.key === 'accounts'));
  assert.equal((await fd.get('/api/library/trial_balance')).status, 403);
  // CSV for Excel, with the totals row
  const csv = await fetch(`${ctx.base}/api/library/pos_sales_summary?from=${DAY0}&to=${DAY0}&format=csv`, { headers: { cookie: (await (async () => { const res = await fetch(ctx.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }) }); return res.headers.get('set-cookie').split(';')[0]; })()) } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /Date,Outlet,Bills/); assert.match(text, /\r\nTotal,/);
});
