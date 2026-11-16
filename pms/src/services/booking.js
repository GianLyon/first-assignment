// Phase 14: the front desk's full booking: one guest, one or more rooms (each with its own type, plan and guests),
// priced per night from the rate plan (and the company's negotiated discount), with an optional deposit.
import { HttpError, audit } from '../auth.js';
import { getSettings, availableCount, createReservation, postPayment } from './frontoffice.js';
import { nightlyGrid, planRate, saveNights } from './distribution.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nightsBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

async function company(db, id) {
  if (!id) return null;
  const { rows: [c] } = await db.query('SELECT id, name, discount_pct, credit_limit FROM companies WHERE id=$1 AND active', [Number(id)]);
  if (!c) throw new HttpError(400, 'Company not found.');
  return c;
}
const discounted = (rate, pct) => (Number(pct) > 0 ? Math.round((rate * (1 - Number(pct) / 100)) / 100) * 100 : rate);

/** Every room type and every active rate plan for the dates, with rooms left and the price per night and in total. */
export async function staffQuote(db, { arrival, departure, company_id = null }) {
  const s = await getSettings(db);
  if (!DATE_RE.test(arrival || '') || !DATE_RE.test(departure || '')) throw new HttpError(400, 'Choose arrival and departure dates.');
  if (departure <= arrival) throw new HttpError(400, 'Departure must be after arrival.');
  if (arrival < String(s.business_date).slice(0, 10)) throw new HttpError(400, 'Arrival cannot be before the business date.');
  if (nightsBetween(arrival, departure) > 365) throw new HttpError(400, 'A stay can be at most 365 nights.');
  const co = await company(db, company_id);
  const types = (await db.query('SELECT * FROM room_types WHERE active ORDER BY base_rate')).rows;
  const plans = (await db.query('SELECT * FROM rate_plans WHERE active ORDER BY sort, id')).rows;
  const grid = await nightlyGrid(db, arrival, departure);
  const out = [];
  for (const t of types) {
    const nights = grid.get(t.id) || [];
    const stop = nights.some((n) => n.stop_sell);
    out.push({
      id: t.id, code: t.code, name: t.name, max_occupancy: t.max_occupancy, base_rate: Number(t.base_rate),
      available: await availableCount(db, t.id, arrival, departure), stop_sell: stop,
      plans: plans.map((p) => {
        const nightly = nights.map((n) => ({ night: n.night, rate: discounted(planRate(n.rate, p.discount_pct), co?.discount_pct) }));
        const minStay = Math.max(p.min_stay, nights[0]?.min_stay || 1);
        return { id: p.id, code: p.code, name: p.name, breakfast: p.breakfast, refundable: p.refundable, nightly, total: nightly.reduce((a, n) => a + n.rate, 0),
          min_stay: minStay, warning: nights.length < minStay ? `Minimum stay ${minStay} nights` : stop ? 'Stop-sell on some nights' : null };
      }),
    });
  }
  return { arrival, departure, nights: nightsBetween(arrival, departure), company: co ? { id: co.id, name: co.name, discount_pct: Number(co.discount_pct) } : null, room_types: out };
}

/**
 * Create a booking: rooms[] = [{ room_type_id, rate_plan_id?, rate? (a fixed nightly price overrides the plan), adults, children }].
 * Several rooms share a group code (the first room's booking number). A deposit is taken on the first room.
 */
export async function createBooking(db, user, b) {
  const rooms = Array.isArray(b.rooms) ? b.rooms : [];
  if (!rooms.length) throw new HttpError(400, 'Add at least one room.');
  if (rooms.length > 30) throw new HttpError(400, 'For more than 30 rooms, use a group block.');
  const q = await staffQuote(db, { arrival: b.arrival, departure: b.departure, company_id: b.company_id });
  // stop several rooms of a type from taking more than are free (createReservation re-checks each one under a lock)
  const want = new Map();
  for (const r of rooms) want.set(Number(r.room_type_id), (want.get(Number(r.room_type_id)) || 0) + 1);
  for (const [tid, n] of want) {
    const t = q.room_types.find((x) => x.id === tid);
    if (!t) throw new HttpError(400, 'Choose a room type for every room.');
    if (n > t.available && !b.allow_overbooking) throw new HttpError(409, `Only ${t.available} ${t.name}${t.available === 1 ? '' : 's'} left for those dates.`);
  }
  const created = [];
  let guestId = b.guest_id ? Number(b.guest_id) : null, groupCode = null, total = 0;
  for (const [i, room] of rooms.entries()) {
    const t = q.room_types.find((x) => x.id === Number(room.room_type_id));
    const adults = Math.max(1, Number(room.adults) || 1), children = Math.max(0, Number(room.children) || 0);
    if (adults + children > (t.max_occupancy || 99) + 1) throw new HttpError(400, `Room ${i + 1}: a ${t.name} sleeps up to ${t.max_occupancy}.`);
    let nightly = null;
    const fixed = room.rate === '' || room.rate == null ? null : Number(room.rate);
    if (fixed != null) {
      if (!Number.isInteger(fixed) || fixed < 0) throw new HttpError(400, `Room ${i + 1}: the rate must be a whole number of shillings.`);
    } else if (room.rate_plan_id) {
      const p = t.plans.find((x) => x.id === Number(room.rate_plan_id));
      if (!p) throw new HttpError(400, `Room ${i + 1}: choose an active rate plan.`);
      nightly = p.nightly;
    } else nightly = t.plans[0]?.nightly || null;
    const r = await createReservation(db, user, {
      ...b, guest_id: guestId, room_type_id: t.id, adults, children, rate: fixed ?? nightly?.[0]?.rate ?? t.base_rate, group_code: groupCode,
    });
    if (!groupCode && rooms.length > 1) { groupCode = r.code; await db.query('UPDATE reservations SET group_code=$2 WHERE id=$1', [r.id, groupCode]); }
    guestId = r.guest_id;
    if (room.rate_plan_id && fixed == null) await db.query('UPDATE reservations SET rate_plan_id=$2 WHERE id=$1', [r.id, Number(room.rate_plan_id)]);
    if (nightly && fixed == null) await saveNights(db, r.id, nightly);
    const stayTotal = fixed != null ? fixed * q.nights : nightly.reduce((a, n) => a + n.rate, 0);
    total += stayTotal;
    created.push({ id: r.id, code: r.code, room_type: t.name, total: stayTotal });
  }
  let deposit = null;
  const dep = b.deposit;
  if (dep && Number(dep.amount) > 0) {
    deposit = await postPayment(db, user, created[0].id, { ...dep, amount: Number(dep.amount) });
    if (!b.guarantee || b.guarantee === 'none') await db.query("UPDATE reservations SET guarantee='deposit' WHERE id = ANY($1)", [created.map((c) => c.id)]);
  }
  if (groupCode) await audit(db, user, 'reservation.group_create', 'reservation', created[0].id, { group: groupCode, rooms: created.length, total });
  return { group_code: groupCode, reservations: created, nights: q.nights, total, deposit: deposit ? { id: deposit.id, amount: Number(deposit.amount), method: deposit.method } : null };
}
