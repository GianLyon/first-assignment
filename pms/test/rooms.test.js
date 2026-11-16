// Phase 16: room blocks (out of order / out of service) and the housekeeping board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, DAY0, ctx } from './helpers.js';

let admin, mgr, fd, maid1, maid2, maint;
const free = async (type, a, d) => (await ctx.pool.query("SELECT 1")).rows && ok(await fd.get(`/api/reservations/quote?arrival=${a}&departure=${d}`)).room_types.find((t) => t.code === type).available;
const res = (type, a, d, first = 'Guest') => fd.post('/api/reservations', { room_type_id: type, arrival: a, departure: d, guest: { first_name: first, last_name: 'Test' } });

before(async () => {
  await startTestServer({ operations: true, distribution: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['manager1', 'manager'], ['frontdesk', 'front_office'], ['maid1', 'housekeeping'], ['maid2', 'housekeeping'], ['fixer', 'maintenance']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  mgr = client(); await mgr.login('manager1', 'password-123');
  fd = client(); await fd.login('frontdesk', 'password-123');
  maid1 = client(); await maid1.login('maid1', 'password-123');
  maid2 = client(); await maid2.login('maid2', 'password-123');
  maint = client(); await maint.login('fixer', 'password-123');
});
after(stopTestServer);

test('a dated block takes the room off sale for those nights only, then hands it back', async () => {
  const ste = await typeId(fd, 'STE'), r301 = await roomId(fd, '301');
  assert.equal(await free('STE', '2026-11-12', '2026-11-13'), 4);
  // housekeeping blocks room 301 from the 12th to the 15th (back on the 15th) for painting
  const b = ok(await maid1.post('/api/room-blocks', { room_id: r301, kind: 'out_of_order', date_from: '2026-11-12', date_to: '2026-11-15', category: 'painting', reason: 'Walls repainted after a leak' }));
  assert.equal(await free('STE', '2026-11-12', '2026-11-13'), 3);
  assert.equal(await free('STE', '2026-11-14', '2026-11-15'), 3);
  assert.equal(await free('STE', '2026-11-15', '2026-11-16'), 4); // back on sale
  assert.equal(await free('STE', DAY0, '2026-11-11'), 4); // not yet
  // today it is still in service on the room board
  const board = ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === '301');
  assert.equal(board.hk_status, 'clean'); assert.equal(board.next_block, '2026-11-12');
  // validation
  assert.equal((await maid1.post('/api/room-blocks', { room_id: r301, date_from: '2026-11-13', date_to: '2026-11-14', reason: 'x' })).status, 409); // overlaps
  assert.equal((await maid1.post('/api/room-blocks', { room_id: r301, date_from: '2026-11-01', reason: 'x' })).status, 400); // in the past
  assert.equal((await maid1.post('/api/room-blocks', { room_id: r301, date_from: '2026-11-20', date_to: '2026-11-20', reason: 'x' })).status, 400);
  assert.equal((await maid1.post('/api/room-blocks', { room_id: r301, date_from: '2026-11-20' })).status, 400); // no reason
  // the night audit makes it active on the 12th, and hands it back on the 15th
  ok(await admin.post('/api/night-audit')); // → 11th
  ok(await admin.post('/api/night-audit')); // → 12th
  assert.equal(ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === '301').hk_status, 'out_of_order');
  assert.equal((await fd.post(`/api/reservations/${ok(await res(ste, '2026-11-12', '2026-11-13')).id}/check-in`, { room_id: r301 })).status, 409);
  ok(await admin.post('/api/night-audit')); ok(await admin.post('/api/night-audit')); ok(await admin.post('/api/night-audit')); // → 15th
  // the 12th's guest was a no-show; 301 is back, dirty for cleaning, block closed
  assert.equal(ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === '301').hk_status, 'dirty');
  const past = ok(await fd.get('/api/room-blocks?scope=past')).blocks.find((x) => x.id === b.id);
  assert.ok(past.released_at); assert.equal(past.date_to, '2026-11-15');
});

test('blocking refuses to overbook and to throw a guest out; a forced block flags it', async () => {
  const bd = ok(await fd.get('/api/room-board')).business_date.slice(0, 10); // 15 Nov
  const ste = await typeId(fd, 'STE');
  // 3 of the 4 suites are booked for the 20th
  for (let i = 0; i < 3; i++) ok(await res(ste, '2026-11-20', '2026-11-21', `Suite${i}`));
  const r302 = await roomId(fd, '302'), r303 = await roomId(fd, '303');
  ok(await maid1.post('/api/room-blocks', { room_id: r302, date_from: '2026-11-19', date_to: '2026-11-22', reason: 'New carpet' })); // 3 left, 3 booked: fine
  const over = await maid1.post('/api/room-blocks', { room_id: r303, date_from: '2026-11-20', date_to: '2026-11-21', reason: 'Bathroom tiles' });
  assert.equal(over.status, 409); assert.match(over.data.error, /would overbook Executive Suite on 1 night \(2026-11-20\)/);
  assert.deepEqual(over.data.details.overbooked_nights, ['2026-11-20']);
  // a guest in the room: only from their departure
  const g = ok(await res(ste, bd, '2026-11-17', 'Inhouse'));
  ok(await fd.post(`/api/reservations/${g.id}/check-in`, { room_id: r303, allow_dirty: true }));
  const inRoom = await maid1.post('/api/room-blocks', { room_id: r303, reason: 'AC broken' });
  assert.equal(inRoom.status, 409); assert.match(inRoom.data.error, /until 2026-11-17/);
  // out of service keeps selling (the guest is told), no checks against sales
  ok(await maid1.post('/api/room-blocks', { room_id: r303, kind: 'out_of_service', reason: 'TV remote missing' }));
  const list = ok(await fd.get('/api/room-blocks?scope=current')).blocks;
  assert.ok(list.some((x) => x.room === '303' && x.kind === 'out_of_service'));
  assert.equal(ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === '303').block.kind, 'out_of_service');
});

test('a fault reported with "room out of order" blocks the room until the job is done', async () => {
  const r205 = await roomId(fd, '205');
  const dlxBefore = await free('DLX', '2026-11-25', '2026-11-26');
  const w = ok(await maid2.post('/api/ops/work-orders', { title: 'Shower mixer leaking', room_id: r205, priority: 'high', room_out_of_order: true, category: 'plumbing' }));
  const blk = ok(await fd.get('/api/room-blocks?scope=current')).blocks.find((x) => x.work_order_id === w.id);
  assert.equal(blk.date_to, null); // until fixed
  assert.equal(blk.room, '205');
  assert.equal(ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === '205').hk_status, 'out_of_order');
  assert.equal(await free('DLX', '2026-11-25', '2026-11-26'), dlxBefore - 1); // off sale for future nights too, until fixed
  // the plumber finishes: block released, the room goes to housekeeping
  ok(await maint.put(`/api/ops/work-orders/${w.id}`, { status: 'done', completion_notes: 'Replaced cartridge' }));
  assert.equal(ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === '205').hk_status, 'dirty');
  assert.equal(await free('DLX', '2026-11-25', '2026-11-26'), dlxBefore);
  // marking a room out of order on the board is a block too; marking it clean releases it
  const r206 = await roomId(fd, '206');
  ok(await maid1.patch(`/api/rooms/${r206}/housekeeping`, { hk_status: 'out_of_order', reason: 'Broken window' }));
  assert.ok(ok(await fd.get('/api/room-blocks')).blocks.some((x) => x.room === '206' && x.reason === 'Broken window'));
  ok(await maid1.patch(`/api/rooms/${r206}/housekeeping`, { hk_status: 'clean' }));
  assert.ok(!ok(await fd.get('/api/room-blocks')).blocks.some((x) => x.room === '206'));
  // extend and release
  const r207 = await roomId(fd, '207');
  const b = ok(await maint.post('/api/room-blocks', { room_id: r207, date_from: '2026-11-28', date_to: '2026-11-29', reason: 'Re-grouting' }));
  ok(await maint.put(`/api/room-blocks/${b.id}`, { date_to: '2026-11-30' }));
  assert.equal(ok(await fd.get('/api/room-blocks?scope=upcoming')).blocks.find((x) => x.id === b.id).date_to, '2026-11-30');
  ok(await maint.post(`/api/room-blocks/${b.id}/release`, { notes: 'Postponed' }));
  assert.equal(await free('DLX', '2026-11-28', '2026-11-29'), dlxBefore);
});

test('housekeeping board: the day\'s rooms, shared out fairly, done from a phone, inspected by the supervisor', async () => {
  ok(await mgr.post('/api/housekeeping/generate'));
  let b = ok(await mgr.get('/api/housekeeping/board'));
  assert.ok(b.supervisor);
  assert.ok(b.tasks.length > 0);
  assert.ok(b.tasks.every((t) => t.hk_status !== 'out_of_order'));
  const stay = b.tasks.find((t) => t.number === '303'); // the in-house guest
  assert.equal(stay.kind, 'stayover'); assert.equal(stay.guest, 'Inhouse Test');
  assert.equal((await maid1.post('/api/housekeeping/generate')).status, 403);
  // share them out
  const a = ok(await mgr.post('/api/housekeeping/assign'));
  assert.equal(a.assigned, b.tasks.length);
  b = ok(await mgr.get('/api/housekeeping/board'));
  const [p1, p2] = b.attendants;
  assert.ok(Math.abs(p1.credits - p2.credits) <= 2, `fair split: ${p1.credits} vs ${p2.credits}`);
  // each attendant sees only their own rooms
  const mine = ok(await maid1.get('/api/housekeeping/board'));
  assert.equal(mine.supervisor, false);
  assert.ok(mine.tasks.length && mine.tasks.every((t) => t.assigned_name === 'MAID1'));
  const other = ok(await maid2.get('/api/housekeeping/board')).tasks[0];
  assert.equal((await maid1.post(`/api/housekeeping/tasks/${other.id}/start`)).status, 403);
  // start and finish a room: it becomes clean
  const t = mine.tasks.find((x) => x.hk_status === 'dirty') || mine.tasks[0];
  ok(await maid1.post(`/api/housekeeping/tasks/${t.id}/start`));
  ok(await maid1.post(`/api/housekeeping/tasks/${t.id}/done`, { notes: 'Changed bulb' }));
  assert.equal(ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === t.number).hk_status, 'clean');
  assert.equal((await maid1.post(`/api/housekeeping/tasks/${t.id}/inspect`)).status, 403);
  // the supervisor sends it back, then passes it
  assert.equal((await mgr.post(`/api/housekeeping/tasks/${t.id}/redo`)).status, 400);
  ok(await mgr.post(`/api/housekeeping/tasks/${t.id}/redo`, { notes: 'Bathroom mirror smeared' }));
  assert.equal(ok(await fd.get('/api/room-board')).rooms.find((r) => r.number === t.number).hk_status, 'dirty');
  ok(await maid1.post(`/api/housekeeping/tasks/${t.id}/done`));
  ok(await mgr.post(`/api/housekeeping/tasks/${t.id}/inspect`));
  // do not disturb
  const dnd = ok(await maid2.get('/api/housekeeping/board')).tasks.find((x) => x.status === 'pending');
  assert.equal((await maid2.post(`/api/housekeeping/tasks/${dnd.id}/skip`, { reason: 'sleeping' })).status, 400);
  ok(await maid2.post(`/api/housekeeping/tasks/${dnd.id}/skip`, { reason: 'dnd' }));
  // reassign
  ok(await mgr.put(`/api/housekeeping/tasks/${dnd.id}/assign`, { user_id: p1.id }));
  const after = ok(await mgr.get('/api/housekeeping/board'));
  assert.equal(after.tasks.find((x) => x.id === dnd.id).assigned_to, p1.id);
  assert.equal(after.totals.inspected, 1); assert.equal(after.totals.skipped, 1);
  // the stayover's guest checks out after their room was serviced: it needs a departure clean
  const g = after.tasks.find((x) => x.number === '303');
  ok(await mgr.post(`/api/housekeeping/tasks/${g.id}/done`));
  const resv = (await ctx.pool.query("SELECT id FROM reservations WHERE status='in_house' AND room_id=$1", [g.room_id])).rows[0];
  const bal = ok(await fd.get(`/api/reservations/${resv.id}`)).totals.balance;
  if (bal > 0) ok(await fd.post(`/api/reservations/${resv.id}/payments`, { amount: bal, method: 'cash' }));
  ok(await fd.post(`/api/reservations/${resv.id}/check-out`));
  ok(await mgr.post('/api/housekeeping/generate'));
  const again = ok(await mgr.get('/api/housekeeping/board')).tasks.find((x) => x.number === '303');
  assert.deepEqual([again.kind, again.status], ['departure', 'pending']);
});
