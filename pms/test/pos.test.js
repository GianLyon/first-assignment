// Phase 2: Restaurant / POS integration tests (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, roomId, typeId, book, DAY0 } from './helpers.js';

let admin, waiter, chef, mgr, setup;
const item = (name) => setup.items.find((i) => i.name === name);
const outlet = (name) => setup.outlets.find((o) => o.name === name);
const table = (outletName, name) => setup.tables.find((t) => t.outlet_id === outlet(outletName).id && t.name === name);

before(async () => {
  await startTestServer({ pos: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['waiter1', 'waiter'], ['chef1', 'kitchen'], ['manager1', 'manager'], ['frontdesk', 'front_office']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  waiter = client(); await waiter.login('waiter1', 'password-123');
  chef = client(); await chef.login('chef1', 'password-123');
  mgr = client(); await mgr.login('manager1', 'password-123');
  setup = ok(await waiter.get('/api/pos/setup'));
});
after(stopTestServer);

test('roles: waiters only reach the POS, kitchen only the ticket screen', async () => {
  assert.equal((await waiter.get('/api/reservations')).status, 403);
  assert.equal((await waiter.get('/api/pos/tickets')).status, 403);
  assert.equal((await chef.post('/api/pos/shift/open', { outlet_id: outlet('Restaurant').id })).status, 403);
  ok(await chef.get('/api/pos/tickets?station=kitchen'));
  assert.equal((await waiter.post('/api/pos/items', { category_id: setup.categories[0].id, name: 'X', price: 1 })).status, 403);
  // menu management by a manager, with price changes audited
  const it = ok(await mgr.post('/api/pos/items', { category_id: setup.categories[0].id, name: 'Spanish omelette', price: 20000 }));
  ok(await mgr.put(`/api/pos/items/${it.id}`, { category_id: it.category_id, name: it.name, price: 22000 }));
  const log = ok(await admin.get('/api/audit-log?limit=20'));
  assert.ok(log.some((l) => l.action === 'pos.item_update' && l.details.from_price === 20000 && l.details.to_price === 22000));
});

let check;
test('shift, bill, items and sending orders to kitchen and bar', async () => {
  const t1 = table('Restaurant', 'T1');
  assert.equal((await waiter.post('/api/pos/checks', { outlet_id: outlet('Restaurant').id, table_id: t1.id })).status, 409); // no shift yet
  ok(await waiter.post('/api/pos/shift/open', { outlet_id: outlet('Restaurant').id, opening_float: 50000 }));
  assert.equal((await waiter.post('/api/pos/shift/open', { outlet_id: outlet('Restaurant').id })).status, 409);
  check = ok(await waiter.post('/api/pos/checks', { outlet_id: outlet('Restaurant').id, table_id: t1.id, covers: 2 }));
  assert.match(check.code, /^C\d+$/);
  assert.equal((await waiter.post('/api/pos/checks', { outlet_id: outlet('Restaurant').id, table_id: t1.id })).status, 409); // table busy
  ok(await waiter.post(`/api/pos/checks/${check.id}/lines`, { item_id: item('Chicken luwombo').id, qty: 1 }));
  ok(await waiter.post(`/api/pos/checks/${check.id}/lines`, { item_id: item('Chicken luwombo').id, qty: 1 })); // merges
  ok(await waiter.post(`/api/pos/checks/${check.id}/lines`, { item_id: item('Beef fillet steak').id, qty: 1, note: 'medium rare' }));
  const lager = ok(await waiter.post(`/api/pos/checks/${check.id}/lines`, { item_id: item('Local lager (500ml)').id, qty: 3 }));
  ok(await waiter.patch(`/api/pos/lines/${lager.id}`, { qty: 2 })); // unsent: change freely
  ok(await waiter.patch(`/api/pos/lines/${lager.id}`, { note: 'very cold' }));
  assert.equal((await waiter.post(`/api/pos/checks/${check.id}/lines`, { item_id: item('Soda').id, qty: 0 })).status, 400);
  let c = ok(await waiter.get(`/api/pos/checks/${check.id}`));
  assert.equal(c.lines.length, 3);
  assert.equal(c.lines.find((l) => l.name === 'Chicken luwombo').qty, 2);
  assert.equal(c.total, 2 * 45000 + 75000 + 2 * 8000);
  const sent = ok(await waiter.post(`/api/pos/checks/${check.id}/send`));
  assert.deepEqual(sent.tickets.map((t) => t.station).sort(), ['bar', 'kitchen']);
  // kitchen display
  const kt = ok(await chef.get('/api/pos/tickets?station=kitchen'));
  assert.equal(kt.length, 1); assert.equal(kt[0].table_name, 'T1');
  assert.ok(kt[0].items.some((i) => i.note === 'medium rare'));
  assert.ok(ok(await chef.get('/api/pos/tickets?station=bar'))[0].items.some((i) => i.note === 'very cold'));
  assert.equal((await waiter.patch(`/api/pos/lines/${lager.id}`, { note: 'too late' })).status, 409); // already sent
  ok(await chef.post(`/api/pos/tickets/${kt[0].id}/status`, { status: 'ready' }));
  ok(await chef.post(`/api/pos/tickets/${kt[0].id}/status`, { status: 'served' }));
  // sent items: the waiter cannot remove them; a manager can, with a reason
  c = ok(await waiter.get(`/api/pos/checks/${check.id}`));
  const beer = c.lines.find((l) => l.name.startsWith('Local lager'));
  assert.equal((await waiter.patch(`/api/pos/lines/${beer.id}`, { qty: 0, reason: 'x' })).status, 403);
  assert.equal((await mgr.patch(`/api/pos/lines/${beer.id}`, { qty: 0 })).status, 400);
  ok(await mgr.patch(`/api/pos/lines/${beer.id}`, { qty: 0, reason: 'Guest changed order' }));
  c = ok(await waiter.get(`/api/pos/checks/${check.id}`));
  assert.equal(c.total, 2 * 45000 + 75000);
});

test('split payment settles the bill and posts balanced, VAT-split accounts', async () => {
  const total = 2 * 45000 + 75000; // 165,000
  const wrong = await waiter.post(`/api/pos/checks/${check.id}/settle`, { payments: [{ method: 'cash', amount: 100000 }] });
  assert.equal(wrong.status, 400);
  assert.equal((await waiter.post(`/api/pos/checks/${check.id}/settle`, { payments: [{ method: 'bitcoin', amount: total }] })).status, 400);
  const done = ok(await waiter.post(`/api/pos/checks/${check.id}/settle`, { payments: [{ method: 'cash', amount: 65000 }, { method: 'mobile_money', amount: 100000, reference: 'MTN-1' }] }));
  assert.equal(done.check.status, 'settled');
  assert.equal((await waiter.post(`/api/pos/checks/${check.id}/lines`, { item_id: item('Soda').id })).status, 409); // closed
  const j = ok(await admin.get('/api/accounts/journal?limit=1'))[0];
  const vat = Math.round((total * 18) / 118);
  assert.deepEqual(j.lines.map((l) => [l.account, l.debit, l.credit]), [['1000', 65000, 0], ['1020', 100000, 0], ['4100', 0, total - vat], ['2100', 0, vat]]);
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
});

let guest;
test('room service charged to the guest room lands on their bill', async () => {
  const fd = client(); await fd.login('frontdesk', 'password-123');
  guest = ok(await book(fd, await typeId(fd, 'DLX'), DAY0, '2026-11-12', 'Room', { rate: 300000 }));
  ok(await fd.post(`/api/reservations/${guest.id}/check-in`, { room_id: await roomId(fd, '205') }));
  const rooms = ok(await waiter.get('/api/pos/rooms'));
  assert.equal(rooms[0].room_number, '205');
  const rs = ok(await waiter.post('/api/pos/checks', { outlet_id: outlet('Room Service').id, reservation_id: guest.id }));
  ok(await waiter.post(`/api/pos/checks/${rs.id}/lines`, { item_id: item('Full breakfast').id, qty: 2 }));
  // guest cannot check out while the room-service bill is open
  assert.equal((await fd.post(`/api/reservations/${guest.id}/check-out`)).status, 409);
  ok(await waiter.post(`/api/pos/checks/${rs.id}/settle`, { payments: [{ method: 'room', amount: 70000, reservation_id: guest.id }] }));
  const f = ok(await fd.get(`/api/reservations/${guest.id}`));
  const ch = f.charges.find((c) => c.department === 'fnb');
  assert.equal(ch.amount, 70000); assert.match(ch.description, /Room Service bill C\d+/);
  assert.equal(f.totals.balance, 70000);
  // charging a guest who is not in-house fails
  const t2 = ok(await waiter.post('/api/pos/checks', { outlet_id: outlet('Restaurant').id, table_id: table('Restaurant', 'T2').id }));
  ok(await waiter.post(`/api/pos/checks/${t2.id}/lines`, { item_id: item('Soda').id, qty: 1 }));
  const future = ok(await book(fd, await typeId(fd, 'STD'), '2026-11-20', '2026-11-21', 'Future'));
  assert.equal((await waiter.post(`/api/pos/checks/${t2.id}/settle`, { payments: [{ method: 'room', amount: 4000, reservation_id: future.id }] })).status, 400);
  ok(await waiter.post(`/api/pos/checks/${t2.id}/settle`, { payments: [{ method: 'card', amount: 4000 }] }));
});

test('open bills block shift close and the night audit; voiding rules', async () => {
  const t3 = ok(await waiter.post('/api/pos/checks', { outlet_id: outlet('Restaurant').id, table_id: table('Restaurant', 'T3').id }));
  ok(await waiter.post(`/api/pos/checks/${t3.id}/lines`, { item_id: item('Chocolate cake').id, qty: 1 }));
  assert.equal((await waiter.post('/api/pos/shift/close', { counted_cash: 115000 })).status, 409);
  const audit = await admin.post('/api/night-audit');
  assert.equal(audit.status, 409); assert.equal(audit.data.details.open_checks.length, 1);
  // move table, then void: unsent bill can be voided by the waiter with a reason
  ok(await waiter.post(`/api/pos/checks/${t3.id}/move`, { table_id: table('Restaurant', 'T4').id }));
  assert.equal((await waiter.post(`/api/pos/checks/${t3.id}/void`, {})).status, 400);
  ok(await waiter.post(`/api/pos/checks/${t3.id}/void`, { reason: 'Guest left before ordering' }));
  // a bill with items already sent needs a manager to void
  const t5 = ok(await waiter.post('/api/pos/checks', { outlet_id: outlet('Restaurant').id, table_id: table('Restaurant', 'T5').id }));
  ok(await waiter.post(`/api/pos/checks/${t5.id}/lines`, { item_id: item('Soda').id, qty: 1 }));
  ok(await waiter.post(`/api/pos/checks/${t5.id}/send`));
  assert.equal((await waiter.post(`/api/pos/checks/${t5.id}/void`, { reason: 'x' })).status, 403);
  ok(await mgr.post(`/api/pos/checks/${t5.id}/void`, { reason: 'Walk-out' }));
});

test('shift close counts cash and shows the variance', async () => {
  const sum = ok(await waiter.post('/api/pos/shift/close', { counted_cash: 114000, notes: 'Short 1,000' }));
  assert.equal(sum.expected_cash, 50000 + 65000);
  assert.equal(sum.variance, -1000);
  assert.equal(sum.takings.mobile_money, 100000); assert.equal(sum.takings.room, 70000); assert.equal(sum.takings.card, 4000);
  assert.equal(ok(await waiter.get('/api/pos/shift')), null);
});

test('sales report and the daily manager report include POS sales', async () => {
  const rep = ok(await admin.get(`/api/pos/reports/sales?date=${DAY0}`));
  assert.equal(rep.total, 165000 + 70000 + 4000);
  assert.equal(rep.by_method.room, 70000);
  assert.equal(rep.by_outlet.find((o) => o.outlet === 'Restaurant').amount, 169000);
  assert.equal(rep.items.find((i) => i.name === 'Chicken luwombo').qty, 2);
  assert.ok(rep.voids.some((v) => v.void_reason === 'Guest changed order'));
  assert.equal(rep.shifts.length, 1); assert.equal(rep.shifts[0].variance, -1000);
  const daily = ok(await admin.get(`/api/reports/daily?date=${DAY0}`));
  assert.equal(daily.revenue.fnb, 165000 + 70000 + 4000); // direct POS + room-charged
  assert.equal(daily.payments.cash, 65000); assert.equal(daily.payments.mobile_money, 100000); assert.equal(daily.payments.card, 4000);
  // with no open bills the night audit now runs
  ok(await admin.post('/api/night-audit'));
});
