import { HttpError, audit } from '../auth.js';
import { postJournal, chargeLines, paymentLines, DEPARTMENTS, PAYMENT_METHODS } from '../ledger.js';
import { enqueueAri, enqueueAriFromToday } from './ari.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const money = (v, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} must be a whole number of shillings greater than zero.`);
  return n;
};
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};

export async function getSettings(db, { lock = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM settings WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
  if (!rows[0]) throw new HttpError(500, 'Property settings missing. Run the seed script.');
  return rows[0];
}

/* ---------------- availability ---------------- */
/** Rooms of a type still free on every night from `from` up to (not including) `to`. */
export async function availableCount(db, roomTypeId, from, to, excludeReservationId = null) {
  const { rows: [r] } = await db.query(
    `WITH nights AS (SELECT d::date AS night FROM generate_series($2::date, $3::date - 1, interval '1 day') d),
          cap AS (SELECT count(*)::int AS n FROM rooms WHERE room_type_id = $1 AND active AND hk_status <> 'out_of_order')
     SELECT COALESCE(MIN(cap.n - (SELECT count(*) FROM reservations r WHERE r.room_type_id = $1
              AND r.status IN ('reserved','in_house') AND r.arrival <= nights.night AND r.departure > nights.night
              AND ($4::int IS NULL OR r.id <> $4))), 0)::int AS free
     FROM nights, cap`, [roomTypeId, from, to, excludeReservationId]);
  return r.free;
}

export async function availabilityGrid(db, from, days) {
  const { rows } = await db.query(
    `WITH nights AS (SELECT d::date AS night FROM generate_series($1::date, $1::date + ($2::int - 1), interval '1 day') d)
     SELECT rt.id, rt.code, rt.name, rt.base_rate, to_char(n.night, 'YYYY-MM-DD') AS night,
       (SELECT count(*) FROM rooms WHERE room_type_id = rt.id AND active AND hk_status <> 'out_of_order')
       - (SELECT count(*) FROM reservations r WHERE r.room_type_id = rt.id AND r.status IN ('reserved','in_house')
          AND r.arrival <= n.night AND r.departure > n.night) AS free
     FROM room_types rt CROSS JOIN nights n WHERE rt.active ORDER BY rt.id, n.night`, [from, days]);
  const types = new Map();
  for (const r of rows) {
    if (!types.has(r.id)) types.set(r.id, { id: r.id, code: r.code, name: r.name, base_rate: r.base_rate, nights: [] });
    types.get(r.id).nights.push({ night: r.night, free: Number(r.free) });
  }
  return [...types.values()];
}

/* ---------------- reservations ---------------- */
async function lockRoomType(db, roomTypeId) {
  const { rows } = await db.query('SELECT * FROM room_types WHERE id = $1 AND active FOR UPDATE', [roomTypeId]);
  if (!rows[0]) throw new HttpError(400, 'Unknown room type.');
  return rows[0];
}
async function getReservationForUpdate(db, id) {
  const { rows } = await db.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new HttpError(404, 'Reservation not found.');
  return rows[0];
}

export async function createReservation(db, user, body) {
  const s = await getSettings(db);
  const { arrival, departure } = body;
  if (!isDate(arrival) || !isDate(departure)) throw new HttpError(400, 'Arrival and departure dates are required.');
  if (departure <= arrival) throw new HttpError(400, 'Departure must be after arrival.');
  if (arrival < s.business_date) throw new HttpError(400, 'Arrival cannot be before the current business date.');
  const type = await lockRoomType(db, Number(body.room_type_id)); // serialises bookings per room type
  const free = await availableCount(db, type.id, arrival, departure);
  if (free < 1 && !body.allow_overbooking) throw new HttpError(409, `No ${type.name} available for those dates.`);

  let guestId = body.guest_id ? Number(body.guest_id) : null;
  if (guestId) {
    const { rows } = await db.query('SELECT id FROM guests WHERE id = $1', [guestId]);
    if (!rows[0]) throw new HttpError(400, 'Guest not found.');
  } else {
    const g = body.guest || {};
    const { rows: [ng] } = await db.query(
      `INSERT INTO guests (first_name, last_name, phone, email, nationality, id_type, id_number) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [text(g.first_name, 'First name', { required: true, max: 80 }), text(g.last_name, 'Last name', { max: 80 }) || '', text(g.phone, 'Phone', { max: 40 }),
        text(g.email, 'Email', { max: 120 }), text(g.nationality, 'Nationality', { max: 60 }), text(g.id_type, 'ID type', { max: 40 }), text(g.id_number, 'ID number', { max: 60 })]);
    guestId = ng.id;
  }
  const rate = body.rate == null || body.rate === '' ? type.base_rate : Number(body.rate);
  if (!Number.isInteger(rate) || rate < 0) throw new HttpError(400, 'Rate must be a whole number of shillings.');
  const adults = Math.max(1, Number(body.adults) || 1), children = Math.max(0, Number(body.children) || 0);
  const { rows: [r] } = await db.query(
    `INSERT INTO reservations (guest_id, room_type_id, arrival, departure, adults, children, rate, source, company_name, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [guestId, type.id, arrival, departure, adults, children, rate, text(body.source, 'Source', { max: 40 }) || 'Direct',
      text(body.company_name, 'Company', { max: 120 }), text(body.notes, 'Notes', { max: 1000 }), user?.id ?? null]);
  await enqueueAri(db, type.id, arrival, departure, 'reservation');
  await audit(db, user, 'reservation.create', 'reservation', r.id, { code: r.code, arrival, departure, room_type: type.code, rate });
  return r;
}

export async function updateReservation(db, user, id, body) {
  const r = await getReservationForUpdate(db, id);
  const s = await getSettings(db);
  if (!['reserved', 'in_house'].includes(r.status)) throw new HttpError(409, 'Only upcoming or in-house reservations can be changed.');
  const next = { ...r };
  if (r.status === 'reserved') {
    if (body.arrival !== undefined) next.arrival = body.arrival;
    if (body.room_type_id !== undefined) next.room_type_id = Number(body.room_type_id);
    if (body.rate !== undefined) next.rate = Number(body.rate);
    if (body.adults !== undefined) next.adults = Math.max(1, Number(body.adults) || 1);
  }
  if (body.departure !== undefined) next.departure = body.departure;
  if (body.notes !== undefined) next.notes = text(body.notes, 'Notes', { max: 1000 });
  if (body.company_name !== undefined) next.company_name = text(body.company_name, 'Company', { max: 120 });
  if (!isDate(next.arrival) || !isDate(next.departure) || next.departure <= next.arrival) throw new HttpError(400, 'Departure must be after arrival.');
  if (r.status === 'reserved' && next.arrival < s.business_date) throw new HttpError(400, 'Arrival cannot be before the current business date.');
  if (r.status === 'in_house' && next.departure <= s.business_date) throw new HttpError(400, 'An in-house stay must end after today. Use check-out to end it today.');
  if (!Number.isInteger(next.rate) || next.rate < 0) throw new HttpError(400, 'Rate must be a whole number of shillings.');
  const type = await lockRoomType(db, next.room_type_id);
  const datesChanged = next.arrival !== r.arrival || next.departure !== r.departure || next.room_type_id !== r.room_type_id;
  if (datesChanged && !body.allow_overbooking) {
    const free = await availableCount(db, type.id, next.arrival, next.departure, r.id);
    if (free < 1) throw new HttpError(409, `No ${type.name} available for those dates.`);
  }
  const { rows: [u] } = await db.query(
    `UPDATE reservations SET arrival=$2, departure=$3, room_type_id=$4, rate=$5, adults=$6, notes=$7, company_name=$8 WHERE id=$1 RETURNING *`,
    [r.id, next.arrival, next.departure, next.room_type_id, next.rate, next.adults, next.notes, next.company_name]);
  if (datesChanged) { await enqueueAri(db, r.room_type_id, r.arrival, r.departure, 'reservation change'); await enqueueAri(db, u.room_type_id, u.arrival, u.departure, 'reservation change'); }
  // per-night prices: drop nights outside the new stay; an explicit new rate replaces them all
  await db.query('DELETE FROM reservation_nights WHERE reservation_id=$1 AND (night < $2 OR night >= $3 OR $4)', [r.id, u.arrival, u.departure, u.rate !== r.rate]);
  await audit(db, user, 'reservation.update', 'reservation', r.id, { from: { arrival: r.arrival, departure: r.departure, rate: r.rate, room_type_id: r.room_type_id }, to: { arrival: u.arrival, departure: u.departure, rate: u.rate, room_type_id: u.room_type_id } });
  return u;
}

export async function cancelReservation(db, user, id, reason) {
  const r = await getReservationForUpdate(db, id);
  if (r.status !== 'reserved') throw new HttpError(409, 'Only reservations that have not checked in can be cancelled.');
  const why = text(reason, 'Cancellation reason', { required: true, max: 300 });
  await db.query("UPDATE reservations SET status='cancelled', cancel_reason=$2 WHERE id=$1", [r.id, why]);
  await enqueueAri(db, r.room_type_id, r.arrival, r.departure, 'cancellation');
  await audit(db, user, 'reservation.cancel', 'reservation', r.id, { reason: why });
}

export async function checkIn(db, user, id, { room_id, allow_dirty = false, guest = {} } = {}) {
  const r = await getReservationForUpdate(db, id);
  const s = await getSettings(db);
  if (r.status !== 'reserved') throw new HttpError(409, 'This reservation is not waiting to check in.');
  if (r.arrival > s.business_date) throw new HttpError(409, `This guest is due on ${r.arrival}. Change the arrival date to check in early.`);
  const { rows: [room] } = await db.query('SELECT * FROM rooms WHERE id = $1 AND active FOR UPDATE', [Number(room_id)]);
  if (!room) throw new HttpError(400, 'Choose a room.');
  if (room.hk_status === 'out_of_order') throw new HttpError(409, `Room ${room.number} is out of order.`);
  if (room.hk_status === 'dirty' && !allow_dirty) throw new HttpError(409, `Room ${room.number} has not been cleaned yet.`);
  const { rows: occ } = await db.query("SELECT code FROM reservations WHERE room_id = $1 AND status = 'in_house'", [room.id]);
  if (occ[0]) throw new HttpError(409, `Room ${room.number} is occupied.`);
  if (guest.id_number || guest.id_type) {
    await db.query('UPDATE guests SET id_type = COALESCE($2, id_type), id_number = COALESCE($3, id_number) WHERE id = $1',
      [r.guest_id, text(guest.id_type, 'ID type', { max: 40 }), text(guest.id_number, 'ID number', { max: 60 })]);
  }
  // Early arrival on a later-dated booking is not allowed above; late arrival keeps the original departure.
  const arrival = r.arrival < s.business_date ? s.business_date : r.arrival;
  if (arrival >= r.departure) throw new HttpError(409, 'This stay has already ended. Update the departure date first.');
  await db.query("UPDATE reservations SET status='in_house', room_id=$2, arrival=$3, checked_in_at=now() WHERE id=$1", [r.id, room.id, arrival]);
  await audit(db, user, 'reservation.check_in', 'reservation', r.id, { room: room.number, upgraded: room.room_type_id !== r.room_type_id });
  return { room: room.number };
}

export async function folio(db, id) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, g.first_name, g.last_name, g.phone, g.email, g.id_type, g.id_number, g.nationality,
            rt.name AS room_type_name, rt.code AS room_type_code, rm.number AS room_number, rp.name AS rate_plan_name, ch.name AS channel_name
     FROM reservations r JOIN guests g ON g.id = r.guest_id JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN rooms rm ON rm.id = r.room_id LEFT JOIN rate_plans rp ON rp.id = r.rate_plan_id LEFT JOIN channels ch ON ch.id = r.channel_id WHERE r.id = $1`, [id]);
  if (!r) throw new HttpError(404, 'Reservation not found.');
  const charges = (await db.query('SELECT c.*, u.full_name AS posted_by_name FROM folio_charges c LEFT JOIN users u ON u.id = c.posted_by WHERE reservation_id = $1 ORDER BY business_date, id', [id])).rows;
  const payments = (await db.query('SELECT p.*, u.full_name AS posted_by_name FROM payments p LEFT JOIN users u ON u.id = p.posted_by WHERE reservation_id = $1 ORDER BY business_date, id', [id])).rows;
  const totalCharges = charges.filter((c) => !c.voided).reduce((a, c) => a + c.amount, 0);
  const totalPayments = payments.filter((p) => !p.voided).reduce((a, p) => a + p.amount, 0);
  const nights = (await db.query("SELECT to_char(night,'YYYY-MM-DD') AS night, rate FROM reservation_nights WHERE reservation_id=$1 ORDER BY night", [id])).rows;
  return { reservation: r, charges, payments, nights, totals: { charges: totalCharges, payments: totalPayments, balance: totalCharges - totalPayments } };
}
async function balanceOf(db, id) {
  const { rows: [b] } = await db.query(
    `SELECT COALESCE((SELECT SUM(amount) FROM folio_charges WHERE reservation_id=$1 AND NOT voided),0)
          - COALESCE((SELECT SUM(amount) FROM payments WHERE reservation_id=$1 AND NOT voided),0) AS balance`, [id]);
  return Number(b.balance);
}

export async function postCharge(db, user, id, body) {
  const r = await getReservationForUpdate(db, id);
  if (r.status !== 'in_house') throw new HttpError(409, 'Charges can only be posted to in-house guests.');
  const s = await getSettings(db);
  const department = String(body.department || 'other');
  if (!DEPARTMENTS.includes(department)) throw new HttpError(400, 'Unknown department.');
  const amount = money(body.amount, 'Amount');
  const description = text(body.description, 'Description', { required: true, max: 200 });
  return insertCharge(db, user, r, s, { department, amount, description });
}
export async function insertCharge(db, user, r, s, { department, amount, description, date = s.business_date }) {
  const entryId = await postJournal(db, { date, description: `${r.code}: ${description}`, refType: 'charge', refId: r.id, userId: user?.id, lines: chargeLines(department, amount, s.vat_rate) });
  const { rows: [c] } = await db.query(
    `INSERT INTO folio_charges (reservation_id, business_date, description, department, amount, posted_by, journal_entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [r.id, date, description, department, amount, user?.id ?? null, entryId]);
  await audit(db, user, 'folio.charge', 'reservation', r.id, { charge_id: c.id, amount, department, description });
  return c;
}

async function reverseEntry(db, user, entryId, date, description, refType, refId) {
  const { rows } = await db.query('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id = $1', [entryId]);
  return postJournal(db, { date, description, refType, refId, userId: user.id, lines: rows.map((l) => ({ account: l.account_code, debit: l.credit, credit: l.debit })) });
}

export async function voidCharge(db, user, chargeId, reason) {
  const { rows: [c] } = await db.query('SELECT * FROM folio_charges WHERE id = $1 FOR UPDATE', [chargeId]);
  if (!c) throw new HttpError(404, 'Charge not found.');
  if (c.voided) throw new HttpError(409, 'This charge is already void.');
  const why = text(reason, 'Void reason', { required: true, max: 300 });
  const s = await getSettings(db);
  const voidEntry = await reverseEntry(db, user, c.journal_entry_id, s.business_date, `VOID charge ${c.id}: ${c.description}`, 'charge_void', c.reservation_id);
  await db.query('UPDATE folio_charges SET voided=true, void_reason=$2, voided_by=$3, void_entry_id=$4 WHERE id=$1', [c.id, why, user.id, voidEntry]);
  await audit(db, user, 'folio.void_charge', 'reservation', c.reservation_id, { charge_id: c.id, amount: c.amount, reason: why });
}

export async function postPayment(db, user, id, body) {
  const r = await getReservationForUpdate(db, id);
  if (!['reserved', 'in_house', 'checked_out'].includes(r.status)) throw new HttpError(409, 'Payments cannot be taken on a cancelled or no-show booking.');
  const s = await getSettings(db);
  const method = String(body.method || '');
  if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, 'Choose a payment method.');
  if (method === 'company_account' && !(r.company_name || body.company_name)) throw new HttpError(400, 'Enter the company name to bill.');
  if (body.company_name && !r.company_name) await db.query('UPDATE reservations SET company_name=$2 WHERE id=$1', [r.id, text(body.company_name, 'Company', { max: 120 })]);
  const amount = money(body.amount, 'Amount');
  if (r.status === 'checked_out' && amount > await balanceOf(db, r.id)) throw new HttpError(400, 'Payment is more than the outstanding balance.');
  const reference = text(body.reference, 'Reference', { max: 80 });
  const entryId = await postJournal(db, { date: s.business_date, description: `${r.code}: payment (${method.replace('_', ' ')})`, refType: 'payment', refId: r.id, userId: user.id, lines: paymentLines(method, amount) });
  const { rows: [p] } = await db.query(
    `INSERT INTO payments (reservation_id, business_date, method, amount, reference, posted_by, journal_entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [r.id, s.business_date, method, amount, reference, user.id, entryId]);
  await audit(db, user, 'folio.payment', 'reservation', r.id, { payment_id: p.id, method, amount });
  return p;
}

export async function voidPayment(db, user, paymentId, reason) {
  const { rows: [p] } = await db.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (!p) throw new HttpError(404, 'Payment not found.');
  if (p.voided) throw new HttpError(409, 'This payment is already void.');
  const why = text(reason, 'Void reason', { required: true, max: 300 });
  const s = await getSettings(db);
  const voidEntry = await reverseEntry(db, user, p.journal_entry_id, s.business_date, `VOID payment ${p.id}`, 'payment_void', p.reservation_id);
  await db.query('UPDATE payments SET voided=true, void_reason=$2, voided_by=$3, void_entry_id=$4 WHERE id=$1', [p.id, why, user.id, voidEntry]);
  await audit(db, user, 'folio.void_payment', 'reservation', p.reservation_id, { payment_id: p.id, amount: p.amount, reason: why });
}

export async function checkOut(db, user, id) {
  const r = await getReservationForUpdate(db, id);
  if (r.status !== 'in_house') throw new HttpError(409, 'This guest is not in-house.');
  const s = await getSettings(db);
  const { rows: openRs } = await db.query("SELECT code FROM pos_checks WHERE reservation_id=$1 AND status='open'", [r.id]);
  if (openRs.length) throw new HttpError(409, `This guest has an open room-service bill (${openRs.map((x) => x.code).join(', ')}). Settle it first.`);
  const bal = await balanceOf(db, r.id);
  if (bal > 0) throw new HttpError(409, `Outstanding balance of UGX ${bal.toLocaleString('en-US')}. Take payment or transfer it to a company account first.`);
  // Early departure: the stay now ends today (if at least one night has passed).
  // Same-day check-out (day use) is recorded as a one-night stay with no room charge posted.
  let departure = r.departure;
  if (r.departure > s.business_date) {
    departure = s.business_date > r.arrival ? s.business_date : (await db.query("SELECT to_char($1::date + 1, 'YYYY-MM-DD') AS d", [r.arrival])).rows[0].d;
  }
  await db.query("UPDATE reservations SET status='checked_out', departure=$2, checked_out_at=now() WHERE id=$1", [r.id, departure]);
  await enqueueAri(db, r.room_type_id, s.business_date, r.departure, 'check-out');
  await db.query("UPDATE rooms SET hk_status='dirty' WHERE id=$1 AND hk_status <> 'out_of_order'", [r.room_id]);
  await audit(db, user, 'reservation.check_out', 'reservation', r.id, { balance: bal });
  return { credit_balance: bal < 0 ? -bal : 0 };
}

/* ---------------- housekeeping ---------------- */
export async function setHousekeeping(db, user, roomId, status) {
  if (!['clean', 'dirty', 'out_of_order'].includes(status)) throw new HttpError(400, 'Unknown housekeeping status.');
  const { rows: [room] } = await db.query('SELECT * FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
  if (!room) throw new HttpError(404, 'Room not found.');
  if (status === 'out_of_order') {
    const { rows } = await db.query("SELECT 1 FROM reservations WHERE room_id=$1 AND status='in_house'", [roomId]);
    if (rows[0]) throw new HttpError(409, `Room ${room.number} is occupied. Move the guest first.`);
  }
  await db.query('UPDATE rooms SET hk_status=$2 WHERE id=$1', [roomId, status]);
  if ((status === 'out_of_order') !== (room.hk_status === 'out_of_order')) await enqueueAriFromToday(db, room.room_type_id, 'room out of order change');
  await audit(db, user, 'room.housekeeping', 'room', roomId, { number: room.number, from: room.hk_status, to: status });
}

/* ---------------- night audit ---------------- */
export async function nightAuditPreview(db) {
  const s = await getSettings(db);
  const pendingDepartures = (await db.query(
    `SELECT r.id, r.code, g.first_name, g.last_name, rm.number AS room FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id
     WHERE r.status='in_house' AND r.departure <= $1 ORDER BY rm.number`, [s.business_date])).rows;
  const noShows = (await db.query(
    `SELECT r.id, r.code, g.first_name, g.last_name FROM reservations r JOIN guests g ON g.id=r.guest_id WHERE r.status='reserved' AND r.arrival <= $1`, [s.business_date])).rows;
  const inHouse = (await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(COALESCE((SELECT rate FROM reservation_nights n WHERE n.reservation_id=r.id AND n.night=$1), r.rate)),0) AS revenue
     FROM reservations r WHERE status='in_house' AND departure > $1`, [s.business_date])).rows[0];
  const openChecks = (await db.query(
    `SELECT c.id, c.code, o.name AS outlet, t.name AS table_name FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id LEFT JOIN dining_tables t ON t.id=c.table_id
     WHERE c.status='open' ORDER BY c.id`)).rows;
  return { business_date: s.business_date, pending_departures: pendingDepartures, no_shows: noShows, room_charges: inHouse.n, room_revenue: Number(inHouse.revenue), open_checks: openChecks };
}

export async function runNightAudit(db, user) {
  const s = await getSettings(db, { lock: true }); // only one audit at a time
  const date = s.business_date;
  const done = await db.query('SELECT 1 FROM night_audits WHERE business_date=$1', [date]);
  if (done.rows[0]) throw new HttpError(409, 'The night audit has already run for this date.');
  const preview = await nightAuditPreview(db);
  if (preview.pending_departures.length) {
    throw new HttpError(409, 'Some guests were due to leave today. Check them out or extend their stay before the night audit.', { pending_departures: preview.pending_departures });
  }
  if (preview.open_checks.length) {
    throw new HttpError(409, 'Some restaurant or bar bills are still open. Settle or void them before the night audit.', { open_checks: preview.open_checks });
  }
  const { rows: stays } = await db.query("SELECT * FROM reservations WHERE status='in_house' AND departure > $1 FOR UPDATE", [date]);
  let revenue = 0;
  for (const r of stays) {
    const { rows: [n] } = await db.query('SELECT rate FROM reservation_nights WHERE reservation_id=$1 AND night=$2', [r.id, date]);
    const rate = n ? n.rate : r.rate; // the price agreed for this night, else the stay's rate
    if (rate > 0) {
      await insertCharge(db, user, r, s, { department: 'rooms', amount: rate, description: `Room charge, night of ${date}`, date });
      revenue += rate;
    }
  }
  const { rows: ns } = await db.query("UPDATE reservations SET status='no_show' WHERE status='reserved' AND arrival <= $1 RETURNING room_type_id, to_char(departure,'YYYY-MM-DD') AS departure", [date]);
  const noShows = ns.length;
  for (const x of ns) await enqueueAri(db, x.room_type_id, date, x.departure, 'no-show');
  await db.query(`UPDATE rooms SET hk_status='dirty' WHERE hk_status='clean' AND id IN (SELECT room_id FROM reservations WHERE status='in_house')`);
  await db.query('INSERT INTO night_audits (business_date, run_by, room_charges_posted, room_revenue, no_shows) VALUES ($1,$2,$3,$4,$5)', [date, user.id, stays.length, revenue, noShows]);
  const { rows: [n] } = await db.query("UPDATE settings SET business_date = business_date + 1 WHERE id = 1 RETURNING to_char(business_date, 'YYYY-MM-DD') AS d");
  await audit(db, user, 'night_audit.run', 'night_audit', date, { room_charges: stays.length, room_revenue: revenue, no_shows: noShows });
  return { closed_date: date, new_business_date: n.d, room_charges_posted: stays.length, room_revenue: revenue, no_shows: noShows };
}
