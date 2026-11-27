// Phase 22: giving a booking its room before the guest arrives.
// A booking that has not checked in can hold a room (reservations.room_id with status 'reserved').
// A room can only be held by one stay at a time: no other upcoming or in-house stay on overlapping nights,
// and no out-of-order / out-of-service block on those nights.
import { HttpError, audit } from '../auth.js';
import * as L from '../lists.js';

const YMD = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** What stops this room being used for [from, to)? null when it is free. */
export async function roomClash(db, roomId, from, to, excludeReservationId = null) {
  const { rows: [res] } = await db.query(
    `SELECT r.id, r.code, r.status, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, g.first_name || ' ' || g.last_name AS guest
       FROM reservations r JOIN guests g ON g.id=r.guest_id
      WHERE r.room_id=$1 AND r.status IN ('reserved','in_house') AND r.id IS DISTINCT FROM $4 AND r.arrival < $3 AND r.departure > $2
      ORDER BY r.arrival LIMIT 1`, [roomId, from, to, excludeReservationId]);
  if (res) return { kind: 'booking', ...res, text: res.status === 'in_house' ? `${res.guest} is staying there until ${res.departure}` : `held for ${res.guest} (${res.code}, ${res.arrival} to ${res.departure})` };
  const { rows: [blk] } = await db.query(
    `SELECT b.kind, b.reason, to_char(b.date_from,'YYYY-MM-DD') AS date_from, to_char(b.date_to,'YYYY-MM-DD') AS date_to FROM room_blocks b
      WHERE b.room_id=$1 AND b.released_at IS NULL AND b.date_from < $3 AND (b.date_to IS NULL OR b.date_to > $2) ORDER BY b.date_from LIMIT 1`, [roomId, from, to]);
  if (blk) return { kind: 'block', ...blk, text: `${blk.kind === 'out_of_order' ? 'out of order' : 'out of service'}${blk.reason ? ` (${blk.reason})` : ''}` };
  return null;
}

async function lockBooking(db, id) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, t.name AS room_type_name
       FROM reservations r JOIN room_types t ON t.id=r.room_type_id WHERE r.id=$1 FOR UPDATE OF r`, [Number(id)]);
  if (!r) throw new HttpError(404, 'Reservation not found.');
  return r;
}

/** Rooms of the booked type for this stay, each marked free or with the reason it is not. Other types are listed too, for information. */
export async function roomOptions(db, id) {
  const r = await lockBooking(db, id);
  const { rows: rooms } = await db.query(
    `SELECT rm.id, rm.number, rm.floor, rm.building, rm.view, rm.hk_status, rm.room_type_id, t.name AS type_name, t.category
       FROM rooms rm JOIN room_types t ON t.id=rm.room_type_id WHERE rm.active ORDER BY rm.building NULLS LAST, rm.floor NULLS LAST, rm.number`);
  const out = [];
  for (const rm of rooms) {
    const clash = rm.id === r.room_id ? null : await roomClash(db, rm.id, r.arrival, r.departure, r.id);
    out.push({ ...rm, same_type: rm.room_type_id === r.room_type_id, current: rm.id === r.room_id, free: !clash, reason: clash?.text || null });
  }
  return { reservation: { id: r.id, code: r.code, status: r.status, arrival: r.arrival, departure: r.departure, room_type_id: r.room_type_id, room_type_name: r.room_type_name, room_id: r.room_id }, rooms: out };
}

/** Hold a room for an upcoming booking (room_id) or release it (room_id null). Only rooms of the booked type: change the type with Edit stay first. */
export async function assignRoom(db, user, id, { room_id } = {}) {
  const r = await lockBooking(db, id);
  if (r.status !== 'reserved') throw new HttpError(409, r.status === 'in_house' ? 'The guest is already in house. Use Move room instead.' : 'Only upcoming bookings can be given a room.');
  if (room_id === null || room_id === '' || room_id === undefined) {
    if (!r.room_id) return { room: null };
    const { rows: [old] } = await db.query('SELECT number FROM rooms WHERE id=$1', [r.room_id]);
    await db.query('UPDATE reservations SET room_id=NULL WHERE id=$1', [r.id]);
    await audit(db, user, 'reservation.room_release', 'reservation', r.id, { room: old?.number });
    return { room: null };
  }
  const { rows: [room] } = await db.query('SELECT rm.*, t.name AS type_name FROM rooms rm JOIN room_types t ON t.id=rm.room_type_id WHERE rm.id=$1 AND rm.active FOR UPDATE OF rm', [Number(room_id)]);
  if (!room) throw new HttpError(400, 'Choose a room that is in service.');
  if (room.room_type_id !== r.room_type_id) throw new HttpError(409, `Room ${room.number} is a ${room.type_name}, but this booking is for a ${r.room_type_name}. Change the room type with Edit stay first (that checks the price and availability).`);
  const clash = await roomClash(db, room.id, r.arrival, r.departure, r.id);
  if (clash) throw new HttpError(409, `Room ${room.number} is not free for these nights: ${clash.text}.`);
  await db.query('UPDATE reservations SET room_id=$2 WHERE id=$1', [r.id, room.id]);
  await audit(db, user, 'reservation.room_assign', 'reservation', r.id, { room: room.number });
  return { room: room.number };
}

/** Give every unassigned booking arriving on `date` a free room of its type: clean rooms first, then rooms on the same floor as others in the same group booking. */
export async function autoAssign(db, user, date) {
  const { rows: list } = await db.query(
    `SELECT r.id FROM reservations r WHERE r.status='reserved' AND r.room_id IS NULL AND r.arrival=$1 ORDER BY r.group_code NULLS LAST, r.id FOR UPDATE`, [date]);
  const done = [], left = [];
  for (const { id } of list) {
    const opt = await roomOptions(db, id);
    const rank = (x) => (x.hk_status === 'clean' ? 0 : x.hk_status === 'dirty' ? 1 : 2);
    const pick = opt.rooms.filter((x) => x.same_type && x.free && x.hk_status !== 'out_of_order').sort((a, b) => rank(a) - rank(b))[0];
    if (!pick) { left.push(opt.reservation.code); continue; }
    await assignRoom(db, user, id, { room_id: pick.id });
    done.push({ code: opt.reservation.code, room: pick.number });
  }
  return { assigned: done, without_room: left };
}

/** After a booking's dates or type change: let go of its room if it no longer fits. Returns the released room number, if any. */
export async function releaseIfInvalid(db, user, id) {
  const { rows: [r] } = await db.query(
    `SELECT r.id, r.status, r.room_id, r.room_type_id, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, rm.number, rm.room_type_id AS rm_type
       FROM reservations r LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.id=$1`, [id]);
  if (!r || r.status !== 'reserved' || !r.room_id) return null;
  const clash = r.rm_type !== r.room_type_id ? { text: 'different room type' } : await roomClash(db, r.room_id, r.arrival, r.departure, r.id);
  if (!clash) return null;
  await db.query('UPDATE reservations SET room_id=NULL WHERE id=$1', [r.id]);
  await audit(db, user, 'reservation.room_release', 'reservation', r.id, { room: r.number, reason: clash.text });
  return r.number;
}

export { YMD };

/**
 * Set up many rooms at once from lines of text (one room per line, separated by commas or tabs):
 *   room number, room type code, room type name, group, building, floor, view
 * Missing room types are created (rate 0 until set); existing rooms are updated. With `replace`, rooms and
 * room types not in the list are taken out of service (never deleted, so past bookings keep their history).
 */
export async function importLayout(db, user, { text, replace = false } = {}) {
  const VIEWS = L.VIEWS;
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new HttpError(400, 'Paste at least one room, one per line.');
  if (lines.length > 2000) throw new HttpError(400, 'Up to 2,000 rooms at a time.');
  const rows = [], seen = new Set();
  lines.forEach((l, i) => {
    const c = l.split(/\t|,/).map((x) => x.trim());
    if (/^room/i.test(c[0]) && i === 0) return; // header line
    const [number, code, name, category, building, floor, view] = c;
    if (!number || !code) throw new HttpError(400, `Line ${i + 1}: give at least the room number and the room type code.`);
    if (number.length > 10) throw new HttpError(400, `Line ${i + 1}: room number "${number}" is too long.`);
    if (seen.has(number)) throw new HttpError(400, `Room ${number} is listed twice.`);
    const v = (view || '').toLowerCase();
    if (v && !VIEWS.includes(v)) throw new HttpError(400, `Line ${i + 1}: view must be one of ${VIEWS.join(', ')}.`);
    seen.add(number);
    rows.push({ number, code: code.toUpperCase().slice(0, 20), name: (name || code).slice(0, 80), category: category || null, building: building || null, floor: floor || null, view: v || null });
  });
  const types = new Map();
  let typesCreated = 0, roomsCreated = 0, roomsUpdated = 0;
  for (const x of rows) {
    if (!types.has(x.code)) {
      const { rows: [t] } = await db.query('SELECT * FROM room_types WHERE code=$1', [x.code]);
      if (t) {
        await db.query('UPDATE room_types SET name=$2, category=COALESCE($3, category), active=TRUE WHERE id=$1', [t.id, x.name, x.category]);
        types.set(x.code, t.id);
      } else {
        const { rows: [n] } = await db.query('INSERT INTO room_types (code, name, base_rate, category, sort) VALUES ($1,$2,0,$3,(SELECT COALESCE(max(sort),0)+1 FROM room_types)) RETURNING id', [x.code, x.name, x.category]);
        types.set(x.code, n.id); typesCreated++;
      }
    }
    const typeId = types.get(x.code);
    const { rows: [old] } = await db.query('SELECT id FROM rooms WHERE number=$1', [x.number]);
    if (old) {
      await db.query('UPDATE rooms SET room_type_id=$2, building=$3, floor=$4, view=COALESCE($5, view), active=TRUE WHERE id=$1', [old.id, typeId, x.building, x.floor, x.view]);
      roomsUpdated++;
    } else {
      await db.query('INSERT INTO rooms (number, room_type_id, building, floor, view) VALUES ($1,$2,$3,$4,$5)', [x.number, typeId, x.building, x.floor, x.view]);
      roomsCreated++;
    }
  }
  let roomsRetired = 0, typesRetired = 0;
  if (replace) {
    const keep = rows.map((x) => x.number);
    const { rows: busy } = await db.query(`SELECT DISTINCT rm.number FROM rooms rm JOIN reservations r ON r.room_id=rm.id AND r.status IN ('reserved','in_house') WHERE rm.active AND NOT (rm.number = ANY($1))`, [keep]);
    if (busy.length) throw new HttpError(409, `These rooms are not in your list but have guests or held bookings: ${busy.map((b) => b.number).join(', ')}. Move those bookings first, or add the rooms to the list.`);
    roomsRetired = (await db.query('UPDATE rooms SET active=FALSE WHERE active AND NOT (number = ANY($1))', [keep])).rowCount;
    typesRetired = (await db.query('UPDATE room_types SET active=FALSE WHERE active AND NOT (code = ANY($1))', [[...types.keys()]])).rowCount;
  }
  await audit(db, user, 'rooms.import', 'room', null, { rooms: rows.length, roomsCreated, roomsUpdated, typesCreated, roomsRetired, typesRetired, replace: !!replace });
  return { rooms: rows.length, rooms_created: roomsCreated, rooms_updated: roomsUpdated, types_created: typesCreated, rooms_retired: roomsRetired, types_retired: typesRetired };
}

/* ---------------- deleting set-up that was never used ---------------- */
/** Delete a room that has no bookings, moves or maintenance history. Its housekeeping tasks and blocks go with it. */
export async function deleteRoom(db, user, id) {
  const { rows: [room] } = await db.query('SELECT * FROM rooms WHERE id=$1 FOR UPDATE', [id]);
  if (!room) throw new HttpError(404, 'Room not found.');
  const { rows: [use] } = await db.query(`SELECT
      (SELECT count(*) FROM reservations WHERE room_id=$1)::int AS res,
      (SELECT count(*) FROM room_moves WHERE from_room_id=$1 OR to_room_id=$1)::int AS moves,
      (SELECT count(*) FROM work_orders WHERE room_id=$1)::int AS works`, [id]);
  if (use.res || use.moves || use.works) {
    throw new HttpError(409, `Room ${room.number} has history (${[use.res && `${use.res} booking(s)`, use.moves && `${use.moves} room move(s)`, use.works && `${use.works} maintenance job(s)`].filter(Boolean).join(', ')}), so it cannot be deleted. Untick "In service" instead: it disappears from the room board and from sale, and old bills stay correct.`);
  }
  await db.query('DELETE FROM hk_tasks WHERE room_id=$1', [id]);
  await db.query('DELETE FROM room_blocks WHERE room_id=$1', [id]);
  await db.query('UPDATE rooms SET connects_to=NULL WHERE connects_to=$1', [room.number]);
  await db.query('DELETE FROM rooms WHERE id=$1', [id]);
  await audit(db, user, 'room.delete', 'room', id, { number: room.number });
  return { deleted: room.number };
}
/** Delete a room type with no rooms and no bookings. Its price calendar and channel mappings go with it. */
export async function deleteRoomType(db, user, id) {
  const { rows: [t] } = await db.query('SELECT * FROM room_types WHERE id=$1 FOR UPDATE', [id]);
  if (!t) throw new HttpError(404, 'Room type not found.');
  const { rows: [use] } = await db.query(`SELECT (SELECT count(*) FROM rooms WHERE room_type_id=$1)::int AS rooms, (SELECT count(*) FROM reservations WHERE room_type_id=$1)::int AS res`, [id]);
  if (use.rooms) throw new HttpError(409, `${t.name} still has ${use.rooms} room(s). Delete those rooms or give them another type first.`);
  if (use.res) throw new HttpError(409, `${t.name} has ${use.res} booking(s) in its history, so it cannot be deleted. Untick "On sale" instead.`);
  await db.query('DELETE FROM rate_calendar WHERE room_type_id=$1', [id]);
  await db.query('DELETE FROM channel_mappings WHERE room_type_id=$1', [id]);
  await db.query('DELETE FROM ari_outbox WHERE room_type_id=$1', [id]);
  await db.query('DELETE FROM room_types WHERE id=$1', [id]);
  await audit(db, user, 'room_type.delete', 'room_type', id, { code: t.code, name: t.name });
  return { deleted: t.name };
}
