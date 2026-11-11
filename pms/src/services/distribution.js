// Phase 4: rate plans, pricing, website booking engine and channel manager.
import crypto from 'node:crypto';
import { HttpError, audit } from '../auth.js';
import { tx } from '../db.js';
import { getSettings, availableCount, availabilityGrid, createReservation, cancelReservation } from './frontoffice.js';
import { enqueueAri } from './ari.js';
import { adapters } from '../channels/index.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const nightsBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
/** Plan price for one night: discount applied, rounded to the nearest 100 shillings. */
export const planRate = (rate, discountPct) => Math.round((rate * (1 - Number(discountPct) / 100)) / 100) * 100;
const MAX_NIGHTS = 30;

/* ---------------- pricing ---------------- */
/** Nightly base price and restrictions per room type for nights [from, to). */
export async function nightlyGrid(db, from, to, roomTypeIds = null) {
  const { rows } = await db.query(
    `SELECT rt.id AS room_type_id, to_char(d::date,'YYYY-MM-DD') AS night, rt.base_rate, rc.rate AS cal_rate, rc.min_stay, COALESCE(rc.stop_sell,false) AS stop_sell
     FROM room_types rt CROSS JOIN generate_series($1::date, $2::date - 1, interval '1 day') d
     LEFT JOIN rate_calendar rc ON rc.room_type_id=rt.id AND rc.date=d::date
     WHERE rt.active AND ($3::int[] IS NULL OR rt.id = ANY($3)) ORDER BY rt.id, d`, [from, to, roomTypeIds]);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.room_type_id)) by.set(r.room_type_id, []);
    by.get(r.room_type_id).push({ night: r.night, rate: r.cal_rate ?? r.base_rate, min_stay: r.min_stay, stop_sell: r.stop_sell });
  }
  return by;
}

function priceStay(nights, plan) {
  const nightly = nights.map((n) => ({ night: n.night, rate: planRate(n.rate, plan.discount_pct) }));
  const minStay = Math.max(plan.min_stay, nights[0]?.min_stay || 1);
  let reason = null;
  if (nights.some((n) => n.stop_sell)) reason = 'Not available on some of these dates.';
  else if (nights.length < minStay) reason = `Minimum stay ${minStay} nights.`;
  return { nightly, total: nightly.reduce((a, n) => a + n.rate, 0), min_stay: minStay, bookable: !reason, reason };
}

/** What can be booked for these dates (website scope: plans shown on the website). */
export async function quote(db, { arrival, departure, adults = 1 }) {
  const s = await getSettings(db);
  if (!isDate(arrival) || !isDate(departure)) throw new HttpError(400, 'Choose your arrival and departure dates.');
  if (departure <= arrival) throw new HttpError(400, 'Departure must be after arrival.');
  if (arrival < s.business_date) throw new HttpError(400, 'Arrival cannot be in the past.');
  if (nightsBetween(arrival, departure) > MAX_NIGHTS) throw new HttpError(400, `Online bookings are limited to ${MAX_NIGHTS} nights. Please contact the hotel.`);
  if (arrival > addDays(s.business_date, s.booking_horizon_days)) throw new HttpError(400, 'Those dates are too far ahead to book online.');
  const guests = Math.max(1, Math.min(20, Number(adults) || 1));
  const types = (await db.query('SELECT * FROM room_types WHERE active ORDER BY base_rate')).rows;
  const plans = (await db.query('SELECT * FROM rate_plans WHERE active AND on_website ORDER BY sort, id')).rows;
  const grid = await nightlyGrid(db, arrival, departure);
  const out = [];
  for (const t of types) {
    const available = await availableCount(db, t.id, arrival, departure);
    const fits = t.max_occupancy >= guests;
    out.push({
      room_type: { id: t.id, code: t.code, name: t.name, max_occupancy: t.max_occupancy }, available, fits,
      plans: plans.map((p) => {
        const pr = priceStay(grid.get(t.id) || [], p);
        if (pr.bookable && available < 1) Object.assign(pr, { bookable: false, reason: 'Sold out.' });
        if (pr.bookable && !fits) Object.assign(pr, { bookable: false, reason: `Up to ${t.max_occupancy} guests.` });
        return { id: p.id, code: p.code, name: p.name, description: p.description, breakfast: p.breakfast, refundable: p.refundable, ...pr };
      }),
    });
  }
  return { arrival, departure, nights: nightsBetween(arrival, departure), adults: guests, room_types: out };
}

async function saveNights(db, reservationId, nightly) {
  await db.query('DELETE FROM reservation_nights WHERE reservation_id=$1', [reservationId]);
  for (const n of nightly) await db.query('INSERT INTO reservation_nights (reservation_id, night, rate) VALUES ($1,$2,$3)', [reservationId, n.night, n.rate]);
}

/* ---------------- website booking engine ---------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function createPublicBooking(db, b) {
  const s = await getSettings(db);
  if (!s.booking_enabled) throw new HttpError(403, 'Online booking is not available right now. Please contact the hotel.');
  if (b.website) throw new HttpError(400, 'Booking could not be completed.'); // honeypot field filled in by bots
  const g = b.guest || {};
  const email = String(g.email || '').trim().toLowerCase();
  if (!String(g.first_name || '').trim() || !String(g.last_name || '').trim()) throw new HttpError(400, 'Please enter your first and last name.');
  if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpError(400, 'Please enter a valid email address.');
  if (!String(g.phone || '').trim()) throw new HttpError(400, 'Please enter a phone number.');
  const q = await quote(db, { arrival: b.arrival, departure: b.departure, adults: b.adults });
  const t = q.room_types.find((x) => x.room_type.id === Number(b.room_type_id));
  const p = t?.plans.find((x) => x.id === Number(b.rate_plan_id));
  if (!t || !p) throw new HttpError(400, 'Choose a room and rate.');
  if (!p.bookable) throw new HttpError(409, p.reason || 'This room is no longer available.');
  // createReservation locks the room type and re-checks availability, so two guests cannot take the last room
  const r = await createReservation(db, null, {
    room_type_id: t.room_type.id, arrival: q.arrival, departure: q.departure, adults: q.adults, rate: p.nightly[0].rate, source: 'Website',
    guest: { first_name: g.first_name, last_name: g.last_name, email, phone: g.phone, nationality: g.nationality }, notes: b.notes,
  });
  await db.query('UPDATE reservations SET rate_plan_id=$2 WHERE id=$1', [r.id, p.id]);
  await saveNights(db, r.id, p.nightly);
  await audit(db, null, 'booking_engine.booking', 'reservation', r.id, { code: r.code, plan: p.code, total: p.total });
  return { code: r.code, arrival: q.arrival, departure: q.departure, nights: q.nights, room_type: t.room_type.name, rate_plan: p.name, refundable: p.refundable, breakfast: p.breakfast, total: p.total, email };
}

async function findPublicBooking(db, code, email, lock = false) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, g.first_name, g.last_name, g.email, rt.name AS room_type_name, rp.name AS rate_plan_name, rp.refundable, rp.breakfast,
            (SELECT COALESCE(SUM(rate),0) FROM reservation_nights WHERE reservation_id=r.id) AS nights_total
     FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rate_plans rp ON rp.id=r.rate_plan_id
     WHERE r.code=$1 AND lower(g.email)=lower($2) AND r.channel_id IS NULL${lock ? ' FOR UPDATE OF r' : ''}`, [String(code || '').trim().toUpperCase(), String(email || '').trim()]);
  if (!r) throw new HttpError(404, 'We could not find a booking with that code and email.');
  return r;
}
export async function lookupPublicBooking(db, code, email) {
  const r = await findPublicBooking(db, code, email);
  const s = await getSettings(db);
  return {
    code: r.code, status: r.status, first_name: r.first_name, last_name: r.last_name, arrival: r.arrival, departure: r.departure, nights: nightsBetween(r.arrival, r.departure),
    room_type: r.room_type_name, rate_plan: r.rate_plan_name, breakfast: !!r.breakfast, refundable: r.refundable !== false,
    total: Number(r.nights_total) || r.rate * nightsBetween(r.arrival, r.departure),
    can_cancel: r.status === 'reserved' && r.refundable !== false && r.arrival > s.business_date,
  };
}
export async function cancelPublicBooking(db, code, email) {
  const r = await findPublicBooking(db, code, email, true);
  const s = await getSettings(db);
  if (r.status !== 'reserved') throw new HttpError(409, 'This booking can no longer be cancelled online.');
  if (r.refundable === false) throw new HttpError(409, 'This is a non-refundable rate and cannot be cancelled online. Please contact the hotel.');
  if (r.arrival <= s.business_date) throw new HttpError(409, 'Cancellations on the day of arrival must be made with the hotel directly.');
  await cancelReservation(db, null, r.id, 'Cancelled by the guest online');
  return { code: r.code, status: 'cancelled' };
}

/* ---------------- rate plans & calendar (staff) ---------------- */
export async function savePlan(db, user, id, b) {
  const name = String(b.name || '').trim(); if (!name) throw new HttpError(400, 'Name is required.');
  const disc = Number(b.discount_pct || 0); if (!(disc >= 0 && disc < 100)) throw new HttpError(400, 'Discount must be between 0 and 99%.');
  const minStay = Math.max(1, Number(b.min_stay) || 1);
  const vals = [name, String(b.description || '').trim() || null, disc, !!b.breakfast, b.refundable !== false, minStay, b.on_website !== false, b.on_channels !== false, b.active !== false, Number(b.sort) || 0];
  let p;
  if (id) {
    ({ rows: [p] } = await db.query('UPDATE rate_plans SET name=$2, description=$3, discount_pct=$4, breakfast=$5, refundable=$6, min_stay=$7, on_website=$8, on_channels=$9, active=$10, sort=$11 WHERE id=$1 RETURNING *', [id, ...vals]));
    if (!p) throw new HttpError(404, 'Rate plan not found.');
  } else {
    const code = String(b.code || '').trim().toUpperCase(); if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw new HttpError(400, 'Code: 2–20 letters, numbers, dashes or underscores.');
    ({ rows: [p] } = await db.query('INSERT INTO rate_plans (code, name, description, discount_pct, breakfast, refundable, min_stay, on_website, on_channels, active, sort) VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [...vals, code]));
  }
  await enqueueAriFromNow(db, null, 'rate plan change');
  await audit(db, user, id ? 'distribution.plan_update' : 'distribution.plan_create', 'rate_plan', p.id, { code: p.code, discount_pct: p.discount_pct, active: p.active });
  return p;
}
async function enqueueAriFromNow(db, typeId, reason) {
  const s = await getSettings(db);
  await enqueueAri(db, typeId, s.business_date, addDays(s.business_date, s.booking_horizon_days), reason);
}

/** Bulk-edit the rate calendar. Only the fields provided are changed. rate: null clears a date-specific price. */
export async function updateCalendar(db, user, b) {
  const ids = (b.room_type_ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) throw new HttpError(400, 'Choose at least one room type.');
  if (!isDate(b.from) || !isDate(b.to) || b.to < b.from) throw new HttpError(400, 'Choose a valid date range.');
  if (nightsBetween(b.from, b.to) > 400) throw new HttpError(400, 'Update at most 400 days at a time.');
  const sets = [], params = [ids, b.from, b.to];
  if ('rate' in b) { const r = b.rate === null || b.rate === '' ? null : Number(b.rate); if (r !== null && !(Number.isInteger(r) && r >= 0)) throw new HttpError(400, 'Rate must be a whole number of shillings.'); params.push(r); sets.push(`rate=$${params.length}`); }
  if ('min_stay' in b) { const m = b.min_stay === null || b.min_stay === '' ? null : Number(b.min_stay); if (m !== null && !(Number.isInteger(m) && m >= 1 && m <= 30)) throw new HttpError(400, 'Minimum stay must be 1–30 nights.'); params.push(m); sets.push(`min_stay=$${params.length}`); }
  if ('stop_sell' in b) { params.push(!!b.stop_sell); sets.push(`stop_sell=$${params.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to change.');
  await db.query(`INSERT INTO rate_calendar (room_type_id, date) SELECT t, d::date FROM unnest($1::int[]) t, generate_series($2::date, $3::date, interval '1 day') d ON CONFLICT DO NOTHING`, [ids, b.from, b.to]);
  await db.query(`UPDATE rate_calendar SET ${sets.join(', ')} WHERE room_type_id = ANY($1) AND date BETWEEN $2 AND $3`, params);
  await db.query('DELETE FROM rate_calendar WHERE rate IS NULL AND min_stay IS NULL AND NOT stop_sell');
  for (const id of ids) await enqueueAri(db, id, b.from, addDays(b.to, 1), 'rate calendar');
  await audit(db, user, 'distribution.calendar_update', 'rate_calendar', null, { room_type_ids: ids, from: b.from, to: b.to, rate: b.rate, min_stay: b.min_stay, stop_sell: b.stop_sell });
  return { ok: true };
}

export async function calendarView(db, from, days) {
  const to = addDays(from, days);
  const grid = await nightlyGrid(db, from, to);
  const avail = await availabilityGrid(db, from, days);
  const types = (await db.query('SELECT id, code, name, base_rate FROM room_types WHERE active ORDER BY id')).rows;
  return types.map((t) => ({ ...t, nights: (grid.get(t.id) || []).map((n, i) => ({ ...n, free: avail.find((a) => a.id === t.id)?.nights[i]?.free ?? 0, custom: n.rate !== t.base_rate })) }));
}

/* ---------------- channel manager: outgoing ---------------- */
/** Availability, prices and restrictions for one channel's mapped room types and rate plans. */
export async function buildAri(db, channel, roomTypeIds, from, toInclusive) {
  const { rows: maps } = await db.query(
    `SELECT m.*, p.discount_pct, p.min_stay AS plan_min_stay, p.active AND p.on_channels AS plan_open, rt.active AS type_active
     FROM channel_mappings m JOIN rate_plans p ON p.id=m.rate_plan_id JOIN room_types rt ON rt.id=m.room_type_id
     WHERE m.channel_id=$1 AND ($2::int[] IS NULL OR m.room_type_id = ANY($2))`, [channel.id, roomTypeIds]);
  if (!maps.length) return [];
  const days = nightsBetween(from, toInclusive) + 1;
  const prices = await nightlyGrid(db, from, addDays(toInclusive, 1), [...new Set(maps.map((m) => m.room_type_id))]);
  const avail = await availabilityGrid(db, from, days);
  const items = [];
  for (const m of maps) {
    const nights = prices.get(m.room_type_id) || [];
    const av = avail.find((a) => a.id === m.room_type_id)?.nights || [];
    nights.forEach((n, i) => items.push({
      room_code: m.external_room_code, rate_code: m.external_rate_code, date: n.night,
      available: Math.max(0, av[i]?.free ?? 0), rate: planRate(n.rate, m.discount_pct),
      min_stay: Math.max(m.plan_min_stay, n.min_stay || 1), closed: n.stop_sell || !m.plan_open || !m.type_active,
    }));
  }
  return items;
}

async function logChannel(db, channelId, direction, kind, status, summary, payload) {
  await db.query('INSERT INTO channel_log (channel_id, direction, kind, status, summary, payload) VALUES ($1,$2,$3,$4,$5,$6)', [channelId, direction, kind, status, summary, payload ?? null]);
}

export async function pushToChannel(pool, channel, roomTypeIds, from, toInclusive, kind = 'ari.update') {
  const items = await buildAri(pool, channel, roomTypeIds, from, toInclusive);
  if (!items.length) return { pushed: 0 };
  const adapter = adapters[channel.adapter];
  const message = { event: kind, hotel: (await getSettings(pool)).property_name, sent_at: new Date().toISOString(), currency: 'UGX', items };
  try {
    const res = await adapter.push(channel, message);
    await pool.query('UPDATE channels SET last_push_at=now(), last_error=NULL WHERE id=$1', [channel.id]);
    await logChannel(pool, channel.id, 'out', kind, 'ok', `${items.length} updates, ${from} to ${toInclusive}${res?.note ? ' · ' + res.note : ''}`, { sample: items.slice(0, 20), count: items.length });
    return { pushed: items.length };
  } catch (e) {
    await pool.query('UPDATE channels SET last_error=$2 WHERE id=$1', [channel.id, String(e.message).slice(0, 300)]);
    await logChannel(pool, channel.id, 'out', kind, 'error', String(e.message).slice(0, 300), { count: items.length });
    return { pushed: 0, error: e.message };
  }
}

/** Collect queued changes and push them to every active channel. Safe to run from several processes. */
export async function processOutbox(pool) {
  const batch = await tx(pool, async (db) => {
    const { rows } = await db.query("SELECT id, room_type_id, to_char(date_from,'YYYY-MM-DD') AS f, to_char(date_to,'YYYY-MM-DD') AS t FROM ari_outbox WHERE processed_at IS NULL ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED");
    if (!rows.length) return null;
    await db.query('UPDATE ari_outbox SET processed_at=now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    const s = await getSettings(db);
    const min = rows.reduce((a, r) => (r.f < a ? r.f : a), rows[0].f), max = rows.reduce((a, r) => (r.t > a ? r.t : a), rows[0].t);
    const from = min < s.business_date ? s.business_date : min;
    const horizon = addDays(s.business_date, s.booking_horizon_days);
    const to = max > horizon ? horizon : max;
    return { types: rows.some((r) => r.room_type_id == null) ? null : [...new Set(rows.map((r) => r.room_type_id))], from, to, changes: rows.length };
  });
  if (!batch || batch.to < batch.from) return { changes: batch?.changes || 0, channels: 0 };
  const { rows: chans } = await pool.query('SELECT * FROM channels WHERE active ORDER BY id');
  const results = [];
  for (const c of chans) results.push({ channel: c.code, ...(await pushToChannel(pool, c, batch.types, batch.from, batch.to)) });
  return { changes: batch.changes, from: batch.from, to: batch.to, results };
}

export async function fullSync(pool, channelId, days) {
  const { rows: [c] } = await pool.query('SELECT * FROM channels WHERE id=$1', [channelId]);
  if (!c) throw new HttpError(404, 'Channel not found.');
  if (!c.active) throw new HttpError(409, 'Activate the channel first.');
  const s = await getSettings(pool);
  return pushToChannel(pool, c, null, s.business_date, addDays(s.business_date, Math.min(days || s.booking_horizon_days, 730) - 1), 'ari.full_sync');
}

/* ---------------- channel manager: incoming ---------------- */
export const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
export function verifySignature(secret, rawBody, header) {
  if (!rawBody || typeof header !== 'string') return false;
  const expected = Buffer.from(sign(secret, rawBody)), got = Buffer.from(header);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/**
 * Handle a signed booking message from a channel.
 * { event: booking.created | booking.modified | booking.cancelled,
 *   booking: { id, room_code, rate_code, arrival, departure, adults, guest: {first_name, last_name, email, phone}, nightly?: [{date, rate}], notes } }
 * OTA bookings are already sold, so they are accepted even when no room is left (flagged as overbooked).
 */
export async function handleInbound(db, channel, msg) {
  const ev = msg?.event, bk = msg?.booking || {};
  const ref = String(bk.id || '').trim();
  if (!ref || ref.length > 80) throw new HttpError(400, 'booking.id is required.');
  const { rows: [existing] } = await db.query('SELECT * FROM reservations WHERE channel_id=$1 AND external_ref=$2 FOR UPDATE', [channel.id, ref]);

  if (ev === 'booking.cancelled') {
    if (!existing) throw new HttpError(404, 'Unknown booking.');
    if (existing.status === 'cancelled') return { reservation_code: existing.code, status: 'cancelled', duplicate: true };
    if (existing.status !== 'reserved') throw new HttpError(409, `Booking is ${existing.status.replace('_', ' ')} and cannot be cancelled by the channel.`);
    await cancelReservation(db, null, existing.id, `Cancelled by ${channel.name}`);
    return { reservation_code: existing.code, status: 'cancelled' };
  }
  if (!['booking.created', 'booking.modified'].includes(ev)) throw new HttpError(400, 'Unknown event.');
  const { rows: [map] } = await db.query('SELECT m.*, p.discount_pct FROM channel_mappings m JOIN rate_plans p ON p.id=m.rate_plan_id WHERE m.channel_id=$1 AND m.external_room_code=$2 AND m.external_rate_code=$3',
    [channel.id, String(bk.room_code || ''), String(bk.rate_code || '')]);
  if (!map) throw new HttpError(422, `No mapping for room "${bk.room_code}" / rate "${bk.rate_code}".`);
  if (!isDate(bk.arrival) || !isDate(bk.departure) || bk.departure <= bk.arrival) throw new HttpError(400, 'Valid arrival and departure dates are required.');
  if (nightsBetween(bk.arrival, bk.departure) > 60) throw new HttpError(400, 'Stays longer than 60 nights must be handled manually.');
  // price per night: as sent by the channel, otherwise our own plan price
  const grid = (await nightlyGrid(db, bk.arrival, bk.departure, [map.room_type_id])).get(map.room_type_id) || [];
  const sent = new Map((Array.isArray(bk.nightly) ? bk.nightly : []).map((n) => [n.date, Number(n.rate)]));
  const nightly = grid.map((n) => ({ night: n.night, rate: Number.isInteger(sent.get(n.night)) && sent.get(n.night) >= 0 ? sent.get(n.night) : planRate(n.rate, map.discount_pct) }));

  if (ev === 'booking.created' && existing) return { reservation_code: existing.code, status: existing.status, duplicate: true };
  if (ev === 'booking.modified' && existing) {
    if (!['reserved', 'in_house'].includes(existing.status)) throw new HttpError(409, `Booking is ${existing.status.replace('_', ' ')} and cannot be changed.`);
    if (existing.status === 'in_house' && (bk.arrival !== existing.arrival || map.room_type_id !== existing.room_type_id)) throw new HttpError(409, 'Guest is in-house: only the departure date can change.');
    await db.query('SELECT id FROM room_types WHERE id=$1 FOR UPDATE', [map.room_type_id]);
    const free = await availableCount(db, map.room_type_id, bk.arrival, bk.departure, existing.id);
    await db.query('UPDATE reservations SET arrival=$2, departure=$3, room_type_id=$4, rate_plan_id=$5, adults=$6, rate=$7, overbooked=$8 WHERE id=$1',
      [existing.id, bk.arrival, bk.departure, map.room_type_id, map.rate_plan_id, Math.max(1, Number(bk.adults) || existing.adults), nightly[0].rate, free < 1]);
    await saveNights(db, existing.id, nightly);
    await enqueueAri(db, existing.room_type_id, existing.arrival, existing.departure, 'channel change');
    await enqueueAri(db, map.room_type_id, bk.arrival, bk.departure, 'channel change');
    await audit(db, null, 'channel.booking_modified', 'reservation', existing.id, { channel: channel.code, ref, arrival: bk.arrival, departure: bk.departure });
    return { reservation_code: existing.code, status: existing.status, overbooked: free < 1 };
  }
  // new booking (a "modified" for a booking we never saw is treated as new)
  await db.query('SELECT id FROM room_types WHERE id=$1 FOR UPDATE', [map.room_type_id]);
  const s = await getSettings(db);
  const free = await availableCount(db, map.room_type_id, bk.arrival, bk.departure);
  const g = bk.guest || {};
  // An OTA can deliver a booking for today late; allow arrival = business date, refuse the past
  if (bk.arrival < s.business_date) throw new HttpError(400, 'Arrival is in the past.');
  const r = await createReservation(db, null, {
    room_type_id: map.room_type_id, arrival: bk.arrival, departure: bk.departure, adults: bk.adults, rate: nightly[0].rate, source: channel.name,
    guest: { first_name: String(g.first_name || 'Guest').slice(0, 80), last_name: g.last_name, email: g.email, phone: g.phone }, notes: bk.notes, allow_overbooking: true,
  });
  await db.query('UPDATE reservations SET rate_plan_id=$2, channel_id=$3, external_ref=$4, commission_pct=$5, overbooked=$6 WHERE id=$1', [r.id, map.rate_plan_id, channel.id, ref, channel.commission_pct, free < 1]);
  await saveNights(db, r.id, nightly);
  await audit(db, null, 'channel.booking_created', 'reservation', r.id, { channel: channel.code, ref, overbooked: free < 1 });
  return { reservation_code: r.code, status: 'reserved', overbooked: free < 1 };
}

export async function receiveInbound(pool, code, rawBody, signature) {
  const { rows: [channel] } = await pool.query('SELECT * FROM channels WHERE code=$1', [String(code)]);
  if (!channel || !channel.active) throw new HttpError(404, 'Unknown channel.');
  if (!verifySignature(channel.secret, rawBody, signature)) {
    await logChannel(pool, channel.id, 'in', 'rejected', 'error', 'Invalid signature', null);
    throw new HttpError(401, 'Invalid signature.');
  }
  let msg;
  try { msg = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  try {
    const result = await tx(pool, (db) => handleInbound(db, channel, msg));
    await logChannel(pool, channel.id, 'in', msg.event, 'ok', `${msg.booking?.id} → ${result.reservation_code}${result.duplicate ? ' (already received)' : ''}${result.overbooked ? ' · OVERBOOKED' : ''}`, msg);
    return result;
  } catch (e) {
    await logChannel(pool, channel.id, 'in', String(msg?.event || 'unknown'), 'error', e.message, msg);
    throw e;
  }
}

export const newSecret = () => crypto.randomBytes(24).toString('base64url');
