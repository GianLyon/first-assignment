// Spa and health club.
//  Spa: therapists and treatment rooms; treatments are amenity bookings with a therapist, a room and an end time,
//       never double-booked (see bookAmenity), moving booked → arrived → in treatment → completed (paid or on the room).
//  Health club: membership plans, members, renewals (paid or charged to a room) and check-ins at the door, which
//       refuse an expired or frozen membership.
import { HttpError, audit } from '../auth.js';
import { postJournal, saleLines } from '../ledger.js';
import { getSettings, insertCharge } from './frontoffice.js';

const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
const addMonths = (d, m) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + m); return t.toISOString().slice(0, 10); };
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const METHODS = ['cash', 'card', 'mobile_money', 'bank_transfer', 'room'];

/* ---------------- set-up: therapists, treatment rooms, plans ---------------- */
export async function saveSimple(db, user, table, id, b) {
  const defs = {
    spa_therapists: { cols: ['name', 'skills'], vals: [text(b.name, 'Name', { required: true, max: 80 }), text(b.skills, 'Skills', { max: 200 })] },
    spa_rooms: { cols: ['name', 'beds'], vals: [text(b.name, 'Name', { required: true, max: 60 }), Math.max(1, Math.min(10, Number(b.beds) || 1))] },
    club_plans: { cols: ['name', 'months', 'price', 'includes'], vals: [text(b.name, 'Name', { required: true, max: 80 }), Number(b.months), Number(b.price), text(b.includes, 'Includes', { max: 300 })] },
  }[table];
  if (!defs) throw new HttpError(400, 'Unknown list.');
  if (table === 'club_plans') {
    if (!(Number.isInteger(defs.vals[1]) && defs.vals[1] >= 1 && defs.vals[1] <= 36)) throw new HttpError(400, 'Months must be 1–36.');
    if (!(Number.isInteger(defs.vals[2]) && defs.vals[2] >= 0)) throw new HttpError(400, 'Price must be a whole number of shillings.');
  }
  let row;
  if (id) {
    const sets = defs.cols.map((c, i) => `${c}=$${i + 2}`).join(', ');
    ({ rows: [row] } = await db.query(`UPDATE ${table} SET ${sets}, active=$${defs.cols.length + 2} WHERE id=$1 RETURNING *`, [id, ...defs.vals, b.active !== false]));
    if (!row) throw new HttpError(404, 'Not found.');
  } else {
    ({ rows: [row] } = await db.query(`INSERT INTO ${table} (${defs.cols.join(', ')}) VALUES (${defs.cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, defs.vals));
  }
  await audit(db, user, `${table}.${id ? 'update' : 'create'}`, table, row.id, { name: row.name });
  return row;
}

/** The spa's day: therapists, rooms and every treatment booked. */
export async function spaDay(db, date) {
  const s = await getSettings(db);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : s.business_date;
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  return {
    date: d,
    therapists: await q('SELECT * FROM spa_therapists ORDER BY active DESC, name'),
    rooms: await q('SELECT * FROM spa_rooms ORDER BY active DESC, name'),
    treatments: await q("SELECT id, name, price, duration_min FROM amenities WHERE active AND category='spa' ORDER BY name"),
    bookings: await q(`SELECT ab.id, ab.code, ab.status, ab.guest_name, ab.phone, ab.notes, ab.therapist_id, ab.spa_room_id, ab.settled_by, ab.reservation_id,
        to_char(ab.start_time,'HH24:MI') AS start, to_char(ab.end_time,'HH24:MI') AS "end", a.name AS treatment, ab.unit_price*ab.qty AS amount, rm.number AS room_number
      FROM amenity_bookings ab JOIN amenities a ON a.id=ab.amenity_id LEFT JOIN reservations r ON r.id=ab.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id
      WHERE ab.service_date=$1 AND (a.category='spa' OR ab.therapist_id IS NOT NULL) ORDER BY ab.start_time NULLS LAST, ab.id`, [d]),
  };
}

/* ---------------- health club ---------------- */
export async function listMembers(db, { q = '', filter = 'current' } = {}) {
  const s = await getSettings(db);
  const today = s.business_date;
  const { rows } = await db.query(
    `SELECT m.*, to_char(m.starts_on,'YYYY-MM-DD') AS starts_on, to_char(m.ends_on,'YYYY-MM-DD') AS ends_on, p.name AS plan_name,
            (SELECT max(visited_at) FROM club_visits v WHERE v.member_id=m.id) AS last_visit,
            (SELECT count(*)::int FROM club_visits v WHERE v.member_id=m.id AND v.visited_at > now() - interval '30 days') AS visits_30d
     FROM club_members m LEFT JOIN club_plans p ON p.id=m.plan_id
     WHERE ($1 = '' OR (m.first_name || ' ' || m.last_name) ILIKE '%' || $1 || '%' OR m.code ILIKE $1 || '%' OR regexp_replace(COALESCE(m.phone,''),'\\D','','g') LIKE '%' || regexp_replace($1,'\\D','','g') || '%' AND length(regexp_replace($1,'\\D','','g')) >= 4)
     ORDER BY m.last_name, m.first_name LIMIT 300`, [String(q).trim().slice(0, 60)]);
  const state = (m) => (m.status !== 'active' ? m.status : !m.ends_on ? 'no_plan' : m.ends_on < today ? 'expired' : m.ends_on <= addDays(today, 7) ? 'expiring' : 'active');
  const list = rows.map((m) => ({ ...m, state: state(m) }));
  const filtered = filter === 'all' ? list : filter === 'expired' ? list.filter((m) => ['expired', 'no_plan'].includes(m.state)) : filter === 'expiring' ? list.filter((m) => m.state === 'expiring') : list.filter((m) => ['active', 'expiring'].includes(m.state));
  const { rows: [v] } = await db.query("SELECT count(*)::int AS n FROM club_visits WHERE business_date=$1", [today]);
  return { today, members: filtered, counts: { active: list.filter((m) => m.state === 'active').length, expiring: list.filter((m) => m.state === 'expiring').length, expired: list.filter((m) => m.state === 'expired').length }, visits_today: v.n,
    plans: (await db.query('SELECT * FROM club_plans ORDER BY active DESC, months')).rows };
}

export async function saveMember(db, user, id, b) {
  const email = text(b.email, 'Email', { max: 120 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address is not valid.');
  const vals = [text(b.first_name, 'First name', { required: true, max: 60 }), text(b.last_name, 'Last name', { required: true, max: 60 }), text(b.phone, 'Phone', { max: 40 }), email,
    b.guest_id ? Number(b.guest_id) : null, text(b.emergency_contact, 'Emergency contact', { max: 120 }), text(b.health_notes, 'Health notes', { max: 500 }), text(b.notes, 'Notes', { max: 500 })];
  let m;
  if (id) ({ rows: [m] } = await db.query('UPDATE club_members SET first_name=$2, last_name=$3, phone=$4, email=$5, guest_id=$6, emergency_contact=$7, health_notes=$8, notes=$9 WHERE id=$1 RETURNING *', [id, ...vals]));
  else ({ rows: [m] } = await db.query('INSERT INTO club_members (first_name, last_name, phone, email, guest_id, emergency_contact, health_notes, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [...vals, user.id]));
  if (!m) throw new HttpError(404, 'Member not found.');
  await audit(db, user, id ? 'club.member_update' : 'club.member_create', 'club_member', m.id, { code: m.code });
  return m;
}

/** Sell or renew a membership: the new period starts the day after the current one ends (or today). */
export async function renewMember(db, user, memberId, b) {
  const { rows: [m] } = await db.query('SELECT * FROM club_members WHERE id=$1 FOR UPDATE', [memberId]);
  if (!m) throw new HttpError(404, 'Member not found.');
  if (m.status === 'cancelled') throw new HttpError(409, 'This membership was cancelled. Reactivate it first.');
  const { rows: [p] } = await db.query('SELECT * FROM club_plans WHERE id=$1 AND active', [Number(b.plan_id)]);
  if (!p) throw new HttpError(400, 'Choose a plan.');
  const method = String(b.method || '');
  if (!METHODS.includes(method)) throw new HttpError(400, 'Choose how it is paid.');
  const s = await getSettings(db);
  const today = s.business_date;
  const curEnd = m.ends_on ? new Date(m.ends_on).toISOString().slice(0, 10) : null;
  const from = curEnd && curEnd >= today ? addDays(curEnd, 1) : today;
  const to = addDays(addMonths(from, p.months), -1);
  const desc = `Health club: ${p.name} for ${m.first_name} ${m.last_name} (${m.code}), ${from} to ${to}`;
  let chargeId = null, entry = null;
  if (p.price > 0) {
    if (method === 'room') {
      const { rows: [r] } = await db.query("SELECT * FROM reservations WHERE id=$1 AND status='in_house' FOR UPDATE", [Number(b.reservation_id)]);
      if (!r) throw new HttpError(400, 'Choose the in-house guest whose room is charged.');
      chargeId = (await insertCharge(db, user, r, s, { department: 'amenities', amount: p.price, description: desc.slice(0, 200) })).id;
    } else {
      entry = await postJournal(db, { date: today, description: desc.slice(0, 200), refType: 'club', refId: m.id, userId: user.id, lines: saleLines('amenities', [{ method, amount: p.price }], s.vat_rate) });
    }
  }
  await db.query(`INSERT INTO club_payments (member_id, plan_id, period_from, period_to, amount, method, reference, business_date, folio_charge_id, journal_entry_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [m.id, p.id, from, to, p.price, method, text(b.reference, 'Reference', { max: 80 }), today, chargeId, entry, user.id]);
  await db.query("UPDATE club_members SET plan_id=$2, starts_on=COALESCE(starts_on,$3), ends_on=$4, status='active' WHERE id=$1", [m.id, p.id, from, to]);
  await audit(db, user, 'club.renew', 'club_member', m.id, { plan: p.name, from, to, amount: p.price, method });
  return { from, to, amount: p.price };
}

export async function setMemberStatus(db, user, memberId, status) {
  if (!['active', 'frozen', 'cancelled'].includes(status)) throw new HttpError(400, 'Unknown status.');
  const { rows: [m] } = await db.query('UPDATE club_members SET status=$2 WHERE id=$1 RETURNING code', [memberId, status]);
  if (!m) throw new HttpError(404, 'Member not found.');
  await audit(db, user, 'club.status', 'club_member', memberId, { status });
  return { ok: true };
}

/** At the door: a member (by code, phone or id), an in-house hotel guest, or a day pass. */
export async function checkIn(db, user, b) {
  const s = await getSettings(db);
  if (b.kind === 'hotel_guest') {
    const { rows: [r] } = await db.query("SELECT r.id, g.first_name || ' ' || g.last_name AS name, rm.number FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.id=$1 AND r.status='in_house'", [Number(b.reservation_id)]);
    if (!r) throw new HttpError(400, 'Only in-house guests use the club on their stay.');
    await db.query("INSERT INTO club_visits (reservation_id, guest_name, kind, business_date, recorded_by) VALUES ($1,$2,'hotel_guest',$3,$4)", [r.id, r.name, s.business_date, user.id]);
    return { ok: true, name: r.name, kind: 'hotel_guest', room: r.number };
  }
  if (b.kind === 'day_pass') {
    const name = text(b.guest_name, 'Name', { required: true, max: 80 });
    await db.query("INSERT INTO club_visits (guest_name, kind, business_date, recorded_by) VALUES ($1,'day_pass',$2,$3)", [name, s.business_date, user.id]);
    return { ok: true, name, kind: 'day_pass', note: 'Sell the day pass at the club POS.' };
  }
  const key = String(b.member || b.member_id || '').trim();
  const { rows: [m] } = await db.query(`SELECT m.*, to_char(m.ends_on,'YYYY-MM-DD') AS ends FROM club_members m WHERE m.id::text=$1 OR upper(m.code)=upper($1)
      OR (length(regexp_replace($1,'\\D','','g')) >= 7 AND regexp_replace(COALESCE(m.phone,''),'\\D','','g') LIKE '%' || right(regexp_replace($1,'\\D','','g'), 9)) LIMIT 2`, [key]);
  if (!m) throw new HttpError(404, 'No member found with that number, code or phone.');
  const name = `${m.first_name} ${m.last_name}`;
  if (m.status === 'frozen') throw new HttpError(409, `${name}'s membership is frozen.`);
  if (m.status === 'cancelled') throw new HttpError(409, `${name}'s membership was cancelled.`);
  if (!m.ends || m.ends < s.business_date) throw new HttpError(409, `${name}'s membership ${m.ends ? `ended on ${m.ends}` : 'has not been paid'}. Renew it first.`);
  const { rows: [dup] } = await db.query("SELECT 1 FROM club_visits WHERE member_id=$1 AND visited_at > now() - interval '2 hours'", [m.id]);
  if (!dup) await db.query("INSERT INTO club_visits (member_id, guest_name, kind, business_date, recorded_by) VALUES ($1,$2,'member',$3,$4)", [m.id, name, s.business_date, user.id]);
  const left = Math.round((Date.parse(m.ends) - Date.parse(s.business_date)) / 864e5);
  return { ok: true, name, code: m.code, kind: 'member', ends_on: m.ends, days_left: left, health_notes: m.health_notes, already: !!dup };
}

export async function visitsToday(db) {
  const s = await getSettings(db);
  const { rows } = await db.query(`SELECT v.*, m.code, u.full_name AS recorded_by_name FROM club_visits v LEFT JOIN club_members m ON m.id=v.member_id LEFT JOIN users u ON u.id=v.recorded_by
    WHERE v.business_date=$1 ORDER BY v.visited_at DESC LIMIT 200`, [s.business_date]);
  return rows;
}
