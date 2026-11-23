// Channex (channex.io): a channel manager with an open API, certified with Booking.com, Expedia, Agoda, Airbnb and
// many more. Booking.com, Expedia and Agoda only let certified connectivity partners use their APIs, so one Channex
// property connects Azeli PMS to all of them:
//   out  availability per room type and price / minimum stay / stop-sell per rate plan  → POST /availability, /restrictions
//   in   bookings, changes and cancellations from every OTA ← the booking revisions feed (acknowledged once saved),
//        pulled every minute and at once when Channex calls our webhook.
// Room types and rate plans are matched through the channel's mapping: room code = Channex room type id, rate
// code = Channex rate plan id. Keys: CHANNEX_API_KEY; CHANNEX_API_BASE (default production; staging for testing).
import { tx } from '../db.js';
import { cardFacts, saveCard, cardBookingCancelled, withoutCard } from '../services/otacards.js';

const env = process.env;
export const channexBase = () => (env.CHANNEX_API_BASE || 'https://app.channex.io/api/v1').replace(/\/+$/, '');
export const channexConfigured = () => !!env.CHANNEX_API_KEY;

async function call(method, path, body) {
  if (!env.CHANNEX_API_KEY) throw new Error('CHANNEX_API_KEY is not set in the hosting settings.');
  const res = await fetch(channexBase() + path, {
    method, headers: { 'user-api-key': env.CHANNEX_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.errors;
    const detail = typeof e === 'string' ? e : e?.title || e?.details ? `${e.title || ''} ${typeof e.details === 'string' ? e.details : JSON.stringify(e.details || '')}`.trim() : res.statusText;
    throw new Error(`Channex ${res.status}: ${String(detail).slice(0, 240)}`);
  }
  return data;
}

/** Turn day-by-day values into date ranges: consecutive days with the same values become one entry. */
export function toRanges(days, keyOf, make) {
  const out = [];
  const sorted = [...days].sort((a, b) => (keyOf(a) + a.date).localeCompare(keyOf(b) + b.date));
  let cur = null;
  const next = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  for (const d of sorted) {
    const k = keyOf(d);
    if (cur && cur.key === k && next(cur.to) === d.date) { cur.to = d.date; continue; }
    if (cur) out.push(make(cur.first, cur.from, cur.to));
    cur = { key: k, first: d, from: d.date, to: d.date };
  }
  if (cur) out.push(make(cur.first, cur.from, cur.to));
  return out;
}

/** Push availability and rates (the PMS's ARI items) to Channex. */
export async function pushAri(channel, message) {
  if (!channel.external_property_id) throw new Error('Set the Channex property id on this channel.');
  const pid = channel.external_property_id;
  // availability is per room type: one value per room code and date
  const avail = new Map();
  for (const i of message.items) avail.set(`${i.room_code}|${i.date}`, { room_code: i.room_code, date: i.date, available: i.available });
  const availability = toRanges([...avail.values()], (d) => `${d.room_code}|${d.available}`,
    (d, from, to) => ({ property_id: pid, room_type_id: d.room_code, date_from: from, date_to: to, availability: d.available }));
  // UGX has no minor unit, so the price is sent as whole shillings
  const restrictions = toRanges(message.items, (d) => `${d.rate_code}|${d.rate}|${d.min_stay}|${d.closed}`,
    (d, from, to) => ({ property_id: pid, rate_plan_id: d.rate_code, date_from: from, date_to: to, rate: String(d.rate), min_stay_arrival: d.min_stay, stop_sell: !!d.closed }));
  for (let i = 0; i < availability.length; i += 500) await call('POST', '/availability', { values: availability.slice(i, i + 500) });
  for (let i = 0; i < restrictions.length; i += 500) await call('POST', '/restrictions', { values: restrictions.slice(i, i + 500) });
  return { note: `${availability.length} availability and ${restrictions.length} rate ranges` };
}

const EVENT = { new: 'booking.created', modified: 'booking.modified', cancelled: 'booking.cancelled' };
/**
 * A Channex booking revision → the PMS's own channel messages, one per room (a booking with three rooms becomes
 * three reservations: <booking id>, <booking id>#2, <booking id>#3).
 */
export function revisionToMessages(rev) {
  const a = rev?.attributes || rev || {};
  const ev = EVENT[a.status];
  if (!ev) throw new Error(`Unknown booking status "${a.status}".`);
  const id = String(a.booking_id || rev.id || '').slice(0, 60);
  if (!id) throw new Error('Booking id missing.');
  const c = a.customer || {};
  const rooms = Array.isArray(a.rooms) && a.rooms.length ? a.rooms : [{}];
  const ugx = String(a.currency || '').toUpperCase() === 'UGX';
  const ota = String(a.ota_name || 'OTA').slice(0, 40);
  const notes = [`${ota} booking ${a.ota_reservation_code || ''}`.trim(), !ugx && a.amount ? `OTA total ${a.amount} ${a.currency} (prices on the bill use our own rates)` : '', a.notes ? String(a.notes) : '']
    .filter(Boolean).join(' · ').slice(0, 1000);
  return {
    booking_id: id, ota, status: a.status, rooms: rooms.length,
    messages: rooms.map((r, i) => ({
      event: ev,
      booking: {
        id: i === 0 ? id : `${id}#${i + 1}`, room_code: String(r.room_type_id || ''), rate_code: String(r.rate_plan_id || ''),
        arrival: String(r.checkin_date || a.arrival_date || '').slice(0, 10), departure: String(r.checkout_date || a.departure_date || '').slice(0, 10),
        adults: Number(r.occupancy?.adults) || 1,
        guest: { first_name: c.name || 'Guest', last_name: c.surname || '', email: c.mail || c.email || null, phone: c.phone || null },
        nightly: ugx && r.days && typeof r.days === 'object' ? Object.entries(r.days).map(([date, rate]) => ({ date, rate: Math.round(Number(rate)) })) : [],
        notes,
      },
    })),
  };
}

/** Save one revision: every room, all or nothing. Rooms dropped by a modification are cancelled. */
export async function applyRevision(db, channel, rev, handleInbound) {
  const m = revisionToMessages(rev);
  const results = [];
  if (m.status === 'cancelled') {
    const { rows } = await db.query("SELECT external_ref FROM reservations WHERE channel_id=$1 AND (external_ref=$2 OR external_ref LIKE $2 || '#%') AND status <> 'cancelled' ORDER BY id", [channel.id, m.booking_id]);
    for (const r of rows) results.push(await handleInbound(db, channel, { event: 'booking.cancelled', booking: { id: r.external_ref } }));
    if (!rows.length) results.push({ status: 'cancelled', duplicate: true });
    const { rows: [first] } = await db.query('SELECT id FROM reservations WHERE channel_id=$1 AND external_ref=$2', [channel.id, m.booking_id]);
    if (first) await cardBookingCancelled(db, first.id);
  } else {
    for (const msg of m.messages) {
      const r = await handleInbound(db, channel, msg);
      await db.query('UPDATE reservations SET source=$3 WHERE channel_id=$1 AND external_ref=$2', [channel.id, msg.booking.id, m.ota]);
      results.push(r);
    }
    const { rows: extra } = await db.query("SELECT external_ref FROM reservations WHERE channel_id=$1 AND external_ref LIKE $2 || '#%' AND status='reserved'", [channel.id, m.booking_id]);
    for (const r of extra) if (Number(r.external_ref.split('#')[1]) > m.rooms) results.push(await handleInbound(db, channel, { event: 'booking.cancelled', booking: { id: r.external_ref } }));
    // who collects the money, and the card's safe facts (never the number), on the booking's first room
    const a = rev?.attributes || rev || {};
    const { rows: [first] } = await db.query('SELECT id FROM reservations WHERE channel_id=$1 AND external_ref=$2', [channel.id, m.booking_id]);
    if (first) await saveCard(db, { reservationId: first.id, channelId: channel.id, ota: m.ota, otaRef: a.ota_reservation_code, facts: cardFacts(a) });
  }
  return { ...m, results };
}

/**
 * Pull every revision Channex has not had acknowledged yet, save it, then acknowledge it. A revision that cannot be
 * saved (e.g. a room type that is not mapped) is not acknowledged: it stays in the feed, the error is in the channel
 * log, and Channex emails the hotel after 30 minutes, so nothing is lost silently.
 */
export async function pullBookings(pool, channel, { handleInbound, logChannel }) {
  if (!channel.external_property_id) throw new Error('Set the Channex property id on this channel.');
  let saved = 0, failed = 0;
  const seen = new Set();
  for (let page = 0; page < 10; page++) {
    const feed = await call('GET', `/booking_revisions/feed?filter[property_id]=${encodeURIComponent(channel.external_property_id)}&order[inserted_at]=asc`);
    const revs = (feed?.data || []).filter((r) => !seen.has(r.id));
    if (!revs.length) break;
    let acked = 0;
    for (const rev of revs) {
      seen.add(rev.id);
      let summary;
      try {
        const out = await tx(pool, (db) => applyRevision(db, channel, rev, handleInbound));
        summary = `${out.ota} ${out.status}: ${out.results.map((x) => `${x.reservation_code || ''}${x.duplicate ? ' (already received)' : ''}${x.overbooked ? ' · OVERBOOKED' : ''}`).join(', ')}`;
      } catch (e) {
        failed++;
        await logChannel(pool, channel.id, 'in', 'channex.revision', 'error', `${rev.attributes?.ota_name || ''} ${rev.attributes?.ota_reservation_code || rev.id}: ${e.message}`.trim().slice(0, 300), { id: rev.id, attributes: withoutCard(rev.attributes) });
        continue;
      }
      await call('POST', `/booking_revisions/${encodeURIComponent(rev.id)}/ack`);
      await logChannel(pool, channel.id, 'in', 'channex.revision', 'ok', summary.slice(0, 300), { id: rev.id, ota: rev.attributes?.ota_name, code: rev.attributes?.ota_reservation_code });
      saved++; acked++;
    }
    if (!acked) break;
  }
  await pool.query('UPDATE channels SET last_pull_at=now() WHERE id=$1', [channel.id]);
  return { saved, failed };
}
