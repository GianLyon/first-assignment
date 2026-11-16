// Phase 16: the housekeeping board. Each business day gets a list of rooms to clean (departures, stayovers, vacant
// dirty rooms), shared out between the room attendants. Attendants work from their phones: start, done, do not
// disturb, report a fault. The supervisor sees progress, reassigns, inspects or sends a room back.
import { HttpError, audit, can } from '../auth.js';
import { getSettings, setHousekeeping } from './frontoffice.js';

const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
export const KIND_CREDITS = { departure: 2, stayover: 1, vacant_dirty: 1, touch_up: 0.5 };

/** Work out today's rooms to clean. Safe to run again: it adds new rooms and updates rooms not yet started. */
export async function generateTasks(db, user = null) {
  const s = await getSettings(db), bd = ymd(s.business_date);
  const { rows: rooms } = await db.query(`SELECT rm.id, rm.number, rm.hk_status, rm.room_type_id,
      (SELECT to_char(r.departure,'YYYY-MM-DD') FROM reservations r WHERE r.room_id=rm.id AND r.status='in_house' LIMIT 1) AS in_house_until,
      EXISTS (SELECT 1 FROM reservations r WHERE r.room_id=rm.id AND r.status='checked_out' AND r.departure >= $1::date - 1 AND r.checked_out_at > now() - interval '30 hours') AS just_left,
      (SELECT count(*) FROM reservations r WHERE r.room_type_id=rm.room_type_id AND r.status='reserved' AND r.arrival <= $1)::int AS arrivals_of_type
    FROM rooms rm WHERE rm.active AND rm.hk_status <> 'out_of_order'`, [bd]);
  const { rows: existing } = await db.query('SELECT * FROM hk_tasks WHERE business_date=$1', [bd]);
  const byRoom = new Map(existing.map((t) => [t.room_id, t]));
  let added = 0, updated = 0, removed = 0;
  for (const r of rooms) {
    let kind = null;
    if (r.in_house_until) kind = r.in_house_until <= bd ? 'departure' : 'stayover';
    else if (r.hk_status === 'dirty') kind = r.just_left ? 'departure' : 'vacant_dirty';
    const priority = kind && kind !== 'stayover' && r.arrivals_of_type > 0 ? 'high' : 'normal';
    const t = byRoom.get(r.id);
    if (!kind) {
      // a vacant clean room needs nothing: drop a task nobody started
      if (t && t.status === 'pending') { await db.query('DELETE FROM hk_tasks WHERE id=$1', [t.id]); removed++; }
      continue;
    }
    if (!t) {
      await db.query('INSERT INTO hk_tasks (business_date, room_id, kind, priority) VALUES ($1,$2,$3,$4)', [bd, r.id, kind, priority]);
      added++;
    } else if (t.status === 'pending' && (t.kind !== kind || t.priority !== priority)) {
      await db.query('UPDATE hk_tasks SET kind=$2, priority=$3 WHERE id=$1', [t.id, kind, priority]); updated++;
    } else if (['done', 'inspected', 'skipped'].includes(t.status) && r.hk_status === 'dirty' && kind === 'departure' && t.kind === 'stayover') {
      // the guest checked out after their room was serviced: it needs a full departure clean now
      await db.query("UPDATE hk_tasks SET kind='departure', priority=$2, status='pending', started_at=NULL, done_at=NULL, done_by=NULL, inspected_at=NULL, inspected_by=NULL WHERE id=$1", [t.id, priority]); updated++;
    }
  }
  if (user) await audit(db, user, 'housekeeping.generate', 'hk_tasks', null, { date: bd, added, updated, removed });
  return { business_date: bd, added, updated, removed };
}

/** The room attendants: active staff in the housekeeping role. */
export const attendants = async (db) => (await db.query("SELECT id, full_name FROM users WHERE active AND role='housekeeping' ORDER BY full_name")).rows;

/**
 * Share out the unassigned rooms so everyone has about the same work (a departure counts double), keeping each
 * person's rooms close together by floor.
 */
export async function autoAssign(db, user, ids = null) {
  const s = await getSettings(db), bd = ymd(s.business_date);
  let people = await attendants(db);
  if (Array.isArray(ids) && ids.length) people = people.filter((p) => ids.map(Number).includes(p.id));
  if (!people.length) throw new HttpError(400, 'There are no active room attendants. Add staff accounts with the Housekeeping role first.');
  const { rows: tasks } = await db.query(`SELECT t.*, rm.number, rm.floor FROM hk_tasks t JOIN rooms rm ON rm.id=t.room_id WHERE t.business_date=$1 ORDER BY (t.priority='high') DESC, rm.floor NULLS LAST, rm.number`, [bd]);
  const load = new Map(people.map((p) => [p.id, 0]));
  const floorsOf = new Map(people.map((p) => [p.id, new Set()]));
  for (const t of tasks) if (t.assigned_to && load.has(t.assigned_to)) { load.set(t.assigned_to, load.get(t.assigned_to) + KIND_CREDITS[t.kind]); floorsOf.get(t.assigned_to).add(t.floor); }
  let n = 0;
  for (const t of tasks.filter((x) => !x.assigned_to && x.status === 'pending')) {
    // least loaded; on a tie, someone already on that floor
    const pick = [...load.entries()].sort((a, b) => a[1] - b[1] || Number(floorsOf.get(b[0]).has(t.floor)) - Number(floorsOf.get(a[0]).has(t.floor)))[0][0];
    await db.query('UPDATE hk_tasks SET assigned_to=$2 WHERE id=$1', [t.id, pick]);
    load.set(pick, load.get(pick) + KIND_CREDITS[t.kind]); floorsOf.get(pick).add(t.floor); n++;
  }
  await audit(db, user, 'housekeeping.assign', 'hk_tasks', null, { date: bd, assigned: n });
  return { assigned: n };
}

export async function assignTask(db, user, id, userId) {
  if (userId) {
    const { rows: [u] } = await db.query("SELECT 1 FROM users WHERE id=$1 AND active", [Number(userId)]);
    if (!u) throw new HttpError(400, 'Choose an active staff member.');
  }
  const { rowCount } = await db.query("UPDATE hk_tasks SET assigned_to=$2 WHERE id=$1 AND status IN ('pending','in_progress','skipped')", [id, userId ? Number(userId) : null]);
  if (!rowCount) throw new HttpError(409, 'This room is finished or no longer on the list.');
  return { ok: true };
}

const supervises = (user) => can(user, 'housekeeping.supervise');
/** An attendant's action on a room. Attendants act on their own rooms; supervisors on any. */
export async function act(db, user, id, action, b = {}) {
  const { rows: [t] } = await db.query('SELECT t.*, rm.number, rm.hk_status FROM hk_tasks t JOIN rooms rm ON rm.id=t.room_id WHERE t.id=$1 FOR UPDATE OF t', [id]);
  if (!t) throw new HttpError(404, 'Task not found.');
  const s = await getSettings(db);
  if (ymd(t.business_date) !== ymd(s.business_date)) throw new HttpError(409, 'This list is from an earlier day.');
  const mine = t.assigned_to === user.id;
  if (!mine && !supervises(user)) throw new HttpError(403, `Room ${t.number} is on someone else's list.`);
  const note = String(b.notes || '').trim().slice(0, 300) || null;
  switch (action) {
    case 'start':
      if (!['pending', 'skipped'].includes(t.status)) throw new HttpError(409, 'Already started.');
      await db.query("UPDATE hk_tasks SET status='in_progress', started_at=now(), assigned_to=COALESCE(assigned_to,$2), skip_reason=NULL WHERE id=$1", [id, user.id]);
      break;
    case 'done':
      if (!['pending', 'in_progress', 'skipped'].includes(t.status)) throw new HttpError(409, 'Already finished.');
      if (t.hk_status === 'out_of_order') throw new HttpError(409, `Room ${t.number} is out of order.`);
      await db.query("UPDATE hk_tasks SET status='done', done_at=now(), done_by=$2, started_at=COALESCE(started_at, now()), notes=COALESCE($3, notes), skip_reason=NULL WHERE id=$1", [id, user.id, note]);
      if (t.hk_status !== 'clean') await setHousekeeping(db, user, t.room_id, 'clean');
      break;
    case 'skip': {
      const why = ['dnd', 'declined', 'no_access', 'later'].includes(b.reason) ? b.reason : null;
      if (!why) throw new HttpError(400, 'Say why the room was not done.');
      if (!['pending', 'in_progress'].includes(t.status)) throw new HttpError(409, 'Already finished.');
      await db.query("UPDATE hk_tasks SET status='skipped', skip_reason=$2, notes=COALESCE($3, notes) WHERE id=$1", [id, why, note]);
      break;
    }
    case 'inspect':
      if (!supervises(user)) throw new HttpError(403, 'Only a supervisor inspects rooms.');
      if (t.status !== 'done') throw new HttpError(409, 'Only finished rooms can be inspected.');
      await db.query("UPDATE hk_tasks SET status='inspected', inspected_at=now(), inspected_by=$2, notes=COALESCE($3, notes) WHERE id=$1", [id, user.id, note]);
      break;
    case 'redo':
      if (!supervises(user)) throw new HttpError(403, 'Only a supervisor sends a room back.');
      if (!['done', 'inspected'].includes(t.status)) throw new HttpError(409, 'The room is not finished yet.');
      if (!note) throw new HttpError(400, 'Say what needs doing again.');
      await db.query("UPDATE hk_tasks SET status='pending', started_at=NULL, done_at=NULL, done_by=NULL, inspected_at=NULL, inspected_by=NULL, notes=$2 WHERE id=$1", [id, note]);
      if (t.hk_status === 'clean') await setHousekeeping(db, user, t.room_id, 'dirty');
      break;
    default: throw new HttpError(400, 'Unknown action.');
  }
  await audit(db, user, `housekeeping.${action}`, 'room', t.room_id, { number: t.number, task: id, reason: b.reason });
  return { ok: true };
}

/** Today's board: every task with its room, guest and attendant, and each attendant's progress. */
export async function board(db, { userId = null } = {}) {
  const s = await getSettings(db), bd = ymd(s.business_date);
  const { rows } = await db.query(`SELECT t.id, t.kind, t.priority, t.status, t.assigned_to, t.skip_reason, t.notes, t.started_at, t.done_at, t.inspected_at,
      rm.id AS room_id, rm.number, rm.floor, rm.hk_status, rt.name AS room_type, u.full_name AS assigned_name, du.full_name AS done_by_name, iu.full_name AS inspected_by_name,
      r.id AS reservation_id, g.first_name || ' ' || g.last_name AS guest, to_char(r.departure,'YYYY-MM-DD') AS departure, g.vip, g.room_prefs, g.allergies,
      (SELECT g2.first_name || ' ' || g2.last_name FROM reservations r2 JOIN guests g2 ON g2.id=r2.guest_id WHERE r2.room_id=rm.id AND r2.status='reserved' AND r2.arrival=$1 LIMIT 1) AS arriving
    FROM hk_tasks t JOIN rooms rm ON rm.id=t.room_id JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN users du ON du.id=t.done_by LEFT JOIN users iu ON iu.id=t.inspected_by
    LEFT JOIN reservations r ON r.room_id=rm.id AND r.status='in_house' LEFT JOIN guests g ON g.id=r.guest_id
    WHERE t.business_date=$1 ${userId ? 'AND t.assigned_to=$2' : ''}
    ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'skipped' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, (t.priority='high') DESC, rm.floor NULLS LAST, rm.number`,
  userId ? [bd, userId] : [bd]);
  const people = await attendants(db);
  const stats = people.map((p) => {
    const mine = rows.filter((t) => t.assigned_to === p.id);
    return { id: p.id, name: p.full_name, total: mine.length, finished: mine.filter((t) => ['done', 'inspected'].includes(t.status)).length, credits: mine.reduce((a, t) => a + KIND_CREDITS[t.kind], 0) };
  });
  const count = (st) => rows.filter((t) => st.includes(t.status)).length;
  return { business_date: bd, tasks: rows, attendants: stats, totals: { total: rows.length, pending: count(['pending']), in_progress: count(['in_progress']), done: count(['done']), inspected: count(['inspected']), skipped: count(['skipped']), unassigned: rows.filter((t) => !t.assigned_to).length } };
}
