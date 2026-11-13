// Sample data: a believable recent history (bookings, stays, restaurant and bar sales, extras, expenses, night
// audits) generated through the system's own functions, so every figure is posted to the books exactly as real use
// would. Only for a new, unused system; "start fresh" removes it all and keeps the set-up (rooms, menus, users…).
import { tx } from '../db.js';
import { HttpError, audit } from '../auth.js';
import * as fo from './frontoffice.js';
import * as pos from './pos.js';
import * as fin from './finance.js';
import * as ops from './operations.js';
import { receive } from './inventory.js';
import { normalizePhone } from './whatsapp.js';

const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

// a small seeded random generator, so the same sample appears every time
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (pairs) => { const total = pairs.reduce((s, [, w]) => s + w, 0); let x = next() * total; for (const [v, w] of pairs) { x -= w; if (x < 0) return v; } return pairs[pairs.length - 1][0]; },
  };
}

const FIRST = { UG: ['Sarah', 'Joseph', 'Grace', 'Moses', 'Esther', 'David', 'Ruth', 'Isaac', 'Agnes', 'Brian', 'Patience', 'Ivan', 'Juliet', 'Allan', 'Doreen', 'Collins', 'Martha', 'Henry', 'Brenda', 'Ronald'],
  KE: ['Wanjiru', 'Otieno', 'Achieng', 'Kamau', 'Njeri', 'Kipchoge'], TZ: ['Neema', 'Baraka', 'Rehema', 'Juma'], RW: ['Aline', 'Eric', 'Claudine'],
  GB: ['Oliver', 'Emma', 'James', 'Charlotte'], US: ['Michael', 'Jennifer', 'Daniel'], DE: ['Lukas', 'Anna'], IN: ['Priya', 'Arjun'], NG: ['Chinedu', 'Amaka'], ZA: ['Thabo', 'Lerato'] };
const LAST = { UG: ['Namuli', 'Ssempa', 'Okello', 'Nakato', 'Mugisha', 'Atwine', 'Kato', 'Nabirye', 'Tumusiime', 'Opio', 'Akello', 'Byaruhanga', 'Nansubuga', 'Wasswa', 'Kiconco', 'Ochieng', 'Asiimwe', 'Mukasa'],
  KE: ['Mwangi', 'Odhiambo', 'Wambui', 'Kiprotich'], TZ: ['Mollel', 'Mushi', 'Swai'], RW: ['Uwase', 'Habimana', 'Mukamana'],
  GB: ['Smith', 'Taylor', 'Brown', 'Wilson'], US: ['Johnson', 'Miller', 'Davis'], DE: ['Schmidt', 'Weber'], IN: ['Sharma', 'Patel'], NG: ['Okafor', 'Adeyemi'], ZA: ['Nkosi', 'Dlamini'] };
const NATION = { UG: 'Ugandan', KE: 'Kenyan', TZ: 'Tanzanian', RW: 'Rwandan', GB: 'British', US: 'American', DE: 'German', IN: 'Indian', NG: 'Nigerian', ZA: 'South African' };
const ISSUER = { UG: 'NIRA Uganda', KE: 'Republic of Kenya', TZ: 'United Republic of Tanzania', RW: 'Republic of Rwanda', GB: 'United Kingdom', US: 'United States of America', DE: 'Federal Republic of Germany', IN: 'Republic of India', NG: 'Federal Republic of Nigeria', ZA: 'Republic of South Africa' };
const DIAL = { KE: '+254', TZ: '+255', RW: '+250', GB: '+44', US: '+1', DE: '+49', IN: '+91', NG: '+234', ZA: '+27' };
const FROM = { UG: ['Kampala', 'Entebbe', 'Jinja', 'Mbarara', 'Gulu', 'Mbale', 'Fort Portal'], KE: ['Nairobi', 'Mombasa', 'Kisumu'], TZ: ['Dar es Salaam', 'Arusha'], RW: ['Kigali'],
  GB: ['London', 'Manchester'], US: ['New York', 'Washington'], DE: ['Berlin', 'Munich'], IN: ['Mumbai', 'Delhi'], NG: ['Lagos', 'Abuja'], ZA: ['Johannesburg', 'Cape Town'] };

/** Is this a new, unused system? Sample data is only ever added to one. */
export async function assertEmpty(db) {
  const { rows: [x] } = await db.query(`SELECT (SELECT count(*) FROM reservations)::int AS res, (SELECT count(*) FROM pos_checks)::int AS checks,
    (SELECT count(*) FROM journal_entries)::int AS journals, (SELECT count(*) FROM guests)::int AS guests`);
  if (x.res || x.checks || x.journals || x.guests) throw new HttpError(409, 'Sample data can only be added to a new system with no bookings, sales or accounts entries yet.');
}

const status = { running: false, step: '', done: 0, total: 0, error: null, finished_at: null };
export const demoStatus = () => ({ ...status });

/** Generate `days` days of history ending yesterday, plus today's in-house guests and the coming weeks' bookings. */
export async function generateDemoData(pool, user, { days = 45, seed = 2026 } = {}) {
  if (status.running) throw new HttpError(409, 'Sample data is already being created.');
  const R = rng(seed);
  let T;
  await tx(pool, async (db) => { await assertEmpty(db); });
  Object.assign(status, { running: true, step: 'Preparing', done: 0, total: days + 2, error: null, finished_at: null });
  try {
    const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
    const types = await q('SELECT * FROM room_types WHERE active ORDER BY id');
    const rooms = await q('SELECT r.*, t.code AS type_code FROM rooms r JOIN room_types t ON t.id=r.room_type_id WHERE r.active ORDER BY r.number');
    const outlets = await q('SELECT * FROM outlets WHERE active ORDER BY id');
    const items = await q('SELECT m.id, m.name, m.price, c.station FROM menu_items m JOIN menu_categories c ON c.id=m.category_id WHERE m.active AND c.active');
    const amenities = await q('SELECT * FROM amenities WHERE active');
    const restaurant = outlets.find((o) => o.kind === 'restaurant') || outlets[0], bar = outlets.find((o) => o.kind === 'bar'), roomService = outlets.find((o) => o.kind === 'room_service');
    // one menu for every outlet: the bar sells what the bar makes; restaurant and room service sell everything
    const menu = (o) => (!o ? [] : o.kind === 'bar' ? items.filter((i) => i.station === 'bar') : items);

    // move to the first day, add companies and some opening stock (all or nothing)
    let companies = [];
    await tx(pool, async (db) => {
      await assertEmpty(db);
      const st = await fo.getSettings(db, { lock: true });
      T = st.business_date;
      await db.query('UPDATE settings SET business_date=$1, demo_data=TRUE WHERE id=1', [addDays(T, -days)]);
      await audit(db, user, 'demo.start', 'settings', 1, { days });
      for (const [name, tin, limit] of [['Stanbic Bank Uganda', '1000023456', 15000000], ['MTN Uganda', '1000034567', 20000000], ['Ministry of Health', '1000045678', 25000000]]) {
        companies.push(await fin.saveCompany(db, user, null, { name, tin, credit_limit: limit, terms_days: 30, email: `accounts@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, phone: '+256 414 000 000' }));
      }
      const used = (await db.query('SELECT DISTINCT item_id FROM recipe_lines')).rows.map((r) => r.item_id);
      let stores = (await db.query('SELECT DISTINCT stock_store_id AS id FROM outlets WHERE active AND stock_store_id IS NOT NULL')).rows.map((r) => r.id);
      if (!stores.length) stores = (await db.query('SELECT id FROM stores ORDER BY id LIMIT 1')).rows.map((r) => r.id);
      const byStore = {};
      for (const storeId of stores) byStore[storeId] = new Map(used.map((id) => [id, { item_id: id, qty: R.int(60, 160), unit_cost: R.int(2, 30) * 500 }]));
      for (const [storeId, lines] of Object.entries(byStore)) if (lines.size) await receive(db, user, { is_opening: true, store_id: Number(storeId), lines: [...lines.values()], invoice_ref: 'Opening stock' });
    });

    // a pool of guests; some come back
    const people = [];
    const newPerson = () => {
      const cc = R.weighted([['UG', 55], ['KE', 10], ['TZ', 4], ['RW', 4], ['GB', 7], ['US', 5], ['DE', 3], ['IN', 4], ['NG', 4], ['ZA', 4]]);
      const first = R.pick(FIRST[cc]), last = R.pick(LAST[cc]);
      const p = { cc, first_name: first, last_name: last, nationality: NATION[cc], phone: cc === 'UG' ? `+2567${R.int(0, 9)}${R.int(1000000, 9999999)}` : `${DIAL[cc]}${R.int(100000000, 999999999)}`,
        email: `${first}.${last}${R.int(1, 99)}@example.com`.toLowerCase(), gender: R.chance(0.5) ? 'female' : 'male',
        id_type: cc === 'UG' ? R.weighted([['National ID', 8], ['Driving permit', 2]]) : 'Passport',
        id_number: cc === 'UG' ? `C${R.pick(['M', 'F'])}${R.int(80, 99)}${R.int(10000000, 99999999)}ABCD`.slice(0, 14) : `${cc}${R.int(1000000, 9999999)}`,
        id_issued_by: ISSUER[cc], coming_from: R.pick(FROM[cc]) };
      people.push(p);
      return p;
    };
    const guestFor = () => (people.length > 20 && R.chance(0.18) ? R.pick(people.filter((p) => p.guest_id)) || newPerson() : newPerson());
    const SOURCES = [['Direct', 22], ['Walk-in', 14], ['Website', 18], ['Booking.com', 24], ['Expedia', 8], ['Corporate', 14]];

    async function book(db, arrival, nightsN, { checkInNow }) {
      const p = guestFor();
      const t = R.weighted(types.map((x, i) => [x, [6, 3, 1][i] || 1]));
      const source = R.weighted(SOURCES);
      const company = source === 'Corporate' ? R.pick(companies) : null;
      const body = { room_type_id: t.id, arrival, departure: addDays(arrival, nightsN), adults: R.weighted([[1, 6], [2, 4]]), rate: Math.round(t.base_rate * R.pick([1, 1, 0.95, 0.9]) / 1000) * 1000,
        source: source === 'Corporate' ? 'Direct' : source, company_name: company?.name || null };
      if (p.guest_id) body.guest_id = p.guest_id; else body.guest = { first_name: p.first_name, last_name: p.last_name, phone: p.phone, email: p.email, nationality: p.nationality, marketing_consent: R.chance(0.35) };
      if (checkInNow) {
        // a walk-in or same-day booking only when a clean room is free
        const { rows: [f] } = await db.query("SELECT count(*)::int AS n FROM rooms WHERE active AND hk_status='clean' AND id NOT IN (SELECT room_id FROM reservations WHERE status='in_house' AND room_id IS NOT NULL)");
        if (!f.n) return null;
      }
      let r;
      try { r = await fo.createReservation(db, user, body); } catch (e) { if (e.status === 409) return null; throw e; }
      p.guest_id = r.guest_id;
      if (company) await db.query('UPDATE reservations SET company_id=$2 WHERE id=$1', [r.id, company.id]);
      if (checkInNow) {
        const free = await db.query(`SELECT r.id, r.room_type_id FROM rooms r WHERE r.active AND r.hk_status='clean' AND r.id NOT IN (SELECT room_id FROM reservations WHERE status='in_house' AND room_id IS NOT NULL)
          ORDER BY (r.room_type_id=$1) DESC, r.number`, [t.id]);
        const room = free.rows[0];
        if (!room) return r;
        await fo.checkIn(db, user, r.id, { room_id: room.id, guest: { id_type: p.id_type, id_number: p.id_number, id_issued_by: p.id_issued_by, gender: p.gender },
          stay: { purpose: company ? 'business' : R.weighted([['leisure', 5], ['business', 4], ['conference', 1], ['transit', 1]]), coming_from: p.coming_from, going_to: p.coming_from } });
      }
      return r;
    }

    for (let i = 0; i < days; i++) {
      const d = addDays(T, i - days);
      status.step = `Day ${i + 1} of ${days}`;
      await tx(pool, async (db) => {
        const s = await fo.getSettings(db);
        // housekeeping cleaned yesterday's rooms
        await db.query("UPDATE rooms SET hk_status='clean' WHERE hk_status='dirty'");
        // departures: settle and check out
        const leaving = (await db.query("SELECT r.*, (SELECT COALESCE(SUM(amount),0) FROM folio_charges WHERE reservation_id=r.id AND NOT voided) - (SELECT COALESCE(SUM(amount),0) FROM payments WHERE reservation_id=r.id AND NOT voided) AS bal FROM reservations r WHERE status='in_house' AND departure <= $1", [d])).rows;
        for (const r of leaving) {
          const bal = Number(r.bal);
          if (bal > 0) {
            const method = r.company_id ? 'company_account' : R.weighted([['mobile_money', 38], ['cash', 27], ['card', 30], ['bank_transfer', 5]]);
            await fo.postPayment(db, user, r.id, { amount: bal, method, company_id: r.company_id || undefined, reference: method === 'mobile_money' ? `MM${R.int(100000000, 999999999)}` : undefined });
          }
          await fo.checkOut(db, user, r.id);
        }
        // arrivals: fill towards the day's occupancy (busier at weekends)
        const [{ n: inHouse }] = (await db.query("SELECT count(*)::int AS n FROM reservations WHERE status='in_house'")).rows;
        const target = Math.round(rooms.length * ([0.82, 0.55, 0.6, 0.66, 0.7, 0.86, 0.9][dow(d)] + (R.next() - 0.5) * 0.14));
        for (let k = 0; k < Math.max(0, target - inHouse); k++) await book(db, d, R.weighted([[1, 30], [2, 30], [3, 20], [4, 10], [5, 6], [7, 4]]), { checkInNow: true });
        if (R.chance(0.12)) { const nr = await book(db, addDays(d, R.int(1, 6)), 2, { checkInNow: false }); if (nr && R.chance(0.5)) await fo.cancelReservation(db, user, nr.id, R.pick(['Change of plans', 'Flight cancelled', 'Booked elsewhere'])); }

        // restaurant, bar and room service
        await pos.openShift(db, user, { outlet_id: restaurant.id, opening_float: 200000 });
        const guestsIn = (await db.query("SELECT id FROM reservations WHERE status='in_house'")).rows;
        const sell = async (outlet, n, toRoom) => {
          const m = menu(outlet); if (!m.length) return;
          for (let k = 0; k < n; k++) {
            const resv = toRoom && guestsIn.length ? R.pick(guestsIn) : null;
            const c = await pos.openCheck(db, user, { outlet_id: outlet.id, covers: R.int(1, 4), reservation_id: resv?.id });
            let total = 0;
            for (let j = R.int(1, 4); j > 0; j--) { const it = R.pick(m), qty = R.weighted([[1, 7], [2, 3]]); await pos.addLine(db, user, c.id, { item_id: it.id, qty }); total += it.price * qty; }
            const method = resv ? 'room' : R.weighted([['cash', 40], ['mobile_money', 35], ['card', 25]]);
            await pos.settleCheck(db, user, c.id, { payments: [{ method, amount: total, reservation_id: resv?.id }] });
          }
        };
        const busy = [5, 6, 0].includes(dow(d)) ? 1.4 : 1;
        await sell(restaurant, Math.round(R.int(6, 12) * busy), false);
        await sell(restaurant, Math.round(guestsIn.length * 0.25), true);
        if (bar) await sell(bar, Math.round(R.int(5, 10) * busy), false);
        if (bar) await sell(bar, Math.round(guestsIn.length * 0.15), true);
        if (roomService) await sell(roomService, Math.round(guestsIn.length * 0.1), true);
        const { rows: [ex] } = await db.query("SELECT COALESCE(SUM(amount),0)::bigint AS cash FROM pos_payments p JOIN pos_shifts s ON s.id=p.shift_id WHERE s.user_id=$1 AND s.closed_at IS NULL AND p.method='cash'", [user.id]);
        await pos.closeShift(db, user, { counted_cash: 200000 + Number(ex.cash), notes: 'Sample data' });

        // extras on guests' bills and amenity sales
        for (const g of guestsIn) {
          if (R.chance(0.12)) await fo.postCharge(db, user, g.id, { department: 'other', amount: R.int(3, 12) * 5000, description: R.pick(['Laundry', 'Minibar', 'Telephone & printing', 'Extra bed']) });
        }
        if (amenities.length && R.chance(0.6)) {
          for (let k = R.int(1, 3); k > 0; k--) {
            const a = R.pick(amenities), resv = guestsIn.length && R.chance(0.7) ? R.pick(guestsIn) : null;
            const b = await ops.bookAmenity(db, user, { amenity_id: a.id, service_date: d, qty: 1, reservation_id: resv?.id, guest_name: resv ? undefined : `${R.pick(FIRST.UG)} ${R.pick(LAST.UG)}` });
            await ops.completeAmenity(db, user, b.id, { settle_by: resv ? 'room' : R.pick(['cash', 'mobile_money', 'card']) });
          }
        }

        // running costs
        const spend = async (account_code, amount, payee, description, paid_from = '1000', vat = 0) => fin.recordExpense(db, user, { account_code, amount, payee, description, paid_from, vat, expense_date: d });
        await spend('5100', R.int(8, 30) * 5000, 'Capital Shoppers', 'Guest amenities & cleaning supplies');
        if (dow(d) === 1) await spend('6100', R.int(110, 160) * 10000, 'UMEME', 'Electricity (prepaid)', '1030', 0);
        if (dow(d) === 3) await spend('6100', R.int(30, 45) * 10000, 'National Water & Sewerage', 'Water', '1030');
        if (dow(d) === 2) await spend('6300', R.int(20, 60) * 10000, 'Azeli Technologies', 'Marketing & online ads', '1030');
        if (i % 3 === 0) await spend('6500', R.int(8, 20) * 10000, 'Shell Uganda', 'Fuel: shuttle van', '1020');
        if (R.chance(0.15)) await spend('6200', R.int(10, 80) * 10000, R.pick(['Kampala Plumbers Ltd', 'Coolair Services', 'Brightway Electricals']), R.pick(['Plumbing repair', 'AC servicing', 'Electrical repair']), '1000');
        if (addDays(d, 1).slice(8) === '01') {
          await spend('6000', 34000000, 'Staff salaries', `Salaries ${d.slice(0, 7)}`, '1030');
          await spend('6010', 3400000, 'NSSF', `Employer NSSF ${d.slice(0, 7)}`, '1030');
          await spend('6400', 9000000, 'Landlord', `Rent ${d.slice(0, 7)}`, '1030');
        }
        if (s.business_date !== d) throw new Error(`Business date out of step (${s.business_date} vs ${d}).`);
        await fo.runNightAudit(db, user);
      });
      status.done = i + 1;
    }

    // today: arrivals still to come, the next three weeks' bookings, events and maintenance
    status.step = 'Upcoming bookings';
    await tx(pool, async (db) => {
      for (let k = R.int(3, 6); k > 0; k--) await book(db, T, R.int(1, 4), { checkInNow: false });
      for (let i = 1; i <= 21; i++) for (let k = Math.round(R.int(1, 4) * (i < 8 ? 1.4 : 0.8)); k > 0; k--) await book(db, addDays(T, i), R.weighted([[1, 3], [2, 4], [3, 2], [5, 1]]), { checkInNow: false });
      const setup = await db.query('SELECT * FROM function_rooms WHERE active ORDER BY capacity DESC');
      const pk = (await db.query('SELECT * FROM event_packages WHERE active ORDER BY per_person')).rows;
      if (setup.rows.length && pk.length) {
        const ev1 = await ops.saveEvent(db, user, null, { title: 'MTN Uganda quarterly sales conference', event_type: 'conference', status: 'confirmed', event_date: addDays(T, 5), start_time: '08:30', end_time: '17:00',
          function_room_id: setup.rows[0].id, company_id: companies[1].id, contact_name: 'Brenda Kiconco', contact_phone: '+256772000111', pax: 120, package_id: pk[pk.length > 1 ? 1 : 0].id, hire_type: 'full_day', setup_style: 'Classroom',
          beo_notes: { kitchen: 'Lunch buffet at 13:00; 10 vegetarian, 2 halal', technical: 'Projector, 3 wireless microphones', service: 'Water and mints on every table' } });
        await ops.eventPayment(db, user, ev1.id, { kind: 'deposit', account_code: '1030', amount: 5000000, reference: 'EFT 44821' });
        await ops.saveEvent(db, user, null, { title: 'Nakato & Mugisha wedding reception', event_type: 'wedding', status: 'tentative', event_date: addDays(T, 16), start_time: '15:00', end_time: '23:00',
          function_room_id: (setup.rows.find((x, i) => i > 0 && x.capacity >= 90) || setup.rows[0]).id, contact_name: 'Esther Nakato', contact_phone: '+256701222333', pax: 90, package_id: pk[pk.length - 1].id, hire_type: 'full_day', setup_style: 'Banquet rounds' });
      }
      for (const [title, priority] of [['Air conditioner leaking, room 204', 'high'], ['Replace bulbs in corridor, 1st floor', 'low'], ['Hot water pressure low, room 107', 'normal']]) {
        await ops.reportIssue(db, user, { title, priority, location: title.split(', ').pop() });
      }
      // this morning: housekeeping has cleaned most empty rooms; a few stayovers and two empty rooms are still to do
      await db.query("UPDATE rooms SET hk_status='clean' WHERE hk_status='dirty'");
      await db.query("UPDATE rooms SET hk_status='dirty' WHERE id IN (SELECT room_id FROM reservations WHERE status='in_house' AND room_id IS NOT NULL ORDER BY room_id LIMIT 6)");
      await db.query("UPDATE rooms SET hk_status='dirty' WHERE id IN (SELECT id FROM rooms WHERE active AND id NOT IN (SELECT room_id FROM reservations WHERE status='in_house' AND room_id IS NOT NULL) ORDER BY number DESC LIMIT 2)");
      await sampleWhatsApp(db);
      await audit(db, user, 'demo.done', 'settings', 1, { days });
    });
    Object.assign(status, { running: false, step: 'Done', done: status.total, finished_at: new Date().toISOString() });
    return { days };
  } catch (e) {
    Object.assign(status, { running: false, error: e.message, step: 'Stopped' });
    console.error('Sample data failed:', e);
    throw e;
  }
}

/** A few WhatsApp conversations with today's guests, so the inbox has something to work with. */
async function sampleWhatsApp(db) {
  await db.query('UPDATE guests SET whatsapp_opt_in=TRUE, whatsapp_opt_in_at=created_at WHERE phone IS NOT NULL AND id % 5 <> 0');
  const s = await fo.getSettings(db);
  const tpl = Object.fromEntries((await db.query('SELECT name, id FROM wa_templates')).rows.map((t) => [t.name, t.id]));
  const { rows } = await db.query(`SELECT DISTINCT ON (g.id) g.id, g.first_name, g.phone, rm.number AS room, r.status, to_char(r.arrival,'YYYY-MM-DD') AS arrival, r.code
    FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.status IN ('in_house','reserved') AND g.phone IS NOT NULL ORDER BY g.id, r.arrival`);
  const inHouse = rows.filter((r) => r.status === 'in_house'), coming = rows.filter((r) => r.status === 'reserved');
  // [direction, text, minutes ago, template]
  const scripts = [
    [inHouse[0], (g) => [['in', `Hello, could we get two extra towels in room ${g.room}, please?`, 95], ['out', `Of course, ${g.first_name}! Housekeeping is on the way.`, 92], ['in', 'Thank you, that was quick!', 80]]],
    [inHouse[1], () => [['in', 'Hi, is the restaurant open for dinner tonight? A table for 3 at 7:30 please.', 18]]],
    [inHouse[2], (g) => [['out', `Welcome to ${s.property_name}, ${g.first_name}! You are in room ${g.room}. This is the front desk on WhatsApp: message us any time for housekeeping, room service or help.`, 1500, 'welcome_in_house'],
      ['in', 'What time is check-out?', 600], ['out', 'Check-out is at 11:00. We can offer a late check-out until 13:00 for UGX 50,000. Shall I book it?', 590]]],
    [coming[0], () => [['in', 'Good morning, can you arrange an airport pickup from Entebbe? My flight lands at 14:20.', 40]]],
    [coming[1], (g) => [['out', `Hello ${g.first_name}, your booking ${g.code} at ${s.property_name} is confirmed. Reply here if you need anything before you arrive.`, 3000, 'booking_confirmed']]],
  ];
  for (const [g, script] of scripts) {
    const waId = g && normalizePhone(g.phone, s.phone_country_code);
    if (!waId) continue;
    const { rows: [c] } = await db.query('INSERT INTO wa_conversations (wa_id, guest_id, profile_name) VALUES ($1,$2,$3) ON CONFLICT (wa_id) DO NOTHING RETURNING id', [waId, g.id, g.first_name]);
    if (!c) continue;
    await db.query('UPDATE guests SET whatsapp_opt_in=TRUE, whatsapp_opt_in_at=COALESCE(whatsapp_opt_in_at, now()) WHERE id=$1', [g.id]);
    const msgs = script(g);
    for (const [dir, body, ago, t] of msgs) {
      await db.query(`INSERT INTO wa_messages (conversation_id, direction, kind, body, template_id, status, wa_message_id, created_at, status_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7, now() - make_interval(mins => $8), now() - make_interval(mins => $8))`,
      [c.id, dir, t ? 'template' : 'text', body, t ? tpl[t] : null, dir === 'in' ? 'received' : 'read', `sample.${c.id}.${ago}`, ago]);
    }
    const lastIn = msgs.filter(([d]) => d === 'in').map(([, , a]) => a);
    const unread = msgs.length - 1 - msgs.map(([d]) => d).lastIndexOf('out');
    await db.query(`UPDATE wa_conversations SET last_inbound_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(mins => $2::int) END,
      last_message_at = now() - make_interval(mins => $3), unread=$4 WHERE id=$1`, [c.id, lastIn.length ? Math.min(...lastIn) : null, Math.min(...msgs.map(([, , a]) => a)), msgs.at(-1)[0] === 'in' ? Math.min(unread, msgs.length) : 0]);
  }
}

// Everything that records activity. Set-up is kept: settings, users, rooms and room types, accounts, menus and tables,
// stores, stock items, suppliers and recipes, rate plans and calendar, channels, shift and leave types, amenities,
// function rooms and packages, email templates, report schedules, group links and the audit log.
const ACTIVITY = ['ap_allocations', 'ar_allocations', 'ar_receipts', 'ari_outbox', 'amenity_bookings', 'assets', 'attendance', 'bank_reconciliations', 'bill_grns', 'bill_lines',
  'campaigns', 'channel_log', 'companies', 'depreciation_runs', 'email_outbox', 'employees', 'event_extras', 'event_payments', 'events', 'expenses', 'folio_charges', 'goods_received',
  'goods_received_lines', 'guests', 'invoice_lines', 'invoices', 'journal_entries', 'journal_lines', 'kitchen_tickets', 'leave_requests', 'night_audits', 'payment_intents', 'payments',
  'payroll_lines', 'payroll_runs', 'pos_check_lines', 'pos_checks', 'pos_payments', 'pos_shifts', 'purchase_order_lines', 'purchase_orders', 'report_runs', 'requisition_lines', 'requisitions',
  'reservation_nights', 'reservations', 'room_moves', 'roster', 'staff_advances', 'stock_balances', 'stock_count_lines', 'stock_counts', 'stock_movements', 'supplier_bills',
  'supplier_payments', 'transfers', 'wa_automation_runs', 'wa_conversations', 'wa_messages', 'work_orders'];

/** Remove the sample data and start fresh. Only when sample data was added, and the property name is typed to confirm. */
export async function removeDemoData(pool, user, { confirm }) {
  if (status.running) throw new HttpError(409, 'Sample data is still being created. Wait for it to finish.');
  return tx(pool, async (db) => {
    const s = await fo.getSettings(db, { lock: true });
    if (!s.demo_data) throw new HttpError(409, 'This system has no sample data to remove.');
    if (String(confirm || '').trim() !== s.property_name) throw new HttpError(400, `Type the property name exactly (${s.property_name}) to confirm.`);
    // without CASCADE: PostgreSQL refuses if anything kept still points at these tables, so nothing is removed by surprise
    await db.query(`TRUNCATE ${ACTIVITY.join(', ')} RESTART IDENTITY`);
    await db.query("UPDATE stock_items SET avg_cost=0");
    await db.query("UPDATE rooms SET hk_status='clean' WHERE hk_status='dirty'");
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
    await db.query('UPDATE settings SET demo_data=FALSE, business_date=$1, books_locked_until=NULL WHERE id=1', [today]);
    await audit(db, user, 'demo.removed', 'settings', 1, { business_date: today });
    return { business_date: today };
  });
}
