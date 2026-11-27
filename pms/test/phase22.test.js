// Phase 22: giving bookings their room before arrival, and setting up a hotel's rooms in one go.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, DAY0, ctx } from './helpers.js';

let admin, fd;
const book = (type, a, d, first = 'Guest') => fd.post('/api/reservations', { room_type_id: type, arrival: a, departure: d, guest: { first_name: first, last_name: 'Test' } });

before(async () => {
  await startTestServer({});
  admin = client(); await admin.login('admin', 'admin-pass-123');
  ok(await admin.post('/api/users', { username: 'fd1', full_name: 'Front Desk', role: 'front_office', password: 'password-123' }));
  fd = client(); await fd.login('fd1', 'password-123');
});
after(stopTestServer);

test('a future booking can hold a room; nobody else gets it for those nights; check-in uses it', async () => {
  const ste = await typeId(fd, 'STE'), r301 = await roomId(fd, '301');
  const a = ok(await book(ste, '2026-11-20', '2026-11-23', 'Alice'));
  const opts = ok(await fd.get(`/api/reservations/${a.id}/rooms`));
  assert.ok(opts.rooms.find((x) => x.id === r301 && x.same_type && x.free));
  assert.equal(ok(await fd.post(`/api/reservations/${a.id}/assign-room`, { room_id: r301 })).room, '301');
  assert.equal(ok(await fd.get(`/api/reservations/${a.id}`)).reservation.room_number, '301');

  // an overlapping booking cannot hold 301, a later one can
  const b = ok(await book(ste, '2026-11-22', '2026-11-24', 'Bob'));
  const clash = await fd.post(`/api/reservations/${b.id}/assign-room`, { room_id: r301 });
  assert.equal(clash.status, 409); assert.match(clash.data.error, /held for Alice/);
  assert.equal(ok(await fd.get(`/api/reservations/${b.id}/rooms`)).rooms.find((x) => x.id === r301).free, false);
  const c = ok(await book(ste, '2026-11-23', '2026-11-25', 'Cara'));
  ok(await fd.post(`/api/reservations/${c.id}/assign-room`, { room_id: r301 })); // Alice leaves the 23rd

  // only rooms of the booked type
  const std = await typeId(fd, 'STD');
  const other = (await fd.get('/api/rooms')).data.find((x) => x.room_type_id === std);
  const wrong = await fd.post(`/api/reservations/${a.id}/assign-room`, { room_id: other.id });
  assert.equal(wrong.status, 409); assert.match(wrong.data.error, /Edit stay/);

  // a walk-in today cannot be checked in to a room held for a booking whose nights overlap
  const w = ok(await book(ste, DAY0, '2026-11-21', 'Walker'));
  const ci = await fd.post(`/api/reservations/${w.id}/check-in`, { room_id: r301 });
  assert.equal(ci.status, 409); assert.match(ci.data.error, /not free/);
  ok(await fd.post(`/api/reservations/${w.id}/check-in`, { room_id: await roomId(fd, '302') }));

  // moving dates so the held room clashes lets it go
  const moved = ok(await fd.put(`/api/reservations/${c.id}`, { arrival: '2026-11-21', departure: '2026-11-24' }));
  assert.equal(moved.released_room, '301');
  assert.equal(ok(await fd.get(`/api/reservations/${c.id}`)).reservation.room_number, null);
  // release by hand
  ok(await fd.post(`/api/reservations/${a.id}/assign-room`, { room_id: null }));
  assert.equal(ok(await fd.get(`/api/reservations/${a.id}`)).reservation.room_number, null);
});

test('arrivals of the day get rooms automatically; the held room is used at check-in', async () => {
  const dlx = await typeId(fd, 'DLX');
  const a = ok(await book(dlx, DAY0, '2026-11-12', 'Auto'));
  const x = ok(await fd.post('/api/reservations/auto-assign', {}));
  const mine = x.assigned.find((y) => y.code === a.code);
  assert.ok(mine);
  const dash = ok(await fd.get('/api/dashboard'));
  assert.equal(dash.arrivals.find((y) => y.id === a.id).room_number, mine.room);
  const board = ok(await fd.get('/api/room-board'));
  assert.equal(board.rooms.find((y) => y.number === mine.room).held.guest, 'Auto Test');
  // check in without choosing: the held room is used
  ok(await fd.post(`/api/reservations/${a.id}/check-in`, {}));
  assert.equal(ok(await fd.get(`/api/reservations/${a.id}`)).reservation.room_number, mine.room);
});

test('the Amaya layout loads 36 rooms in 7 types, grouped, with buildings and floors', async () => {
  const text = (await admin.get('/api/rooms/presets/amaya')).data ?? null;
  // the preset is plain text, read it from disk for the import
  const csv = fs.readFileSync(new URL('../src/presets/amaya-rooms.csv', import.meta.url), 'utf8');
  assert.equal(text, null); // not JSON
  assert.equal((await fd.post('/api/rooms/import', { text: csv })).status, 403); // front desk cannot
  // rooms in use (in house / held) and not in the list block a full replace: room 110 is held for a booking
  const h = ok(await book(await typeId(fd, 'STD'), '2026-11-15', '2026-11-16', 'Holder'));
  ok(await fd.post(`/api/reservations/${h.id}/assign-room`, { room_id: await roomId(fd, '110') }));
  const blocked = await admin.post('/api/rooms/import', { text: csv, replace: true });
  assert.equal(blocked.status, 409); assert.match(blocked.data.error, /110/);
  ok(await fd.post(`/api/reservations/${h.id}/assign-room`, { room_id: null }));
  const r = ok(await admin.post('/api/rooms/import', { text: csv, replace: true }));
  assert.equal(r.rooms, 36); assert.equal(r.types_created, 6); // DLX already existed and is reused
  assert.equal(r.rooms_retired, 10); assert.equal(r.types_retired, 2); // old rooms 106-110 and 206-210, old types STD and STE
  assert.equal(ok(await admin.get('/api/rooms')).find((x) => x.number === '110').active, false);
  const types = ok(await admin.get('/api/room-types'));
  const by = Object.fromEntries(types.map((t) => [t.code, t]));
  assert.equal(by.SSP.category, 'Serviced apartments'); assert.equal(by.EXE.category, 'Hotel rooms'); assert.equal(by.PH.name, 'Penthouse');
  const rooms = ok(await admin.get('/api/rooms'));
  const room = (n) => rooms.find((x) => x.number === n);
  assert.deepEqual([room('102').type_code, room('102').building, room('102').floor, room('102').view], ['SSP', 'Apartments', '1', 'pool']);
  assert.deepEqual([room('305').type_code, room('305').floor], ['SCV', '3']);
  assert.deepEqual([room('701').type_code, room('701').building, room('701').floor], ['DLX', 'Hotel', '6']);
  assert.deepEqual([room('507').type_code, room('507').floor], ['TWN', '4']);
  assert.equal(room('706').type_code, 'PH');
  assert.equal(rooms.filter((x) => x.type_code === 'EXE').length, 12);
  // importing twice updates rather than duplicates
  const again = ok(await admin.post('/api/rooms/import', { text: csv }));
  assert.equal(again.rooms_created, 0); assert.equal(again.types_created, 0);
  // validation
  assert.equal((await admin.post('/api/rooms/import', { text: '101,SSP\n101,SSP' })).status, 400);
  assert.equal((await admin.post('/api/rooms/import', { text: '999,SSP,x,y,z,1,ocean' })).status, 400);
  // a group set from the room type form
  ok(await admin.put(`/api/room-types/${by.TWN.id}`, { name: 'Twin', base_rate: 250000, max_occupancy: 2, category: 'Hotel rooms' }));
  assert.equal(ok(await admin.get('/api/room-types')).find((t) => t.code === 'TWN').base_rate, 250000);
});
