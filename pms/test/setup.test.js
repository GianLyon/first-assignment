// Phase 15: fuller guest profiles, room types, rooms, rate plans and staff records.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, DAY0, ctx } from './helpers.js';

let admin, fd;
before(async () => {
  await startTestServer({ distribution: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  ok(await admin.post('/api/users', { username: 'frontdesk', full_name: 'Front Desk', role: 'front_office', password: 'password-123', email: 'fd@hotel.example', phone: '0772 000 111', department: 'Front office', job_title: 'Receptionist' }));
  fd = client(); await fd.login('frontdesk', 'password-123');
});
after(stopTestServer);

test('staff records: contact, department and job title', async () => {
  const u = ok(await admin.get('/api/users')).find((x) => x.username === 'frontdesk');
  assert.deepEqual([u.email, u.phone, u.department, u.job_title], ['fd@hotel.example', '0772 000 111', 'Front office', 'Receptionist']);
  assert.equal((await admin.put(`/api/users/${u.id}`, { department: 'Spaceship' })).status, 400);
  assert.equal((await admin.put(`/api/users/${u.id}`, { email: 'bad' })).status, 400);
  ok(await admin.put(`/api/users/${u.id}`, { full_name: 'Front Desk', email: 'fd@hotel.example', phone: '0772 000 222', department: 'Front office', job_title: 'Head receptionist' }));
  assert.equal(ok(await admin.get('/api/users')).find((x) => x.id === u.id).job_title, 'Head receptionist');
  const lists = ok(await fd.get('/api/setup-lists'));
  assert.ok(lists.departments.includes('Housekeeping') && lists.room_prefs.includes('high_floor') && lists.meal_plans.includes('hb'));
});

test('guest profile: title, contacts, address, work, language, preferences from a list, diet, allergies, anniversary, contact choices', async () => {
  const r = ok(await fd.post('/api/reservations', { room_type_id: await typeId(fd, 'STD'), arrival: DAY0, departure: '2026-11-11', guest: { first_name: 'Agnes', last_name: 'Nakato' } }));
  const gid = r.guest_id;
  const body = { title: 'Dr', first_name: 'Agnes', last_name: 'Nakato', gender: 'female', email: 'agnes@example.com', phone: '0772 333 444', phone2: '0414 222 111',
    address: 'Plot 5, Kololo Hill Drive', city: 'Kampala', country: 'Uganda', nationality: 'Ugandan', employer: 'Makerere University', occupation: 'Lecturer', language: 'Luganda',
    room_prefs: ['high_floor', 'quiet', 'unicorn_suite'], dietary: 'Vegetarian', allergies: 'Peanuts', anniversary: '2015-06-20', birth_date: '1985-03-02',
    contact_prefs: ['whatsapp', 'email', 'pigeon'], vip: true, tags: 'academic, repeat', preferences: 'Extra towels', notes: 'Friend of the owner' };
  assert.equal((await fd.put(`/api/crm/guests/${gid}`, { ...body, title: 'Emperor' })).status, 400);
  assert.equal((await fd.put(`/api/crm/guests/${gid}`, { ...body, anniversary: 'June' })).status, 400);
  ok(await fd.put(`/api/crm/guests/${gid}`, body));
  const g = ok(await fd.get(`/api/crm/guests/${gid}`)).guest;
  assert.deepEqual([g.title, g.phone2, g.city, g.country, g.employer, g.occupation, g.language, g.dietary, g.allergies, g.anniversary, g.gender],
    ['Dr', '0414 222 111', 'Kampala', 'Uganda', 'Makerere University', 'Lecturer', 'Luganda', 'Vegetarian', 'Peanuts', '2015-06-20', 'female']);
  assert.deepEqual(g.room_prefs, ['high_floor', 'quiet']); // unknown choices are dropped
  assert.deepEqual(g.contact_prefs, ['whatsapp', 'email']);
  // the desk sees preferences and allergies on the booking
  const f = ok(await fd.get(`/api/reservations/${r.id}`)).reservation;
  assert.deepEqual([f.allergies, f.dietary, f.room_prefs], ['Peanuts', 'Vegetarian', ['high_floor', 'quiet']]);
});

test('room types: description, beds, size, occupancy, extra bed price, amenities', async () => {
  const t = ok(await admin.post('/api/room-types', { code: 'FAM', name: 'Family Room', base_rate: 420000, max_occupancy: 4, description: 'Two rooms with a shared bathroom', bed_type: 'family', size_sqm: 42,
    max_adults: 2, max_children: 2, extra_bed_rate: 60000, amenities: ['wifi', 'ac', 'tv', 'jacuzzi_on_the_moon'] }));
  assert.deepEqual([t.bed_type, t.size_sqm, t.max_adults, t.max_children, Number(t.extra_bed_rate), t.amenities], ['family', 42, 2, 2, 60000, ['wifi', 'ac', 'tv']]);
  assert.equal((await admin.put(`/api/room-types/${t.id}`, { name: 'Family Room', base_rate: 420000, size_sqm: 2 })).status, 400);
  assert.equal((await admin.put(`/api/room-types/${t.id}`, { name: 'Family Room', base_rate: 420000, bed_type: 'hammock' })).status, 400);
  assert.equal((await fd.post('/api/room-types', { code: 'X', name: 'X', base_rate: 1 })).status, 403);
});

test('rooms: view, bed set-up, features and a connecting room that must exist', async () => {
  const fam = ok(await admin.get('/api/room-types')).find((t) => t.code === 'FAM');
  assert.equal((await admin.post('/api/rooms', { number: '401', room_type_id: fam.id, connects_to: '999' })).status, 400);
  assert.equal((await admin.post('/api/rooms', { number: '401', room_type_id: fam.id, connects_to: '402' })).status, 400); // 402 does not exist yet
  ok(await admin.post('/api/rooms', { number: '402', room_type_id: fam.id, floor: '4', view: 'lake', bed_setup: 'king' }));
  const r401 = ok(await admin.post('/api/rooms', { number: '401', room_type_id: fam.id, floor: '4', view: 'lake', bed_setup: 'family', features: ['balcony', 'connecting', 'helipad'], connects_to: '402' }));
  assert.deepEqual([r401.view, r401.bed_setup, r401.features, r401.connects_to], ['lake', 'family', ['balcony', 'connecting'], '402']);
  assert.equal((await admin.put(`/api/rooms/${r401.id}`, { room_type_id: fam.id, connects_to: '401' })).status, 400); // not to itself
  assert.equal((await admin.put(`/api/rooms/${r401.id}`, { room_type_id: fam.id, view: 'space' })).status, 400);
});

test('rate plans: meal plan, cancellation days, deposit, validity, arrival days, maximum stay, book-ahead', async () => {
  const base = { code: 'WKND', name: 'Weekend escape', discount_pct: 10, min_stay: 2, meal_plan: 'hb', cancel_days: 3, deposit_pct: 50, valid_from: '2026-11-01', valid_to: '2026-12-31',
    arrival_days: [5, 6], max_stay: 3, min_advance: 2, on_website: true, on_channels: false };
  assert.equal((await admin.post('/api/distribution/rate-plans', { ...base, meal_plan: 'buffet' })).status, 400);
  assert.equal((await admin.post('/api/distribution/rate-plans', { ...base, valid_to: '2026-10-01' })).status, 400);
  assert.equal((await admin.post('/api/distribution/rate-plans', { ...base, arrival_days: [] })).status, 400);
  assert.equal((await admin.post('/api/distribution/rate-plans', { ...base, max_stay: 1 })).status, 400);
  const p = ok(await admin.post('/api/distribution/rate-plans', base));
  assert.deepEqual([p.meal_plan, p.breakfast, p.cancel_days, p.refundable, p.deposit_pct, p.arrival_days, p.max_stay, p.min_advance], ['hb', true, 3, true, 50, [5, 6], 3, 2]);
  // the website only offers it on a Friday or Saturday arrival, booked 2+ days ahead, for 2–3 nights
  const plan = (q, t = 'STD') => q.room_types.find((x) => x.room_type.code === t).plans.find((x) => x.code === 'WKND');
  const web = client();
  const fri = ok(await web.get('/api/public/availability?arrival=2026-11-13&departure=2026-11-15&adults=2'));
  assert.equal(plan(fri).bookable, true); assert.equal(plan(fri).meal_plan, 'hb');
  assert.match(plan(ok(await web.get('/api/public/availability?arrival=2026-11-16&departure=2026-11-18&adults=2'))).reason, /weekday/);
  assert.match(plan(ok(await web.get('/api/public/availability?arrival=2026-11-20&departure=2026-11-24&adults=2'))).reason, /Maximum stay 3/);
  // Saturday 14 Nov is only 4 days ahead of 10 Nov; with 5 days required it is refused
  ok(await admin.put(`/api/distribution/rate-plans/${p.id}`, { ...base, min_advance: 5 }));
  assert.match(plan(ok(await web.get('/api/public/availability?arrival=2026-11-14&departure=2026-11-16&adults=2'))).reason, /Book at least 5 days ahead/);
  // front desk sees the same rule as a warning
  const q = ok(await fd.get('/api/reservations/quote?arrival=2026-11-16&departure=2026-11-18'));
  assert.match(q.room_types.find((t) => t.code === 'STD').plans.find((x) => x.code === 'WKND').warning, /weekday/);
  // a plan without free cancellation
  const nr = ok(await admin.post('/api/distribution/rate-plans', { code: 'NRF2', name: 'Prepaid', discount_pct: 15, meal_plan: 'room_only', refundable: false, deposit_pct: 100 }));
  assert.deepEqual([nr.refundable, nr.cancel_days, nr.breakfast], [false, null, false]);
});
