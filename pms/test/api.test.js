// Integration tests against a real PostgreSQL database.
// Uses TEST_DATABASE_URL (default: local hk_pms_test). The test schema is wiped and rebuilt on every run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, roomId, typeId, book, DAY0, ctx } from './helpers.js';

let admin;
before(async () => {
  await startTestServer();
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['frontdesk', 'front_office'], ['housekeep', 'housekeeping'], ['manager1', 'manager'], ['nightaudit', 'night_auditor']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
});
after(stopTestServer);

test('authentication and request guards', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/dashboard')).status, 401);
  assert.equal((await anon.post('/api/auth/login', { username: 'admin', password: 'wrong-password' })).status, 401);
  const me = ok(await admin.get('/api/auth/me'));
  assert.equal(me.user.role, 'admin'); assert.equal(me.settings.business_date, DAY0);
  // non-JSON state-changing requests are refused (cross-site form posts)
  assert.equal((await admin.post('/api/reservations', 'a=b', { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  // passwords are never returned
  const users = ok(await admin.get('/api/users'));
  assert.ok(users.every((u) => !('password_hash' in u)));
});

test('login is throttled after repeated failures', async () => {
  ok(await admin.post('/api/users', { username: 'locktest', full_name: 'Lock Test', role: 'housekeeping', password: 'password-123' }));
  const c = client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { username: 'locktest', password: 'nope-nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'locktest', password: 'password-123' })).status, 429);
});

test('role permissions are enforced', async () => {
  const hk = client(); await hk.login('nightaudit', 'password-123'); // night auditor
  const fo = client(); await fo.login('frontdesk', 'password-123');
  assert.equal((await fo.get('/api/users')).status, 403);
  assert.equal((await fo.get('/api/accounts/trial-balance')).status, 403);
  assert.equal((await fo.post('/api/night-audit')).status, 403);
  const std = await typeId(fo, 'STD');
  ok(await book(fo, std, '2026-11-20', '2026-11-21', 'Perm'));
});

test('availability blocks overbooking, including simultaneous requests', async () => {
  const ste = await typeId(admin, 'STE'); // 4 suites
  for (let i = 0; i < 3; i++) ok(await book(admin, ste, '2026-12-01', '2026-12-03', `Suite${i}`));
  // two receptionists try to sell the last suite at the same moment
  const [a, b] = await Promise.all([book(admin, ste, '2026-12-01', '2026-12-02', 'RaceA'), book(admin, ste, '2026-12-01', '2026-12-02', 'RaceB')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const grid = ok(await admin.get('/api/availability?from=2026-12-01&days=3'));
  const suites = grid.find((t) => t.code === 'STE');
  assert.equal(suites.nights[0].free, 0); assert.equal(suites.nights[1].free, 1); assert.equal(suites.nights[2].free, 4);
  // validation
  assert.equal((await book(admin, ste, '2026-12-05', '2026-12-05')).status, 400);
  assert.equal((await book(admin, ste, '2026-11-01', '2026-11-02')).status, 400);
});

let stay; // reservation used through the stay lifecycle
test('check-in rules', async () => {
  const dlx = await typeId(admin, 'DLX');
  stay = ok(await book(admin, dlx, DAY0, '2026-11-12', 'Sarah', { rate: 300000 }));
  assert.match(stay.code, /^R\d+$/);
  const r201 = await roomId(admin, '201');
  ok(await admin.patch(`/api/rooms/${r201}/housekeeping`, { hk_status: 'dirty' }));
  assert.equal((await admin.post(`/api/reservations/${stay.id}/check-in`, { room_id: r201 })).status, 409); // dirty
  ok(await admin.patch(`/api/rooms/${r201}/housekeeping`, { hk_status: 'clean' }));
  ok(await admin.post(`/api/reservations/${stay.id}/check-in`, { room_id: r201, guest: { id_type: 'Passport', id_number: 'A1234567' } }));
  // a second guest cannot be put in the same room
  const other = ok(await book(admin, dlx, DAY0, '2026-11-11', 'Other'));
  assert.equal((await admin.post(`/api/reservations/${other.id}/check-in`, { room_id: r201 })).status, 409);
  // a future booking cannot check in early
  const future = ok(await book(admin, dlx, '2026-11-15', '2026-11-16', 'Future'));
  assert.equal((await admin.post(`/api/reservations/${future.id}/check-in`, { room_id: await roomId(admin, '202') })).status, 409);
  // occupied rooms cannot be set out of order
  assert.equal((await admin.patch(`/api/rooms/${r201}/housekeeping`, { hk_status: 'out_of_order' })).status, 409);
  const board = ok(await admin.get('/api/room-board'));
  assert.equal(board.rooms.find((r) => r.number === '201').first_name, 'Sarah');
});

test('folio charges, VAT, payments, voids and check-out', async () => {
  const fo = client(); await fo.login('frontdesk', 'password-123');
  const mgr = client(); await mgr.login('manager1', 'password-123');
  const charge = ok(await fo.post(`/api/reservations/${stay.id}/charges`, { description: 'Dinner', department: 'fnb', amount: 118000 }));
  assert.equal((await fo.post(`/api/reservations/${stay.id}/charges`, { description: 'Bad', department: 'fnb', amount: -5 })).status, 400);
  // VAT split: 118,000 inclusive at 18% = 100,000 revenue + 18,000 VAT
  const j = ok(await admin.get('/api/accounts/journal?limit=1'))[0];
  assert.deepEqual(j.lines.map((l) => [l.account, l.debit, l.credit]), [['1100', 118000, 0], ['4100', 0, 100000], ['2100', 0, 18000]]);
  // front office cannot void; manager can, with a reason
  assert.equal((await fo.post(`/api/charges/${charge.id}/void`, { reason: 'x' })).status, 403);
  assert.equal((await mgr.post(`/api/charges/${charge.id}/void`, {})).status, 400);
  ok(await mgr.post(`/api/charges/${charge.id}/void`, { reason: 'Posted to wrong room' }));
  assert.equal((await mgr.post(`/api/charges/${charge.id}/void`, { reason: 'again' })).status, 409);
  ok(await fo.post(`/api/reservations/${stay.id}/charges`, { description: 'Laundry', department: 'amenities', amount: 30000 }));
  let f = ok(await fo.get(`/api/reservations/${stay.id}`));
  assert.equal(f.totals.balance, 30000);
  // cannot check out with a balance
  assert.equal((await fo.post(`/api/reservations/${stay.id}/check-out`)).status, 409);
  assert.equal((await fo.post(`/api/reservations/${stay.id}/payments`, { method: 'bitcoin', amount: 30000 })).status, 400);
  assert.equal((await fo.post(`/api/reservations/${stay.id}/payments`, { method: 'company_account', amount: 30000 })).status, 400); // needs company
  ok(await fo.post(`/api/reservations/${stay.id}/payments`, { method: 'mobile_money', amount: 30000, reference: 'MM123' }));
  f = ok(await fo.get(`/api/reservations/${stay.id}`));
  assert.equal(f.totals.balance, 0);
  assert.equal(f.reservation.id_number, 'A1234567');
});

test('night audit posts room charges, marks no-shows and advances the date', async () => {
  const night = client(); await night.login('nightaudit', 'password-123');
  // a guest due out today blocks the audit until handled
  const std = await typeId(admin, 'STD');
  const leaving = ok(await book(admin, std, DAY0, '2026-11-11', 'Leaving'));
  ok(await admin.post(`/api/reservations/${leaving.id}/check-in`, { room_id: await roomId(admin, '101') }));
  const noshow = ok(await book(admin, std, DAY0, '2026-11-12', 'Noshow'));
  // Stays still "Reserved" for DAY0 from earlier tests will also become no-shows.
  const r1 = await night.post('/api/night-audit');
  assert.equal(r1.status, 200, JSON.stringify(r1.data)); // nobody departs on DAY0 yet
  assert.equal(r1.data.closed_date, DAY0); assert.equal(r1.data.new_business_date, '2026-11-11');
  assert.equal(r1.data.room_charges_posted, 2); // Sarah + Leaving
  assert.equal(r1.data.room_revenue, 300000 + 250000);
  const ns = ok(await admin.get(`/api/reservations/${noshow.id}`));
  assert.equal(ns.reservation.status, 'no_show');
  // the next day "Leaving" is due out: audit is blocked until they check out
  const blocked = await night.post('/api/night-audit');
  assert.equal(blocked.status, 409); assert.equal(blocked.data.details.pending_departures.length, 1);
  const lf = ok(await admin.get(`/api/reservations/${leaving.id}`));
  assert.equal(lf.totals.balance, 250000);
  ok(await admin.post(`/api/reservations/${leaving.id}/payments`, { method: 'cash', amount: 250000 }));
  ok(await admin.post(`/api/reservations/${leaving.id}/check-out`));
  const board = ok(await admin.get('/api/room-board'));
  assert.equal(board.rooms.find((r) => r.number === '101').hk_status, 'dirty');
  const r2 = ok(await night.post('/api/night-audit'));
  assert.equal(r2.room_charges_posted, 1); // Sarah only
  const sarah = ok(await admin.get(`/api/reservations/${stay.id}`));
  assert.equal(sarah.charges.filter((c) => c.department === 'rooms' && !c.voided).length, 2);
  // daily report for the first audited day
  const rep = ok(await admin.get(`/api/reports/daily?date=${DAY0}`));
  assert.equal(rep.audited, true); assert.equal(rep.occupied_rooms, 2); assert.equal(rep.revenue.rooms, 550000);
});

test('in-house stay can be extended; early check-out shortens it', async () => {
  const s = ok(await admin.get('/api/auth/me')).settings; // business date now 2026-11-12 = Sarah's departure
  assert.equal(s.business_date, '2026-11-12');
  ok(await admin.put(`/api/reservations/${stay.id}`, { departure: '2026-11-14' }));
  const f = ok(await admin.get(`/api/reservations/${stay.id}`));
  ok(await admin.post(`/api/reservations/${stay.id}/payments`, { method: 'card', amount: f.totals.balance }));
  ok(await admin.post(`/api/reservations/${stay.id}/check-out`));
  const done = ok(await admin.get(`/api/reservations/${stay.id}`));
  assert.equal(done.reservation.status, 'checked_out'); assert.equal(done.reservation.departure, '2026-11-12');
});

test('the books always balance and unbalanced entries are rejected by the database', async () => {
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
  assert.ok(tb.total_debit > 0);
  const vat = tb.lines.find((l) => l.code === '2100');
  assert.ok(vat.credit > 0);
  await assert.rejects(async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [e] } = await c.query("INSERT INTO journal_entries (business_date, description) VALUES ('2026-11-12', 'bad') RETURNING id");
      await c.query("INSERT INTO journal_lines (entry_id, account_code, debit) VALUES ($1, '1000', 500)", [e.id]);
      await c.query('COMMIT');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  }, /does not balance/);
});

test('housekeeping role, cancellations and the audit trail', async () => {
  const hk = client(); await hk.login('housekeep', 'password-123');
  const r101 = await roomId(hk, '101');
  ok(await hk.patch(`/api/rooms/${r101}/housekeeping`, { hk_status: 'clean' }));
  const std = await typeId(admin, 'STD');
  assert.equal((await book(hk, std, '2026-12-10', '2026-12-11')).status, 403);
  const r = ok(await book(admin, std, '2026-12-10', '2026-12-11', 'Cancel'));
  assert.equal((await admin.post(`/api/reservations/${r.id}/cancel`, {})).status, 400);
  ok(await admin.post(`/api/reservations/${r.id}/cancel`, { reason: 'Guest changed plans' }));
  const log = ok(await admin.get('/api/audit-log?limit=500'));
  const actions = new Set(log.map((l) => l.action));
  for (const a of ['auth.login', 'auth.login_failed', 'reservation.create', 'reservation.check_in', 'folio.charge', 'folio.void_charge', 'folio.payment', 'reservation.check_out', 'night_audit.run', 'reservation.cancel', 'room.housekeeping']) {
    assert.ok(actions.has(a), `missing audit action ${a}`);
  }
});
