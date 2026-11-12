// Phase 10: registration card, room moves, extensions, letterhead, dashboard analytics and sample data (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, book, DAY0, ctx } from './helpers.js';

let admin, fd, mgr, acc;
before(async () => {
  await startTestServer({ inventory: true, distribution: true, operations: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['frontdesk', 'front_office'], ['manager1', 'manager'], ['accounts1', 'accountant']]) ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  fd = client(); await fd.login('frontdesk', 'password-123');
  mgr = client(); await mgr.login('manager1', 'password-123');
  acc = client(); await acc.login('accounts1', 'password-123');
});
after(stopTestServer);

test('sample data: added through the real system, balanced, removable; only on a new system, only by an administrator', async () => {
  assert.equal((await mgr.post('/api/demo', { days: 10 })).status, 403);
  ok(await admin.post('/api/demo', { days: 10 }));
  let st;
  for (let i = 0; i < 300; i++) { st = ok(await admin.get('/api/demo')); if (!st.running) break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(st.error, null, st.error);
  assert.equal(st.demo_data, true);
  const s = ok(await admin.get('/api/settings'));
  assert.equal(s.business_date, DAY0); // back on the original working day
  assert.equal(s.group_token_hash, undefined);
  const { rows: [x] } = await ctx.pool.query(`SELECT (SELECT count(*) FROM night_audits)::int AS audits, (SELECT count(*) FROM reservations WHERE status='in_house')::int AS inhouse,
    (SELECT count(*) FROM reservations WHERE status='reserved' AND arrival > $1)::int AS future, (SELECT count(*) FROM pos_checks WHERE status='settled')::int AS checks,
    (SELECT SUM(debit) - SUM(credit) FROM journal_lines)::bigint AS diff, (SELECT count(*) FROM expenses)::int AS expenses`, [DAY0]);
  assert.equal(x.audits, 10);
  assert.ok(x.inhouse > 0 && x.future > 0 && x.checks > 50 && x.expenses > 10, JSON.stringify(x));
  assert.equal(Number(x.diff), 0); // the books balance
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
  // never twice
  assert.equal((await admin.post('/api/demo', { days: 10 })).status, 409);
  // the dashboard figures agree with the profit & loss
  const a = ok(await mgr.get(`/api/analytics?from=2026-10-31&to=2026-11-09`));
  const pl = ok(await mgr.get('/api/finance/pl?from=2026-10-31&to=2026-11-09'));
  assert.equal(a.totals.income, pl.total_revenue);
  assert.equal(a.totals.expenses, pl.total_cost_of_sales + pl.total_expenses);
  assert.equal(a.arms.reduce((t, r) => t + r.amount, 0), a.totals.income);
  assert.equal(a.audited_days, 10);
  assert.equal(a.totals.rooms_sold, a.daily.reduce((t, d) => t + (d.rooms_sold || 0), 0));
  assert.equal(a.room_types.reduce((t, r) => t + r.nights, 0), a.totals.rooms_sold);
  assert.ok(a.totals.occupancy > 0.3 && a.totals.occupancy <= 1);
  assert.equal((await fd.get('/api/analytics')).status, 200); // front office sees the daily report already
  assert.equal((await client().get('/api/analytics')).status, 401);

  // remove it all; set-up stays
  assert.equal((await admin.post('/api/demo/remove', { confirm: 'wrong name' })).status, 400);
  const rm = ok(await admin.post('/api/demo/remove', { confirm: 'Test Hotel' }));
  assert.match(rm.business_date, /^\d{4}-\d{2}-\d{2}$/);
  const { rows: [y] } = await ctx.pool.query(`SELECT (SELECT count(*) FROM reservations)::int AS res, (SELECT count(*) FROM guests)::int AS guests, (SELECT count(*) FROM journal_entries)::int AS je,
    (SELECT count(*) FROM rooms)::int AS rooms, (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM menu_items)::int AS menu, (SELECT demo_data FROM settings) AS demo`);
  assert.deepEqual([y.res, y.guests, y.je, y.demo], [0, 0, 0, false]);
  assert.ok(y.rooms > 0 && y.users >= 4 && y.menu > 0);
  assert.equal((await admin.post('/api/demo/remove', { confirm: 'Test Hotel' })).status, 409); // nothing left to remove
  // back to the business date the tests use
  await ctx.pool.query('UPDATE settings SET business_date=$1', [DAY0]);
});

test('registration card at check-in, and editing it later', async () => {
  const r = ok(await book(fd, await typeId(fd, 'STD'), DAY0, '2026-11-12', 'Reg'));
  assert.equal((await fd.post(`/api/reservations/${r.id}/check-in`, { room_id: await roomId(fd, '101'), guest: { id_type: 'Library card' } })).status, 400);
  assert.equal((await fd.post(`/api/reservations/${r.id}/check-in`, { room_id: await roomId(fd, '101'), guest: { birth_date: '1990-13-45' } })).status, 400);
  ok(await fd.post(`/api/reservations/${r.id}/check-in`, { room_id: await roomId(fd, '101'),
    guest: { first_name: 'Grace', last_name: 'Namuli', gender: 'female', birth_date: '1991-04-02', nationality: 'Ugandan', address: 'Plot 4, Ntinda, Kampala', id_type: 'National ID', id_number: 'CF91012345ABCD', id_issued_by: 'NIRA Uganda', id_expiry: '2031-04-01' },
    stay: { purpose: 'business', coming_from: 'Mbarara', going_to: 'Gulu', vehicle_reg: 'UBA 123X' } }));
  let f = ok(await fd.get(`/api/reservations/${r.id}`)).reservation;
  assert.equal(f.first_name, 'Grace');
  assert.equal(f.id_expiry, '2031-04-01');
  assert.equal(f.purpose, 'business');
  assert.equal(f.vehicle_reg, 'UBA 123X');
  assert.equal(f.phone, '+256700000000'); // not sent at check-in: kept
  ok(await fd.put(`/api/reservations/${r.id}/registration`, { guest: { first_name: 'Grace', last_name: 'Namuli-Okello', email: 'grace@example.com', id_type: 'Passport', id_number: 'B1234567' }, stay: { purpose: 'leisure' } }));
  f = ok(await fd.get(`/api/reservations/${r.id}`)).reservation;
  assert.equal(f.last_name, 'Namuli-Okello');
  assert.equal(f.id_type, 'Passport');
  assert.equal(f.vehicle_reg, null); // the whole card is saved when editing
  assert.equal((await acc.put(`/api/reservations/${r.id}/registration`, { guest: { first_name: 'X' } })).status, 403);
});

test('moving rooms: reason required, rules checked, history kept, new rate charged', async () => {
  const r = ok(await book(fd, await typeId(fd, 'STD'), DAY0, '2026-11-13', 'Mover', { rate: 250000 }));
  ok(await fd.post(`/api/reservations/${r.id}/check-in`, { room_id: await roomId(fd, '102') }));
  const occupied = await roomId(fd, '101');
  assert.equal((await fd.post(`/api/reservations/${r.id}/move`, { room_id: await roomId(fd, '103') })).status, 400); // no reason
  assert.equal((await fd.post(`/api/reservations/${r.id}/move`, { room_id: occupied, reason: 'Noise' })).status, 409);
  const m1 = ok(await fd.post(`/api/reservations/${r.id}/move`, { room_id: await roomId(fd, '103'), reason: 'Air conditioner not working' }));
  assert.deepEqual([m1.from, m1.to, m1.rate], ['102', '103', 250000]);
  const rooms = ok(await fd.get('/api/rooms'));
  assert.equal(rooms.find((x) => x.number === '102').hk_status, 'dirty');
  // upgrade to a suite at a new rate from tonight
  const m2 = ok(await fd.post(`/api/reservations/${r.id}/move`, { room_id: await roomId(fd, '301'), reason: 'Upgrade on request', rate: 400000 }));
  assert.equal(m2.rate, 400000);
  const f = ok(await fd.get(`/api/reservations/${r.id}`));
  assert.equal(f.reservation.room_number, '301');
  assert.equal(f.reservation.room_type_code, 'STE');
  assert.deepEqual(f.moves.map((m) => [m.from_room, m.to_room, m.reason]), [['102', '103', 'Air conditioner not working'], ['103', '301', 'Upgrade on request']]);
  // reserved guests cannot be "moved"; front office may move, accountant may not
  const later = ok(await book(fd, await typeId(fd, 'STD'), '2026-11-15', '2026-11-16', 'Later'));
  assert.equal((await fd.post(`/api/reservations/${later.id}/move`, { room_id: await roomId(fd, '104'), reason: 'x' })).status, 409);
  assert.equal((await acc.post(`/api/reservations/${r.id}/move`, { room_id: await roomId(fd, '104'), reason: 'x' })).status, 403);
  // tonight's room charge uses the new rate
  ok(await fd.put(`/api/reservations/${r.id}`, { departure: '2026-11-14' })); // extend by a night
  const pre = ok(await admin.get('/api/night-audit'));
  for (const d of pre.preview?.pending_departures || []) {
    const ff = ok(await fd.get(`/api/reservations/${d.id}`));
    if (ff.totals.balance > 0) ok(await fd.post(`/api/reservations/${d.id}/payments`, { method: 'cash', amount: ff.totals.balance }));
    ok(await fd.post(`/api/reservations/${d.id}/check-out`));
  }
  ok(await admin.post('/api/night-audit'));
  const after = ok(await fd.get(`/api/reservations/${r.id}`));
  assert.equal(after.charges.find((c) => /Room charge/.test(c.description)).amount, 400000);
  assert.equal(after.reservation.departure, '2026-11-14');
});

test('letterhead: details and logo for printing', async () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await fd.put('/api/settings/letterhead', { legal_name: 'X' })).status, 403);
  assert.equal((await admin.put('/api/settings/letterhead', { logo: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400);
  assert.equal((await admin.put('/api/settings/letterhead', { contact_email: 'nope' })).status, 400);
  ok(await admin.put('/api/settings/letterhead', { legal_name: 'Amaya Hotels Ltd', address: 'Plot 12, Lake Drive\nP.O. Box 123, Entebbe', contact_phone: '+256 414 000 000', contact_email: 'info@amaya.example',
    website: 'amaya.example', tin: '1000099999', invoice_footer: 'Stanbic Bank, A/C 9030000000000', logo: tinyPng }));
  let s = ok(await fd.get('/api/settings'));
  assert.equal(s.legal_name, 'Amaya Hotels Ltd');
  assert.equal(s.logo, tinyPng);
  ok(await admin.put('/api/settings/letterhead', { legal_name: 'Amaya Hotels Ltd' })); // logo not sent: kept
  assert.equal(ok(await fd.get('/api/settings')).logo, tinyPng);
  ok(await admin.put('/api/settings/letterhead', { legal_name: 'Amaya Hotels Ltd', logo: null }));
  s = ok(await fd.get('/api/auth/me')).settings;
  assert.equal(s.logo, null);
  assert.equal(s.group_token_hash, undefined);
});
