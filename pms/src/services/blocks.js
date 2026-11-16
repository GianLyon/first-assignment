// Phase 16: room blocks. A room can be taken off sale (out of order) or kept on sale with a known issue
// (out of service) for a set period or until it is fixed. Out-of-order nights come off every availability count,
// the website and the channels; the room board shows the room as out of order while a block covers the business
// date. Blocks are raised by housekeeping or maintenance and released when the fault is fixed.
import { HttpError, audit } from '../auth.js';
import { getSettings } from './frontoffice.js';
import { enqueueAri } from './ari.js';

export const BLOCK_CATEGORIES = ['plumbing', 'electrical', 'air_conditioning', 'furniture', 'appliance', 'structure', 'painting', 'pest_control', 'deep_clean', 'renovation', 'other'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const OPEN_HORIZON = 365; // an open-ended block counts against this many nights ahead
/** SQL: is room <alias> blocked out of order on night <expr>? */
export const BLOCKED_ON = (alias, night) => `EXISTS (SELECT 1 FROM room_blocks b WHERE b.room_id=${alias}.id AND b.kind='out_of_order' AND b.date_from <= ${night} AND (b.date_to IS NULL OR b.date_to > ${night}))`;

/** Make the room's status match its blocks on the business date: out of order while blocked, then dirty for cleaning. */
export async function syncRoomStatus(db, roomId) {
  const s = await getSettings(db);
  const { rows: [r] } = await db.query(`SELECT rm.hk_status, ${BLOCKED_ON('rm', '$2::date')} AS blocked FROM rooms rm WHERE rm.id=$1`, [roomId, s.business_date]);
  if (!r) return;
  if (r.blocked && r.hk_status !== 'out_of_order') await db.query("UPDATE rooms SET hk_status='out_of_order' WHERE id=$1", [roomId]);
  if (!r.blocked && r.hk_status === 'out_of_order') await db.query("UPDATE rooms SET hk_status='dirty' WHERE id=$1", [roomId]);
}

/** Nights in [from, to) where taking one more room of this type off sale would leave fewer rooms than bookings. */
async function overbookedNights(db, roomTypeId, from, to) {
  const { rows } = await db.query(`WITH n AS (SELECT d::date AS night FROM generate_series($2::date, $3::date - 1, interval '1 day') d)
    SELECT to_char(n.night,'YYYY-MM-DD') AS night,
      (SELECT count(*) FROM rooms rm WHERE rm.room_type_id=$1 AND rm.active AND NOT ${BLOCKED_ON('rm', 'n.night')})
      - (SELECT count(*) FROM reservations r WHERE r.room_type_id=$1 AND r.status IN ('reserved','in_house') AND r.arrival <= n.night AND r.departure > n.night) AS free
    FROM n`, [roomTypeId, from, to]);
  return rows.filter((x) => Number(x.free) < 1).map((x) => x.night);
}

export async function createBlock(db, user, b) {
  const s = await getSettings(db), bd = ymd(s.business_date);
  const { rows: [room] } = await db.query('SELECT rm.*, t.name AS type_name FROM rooms rm JOIN room_types t ON t.id=rm.room_type_id WHERE rm.id=$1 AND rm.active FOR UPDATE OF rm', [Number(b.room_id)]);
  if (!room) throw new HttpError(400, 'Choose a room.');
  const kind = b.kind === 'out_of_service' ? 'out_of_service' : 'out_of_order';
  const from = b.date_from || bd, to = b.date_to || null;
  if (!DATE_RE.test(from) || (to && !DATE_RE.test(to))) throw new HttpError(400, 'Dates are not valid.');
  if (from < bd) throw new HttpError(400, 'A block cannot start before the business date.');
  if (to && to <= from) throw new HttpError(400, 'The room must be back at least one night after the block starts.');
  const category = BLOCK_CATEGORIES.includes(b.category) ? b.category : 'other';
  const reason = String(b.reason || '').trim().slice(0, 300);
  if (!reason) throw new HttpError(400, 'Say what is wrong.');
  // never two blocks on the same room at once
  const { rows: [clash] } = await db.query(`SELECT id, to_char(date_from,'YYYY-MM-DD') AS f FROM room_blocks WHERE room_id=$1 AND released_at IS NULL
      AND date_from < COALESCE($3::date, 'infinity'::date) AND COALESCE(date_to, 'infinity'::date) > $2::date`, [room.id, from, to]);
  if (clash) throw new HttpError(409, `Room ${room.number} already has a block from ${clash.f}. Change or release that one.`);
  if (kind === 'out_of_order') {
    // a guest in the room: block only after they leave
    const { rows: [inh] } = await db.query("SELECT to_char(departure,'YYYY-MM-DD') AS dep FROM reservations WHERE room_id=$1 AND status='in_house'", [room.id]);
    if (inh && from < inh.dep) throw new HttpError(409, `A guest is in room ${room.number} until ${inh.dep}. Move them first, or start the block on ${inh.dep}.`);
    const nights = await overbookedNights(db, room.room_type_id, from, to || addDays(from, OPEN_HORIZON));
    if (nights.length && !b.force) {
      throw new HttpError(409, `Taking room ${room.number} off sale would overbook ${room.type_name} on ${nights.length} night${nights.length === 1 ? '' : 's'} (${nights.slice(0, 4).join(', ')}${nights.length > 4 ? ' …' : ''}). Move bookings to another type first, or confirm to block anyway.`, { overbooked_nights: nights });
    }
  }
  let woId = b.work_order_id ? Number(b.work_order_id) : null;
  if (!woId && b.create_work_order) {
    const { rows: [w] } = await db.query(`INSERT INTO work_orders (title, description, kind, priority, room_id, room_out_of_order, due_date, reported_by)
      VALUES ($1,$2,'repair',$3,$4,$5,$6,$7) RETURNING id`, [reason.slice(0, 150), String(b.details || '').trim().slice(0, 1000) || null, ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'high',
      room.id, kind === 'out_of_order', to ? addDays(to, -1) : addDays(from, 1), user?.id ?? null]);
    woId = w.id;
  }
  const { rows: [blk] } = await db.query(`INSERT INTO room_blocks (room_id, kind, date_from, date_to, category, reason, work_order_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [room.id, kind, from, to, category, reason, woId, user?.id ?? null]);
  await syncRoomStatus(db, room.id);
  if (kind === 'out_of_order') await enqueueAri(db, room.room_type_id, from, to || addDays(from, OPEN_HORIZON), `room ${room.number} out of order`);
  await audit(db, user, 'room.block', 'room', room.id, { number: room.number, kind, from, to, category, forced: !!b.force });
  return blk;
}

/** End a block: the room is fixed (it goes to housekeeping for cleaning) or a future block is cancelled. */
export async function releaseBlock(db, user, id, notes) {
  const s = await getSettings(db), bd = ymd(s.business_date);
  const { rows: [blk] } = await db.query('SELECT b.*, rm.number, rm.room_type_id FROM room_blocks b JOIN rooms rm ON rm.id=b.room_id WHERE b.id=$1 FOR UPDATE OF b', [id]);
  if (!blk) throw new HttpError(404, 'Block not found.');
  if (blk.released_at) throw new HttpError(409, 'This block was already released.');
  const from = ymd(blk.date_from), oldTo = blk.date_to ? ymd(blk.date_to) : addDays(from, OPEN_HORIZON);
  const newTo = from >= bd ? from : bd; // a future block is cancelled (no nights); a current one ends today
  await db.query('UPDATE room_blocks SET date_to=$2, released_at=now(), released_by=$3, release_notes=$4 WHERE id=$1', [id, newTo, user?.id ?? null, String(notes || '').trim().slice(0, 500) || null]);
  await syncRoomStatus(db, blk.room_id);
  if (blk.kind === 'out_of_order' && oldTo > newTo) await enqueueAri(db, blk.room_type_id, newTo, oldTo, `room ${blk.number} back in service`);
  await audit(db, user, 'room.block_release', 'room', blk.room_id, { number: blk.number, block: id });
  return { ok: true };
}

/** Change the end date (the repair takes longer, or finishes sooner). */
export async function extendBlock(db, user, id, dateTo) {
  const s = await getSettings(db), bd = ymd(s.business_date);
  const { rows: [blk] } = await db.query('SELECT b.*, rm.number, rm.room_type_id FROM room_blocks b JOIN rooms rm ON rm.id=b.room_id WHERE b.id=$1 FOR UPDATE OF b', [id]);
  if (!blk || blk.released_at) throw new HttpError(404, 'Open block not found.');
  const to = dateTo || null;
  if (to && (!DATE_RE.test(to) || to <= ymd(blk.date_from) || to <= bd)) throw new HttpError(400, 'The new end must be after the start and after today.');
  const oldTo = blk.date_to ? ymd(blk.date_to) : null;
  if (blk.kind === 'out_of_order' && (!to || (oldTo && to > oldTo))) {
    const nights = await overbookedNights(db, blk.room_type_id, oldTo || addDays(bd, OPEN_HORIZON), to || addDays(bd, OPEN_HORIZON));
    if (nights.length) throw new HttpError(409, `Keeping room ${blk.number} off sale longer would overbook on ${nights.slice(0, 4).join(', ')}.`);
  }
  await db.query('UPDATE room_blocks SET date_to=$2 WHERE id=$1', [id, to]);
  if (blk.kind === 'out_of_order') { const a = [oldTo || addDays(bd, OPEN_HORIZON), to || addDays(bd, OPEN_HORIZON)].sort(); await enqueueAri(db, blk.room_type_id, a[0] < bd ? bd : a[0], a[1], `room ${blk.number} block changed`); }
  await audit(db, user, 'room.block_change', 'room', blk.room_id, { number: blk.number, from: oldTo, to });
  return { ok: true };
}

export async function listBlocks(db, { scope = 'current' } = {}) {
  const s = await getSettings(db);
  const where = { current: 'b.released_at IS NULL AND b.date_from <= $1', upcoming: 'b.released_at IS NULL AND b.date_from > $1', past: 'b.released_at IS NOT NULL' }[scope] || 'b.released_at IS NULL';
  const { rows } = await db.query(`SELECT b.id, b.kind, b.category, b.reason, to_char(b.date_from,'YYYY-MM-DD') AS date_from, to_char(b.date_to,'YYYY-MM-DD') AS date_to, b.created_at, b.released_at, b.release_notes,
      rm.id AS room_id, rm.number AS room, rm.floor, t.name AS room_type, u.full_name AS created_by_name, ru.full_name AS released_by_name,
      w.id AS work_order_id, w.code AS work_order_code, w.status AS work_order_status, w.assigned_to
    FROM room_blocks b JOIN rooms rm ON rm.id=b.room_id JOIN room_types t ON t.id=rm.room_type_id LEFT JOIN users u ON u.id=b.created_by LEFT JOIN users ru ON ru.id=b.released_by LEFT JOIN work_orders w ON w.id=b.work_order_id
    WHERE ${where} ORDER BY ${scope === 'past' ? 'b.released_at DESC' : 'b.date_from, rm.number'} LIMIT 300`, where.includes('$1') ? [s.business_date] : []);
  return { business_date: ymd(s.business_date), blocks: rows };
}

/** Night audit: blocks starting on the new date take their rooms out of order; finished ones hand rooms back. */
export async function activateBlocks(db) {
  const s = await getSettings(db);
  await db.query(`UPDATE room_blocks SET released_at=now(), release_notes=COALESCE(release_notes, 'Ended on its end date') WHERE released_at IS NULL AND date_to IS NOT NULL AND date_to <= $1`, [s.business_date]);
  await db.query(`UPDATE rooms rm SET hk_status='out_of_order' WHERE rm.hk_status <> 'out_of_order' AND ${BLOCKED_ON('rm', '$1::date')}
    AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.room_id=rm.id AND r.status='in_house')`, [s.business_date]);
  await db.query(`UPDATE rooms rm SET hk_status='dirty' WHERE rm.hk_status='out_of_order' AND NOT ${BLOCKED_ON('rm', '$1::date')}`, [s.business_date]);
}
