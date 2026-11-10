// Phase 2: Restaurant / POS business rules.
import { HttpError, audit, can } from '../auth.js';
import { postJournal, saleLines } from '../ledger.js';
import { getSettings, insertCharge } from './frontoffice.js';

const POS_METHODS = ['cash', 'card', 'mobile_money', 'room'];
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
const wholeNonNeg = (v, field) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a whole number of shillings.`); return n; };

/* ---------------- shifts ---------------- */
export async function myShift(db, userId) {
  const { rows } = await db.query(
    `SELECT s.*, o.name AS outlet_name FROM pos_shifts s JOIN outlets o ON o.id=s.outlet_id WHERE s.user_id=$1 AND s.closed_at IS NULL`, [userId]);
  return rows[0] || null;
}
async function requireShift(db, user) {
  const s = await myShift(db, user.id);
  if (!s) throw new HttpError(409, 'Open a shift before taking orders or payments.');
  return s;
}

export async function openShift(db, user, { outlet_id, opening_float = 0 }) {
  if (await myShift(db, user.id)) throw new HttpError(409, 'You already have an open shift.');
  const { rows: [o] } = await db.query('SELECT * FROM outlets WHERE id=$1 AND active', [Number(outlet_id)]);
  if (!o) throw new HttpError(400, 'Choose an outlet.');
  const s = await getSettings(db);
  const { rows: [sh] } = await db.query('INSERT INTO pos_shifts (user_id, outlet_id, business_date, opening_float) VALUES ($1,$2,$3,$4) RETURNING *',
    [user.id, o.id, s.business_date, wholeNonNeg(opening_float, 'Opening float')]);
  await audit(db, user, 'pos.shift_open', 'pos_shift', sh.id, { outlet: o.name, opening_float: sh.opening_float });
  return sh;
}

async function shiftCash(db, shiftId) {
  const { rows: [r] } = await db.query("SELECT COALESCE(SUM(amount),0) AS cash FROM pos_payments WHERE shift_id=$1 AND method='cash'", [shiftId]);
  return Number(r.cash);
}
export async function shiftSummary(db, shiftId) {
  const { rows: [sh] } = await db.query('SELECT s.*, o.name AS outlet_name, u.full_name FROM pos_shifts s JOIN outlets o ON o.id=s.outlet_id JOIN users u ON u.id=s.user_id WHERE s.id=$1', [shiftId]);
  if (!sh) throw new HttpError(404, 'Shift not found.');
  const { rows: byMethod } = await db.query('SELECT method, SUM(amount)::bigint AS amount, count(*)::int AS n FROM pos_payments WHERE shift_id=$1 GROUP BY method', [shiftId]);
  const takings = Object.fromEntries(POS_METHODS.map((m) => [m, Number(byMethod.find((x) => x.method === m)?.amount || 0)]));
  const expected = sh.closed_at ? sh.expected_cash : sh.opening_float + takings.cash;
  return { ...sh, takings, expected_cash: expected, variance: sh.closed_at ? sh.counted_cash - sh.expected_cash : null };
}

export async function closeShift(db, user, { counted_cash, notes }) {
  const sh = await requireShift(db, user);
  const { rows: open } = await db.query("SELECT code FROM pos_checks WHERE shift_id=$1 AND status='open'", [sh.id]);
  if (open.length) throw new HttpError(409, `You still have open bills (${open.map((c) => c.code).join(', ')}). Settle them or hand them over first.`);
  const counted = wholeNonNeg(counted_cash, 'Counted cash');
  const expected = sh.opening_float + await shiftCash(db, sh.id);
  await db.query('UPDATE pos_shifts SET closed_at=now(), expected_cash=$2, counted_cash=$3, notes=$4 WHERE id=$1', [sh.id, expected, counted, text(notes, 'Notes', { max: 500 })]);
  await audit(db, user, 'pos.shift_close', 'pos_shift', sh.id, { expected, counted, variance: counted - expected });
  return shiftSummary(db, sh.id);
}

/* ---------------- checks (bills) ---------------- */
async function getCheckForUpdate(db, id) {
  const { rows: [c] } = await db.query('SELECT * FROM pos_checks WHERE id=$1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Bill not found.');
  return c;
}
const requireOpen = (c) => { if (c.status !== 'open') throw new HttpError(409, 'This bill is already closed.'); };

export async function openCheck(db, user, { outlet_id, table_id, covers = 1, reservation_id, notes }) {
  const shift = await requireShift(db, user);
  const s = await getSettings(db);
  const { rows: [o] } = await db.query('SELECT * FROM outlets WHERE id=$1 AND active', [Number(outlet_id || shift.outlet_id)]);
  if (!o) throw new HttpError(400, 'Choose an outlet.');
  let tableId = null, resId = null;
  if (table_id) {
    const { rows: [t] } = await db.query('SELECT * FROM dining_tables WHERE id=$1 AND outlet_id=$2 AND active', [Number(table_id), o.id]);
    if (!t) throw new HttpError(400, 'That table is not in this outlet.');
    tableId = t.id;
  }
  if (reservation_id) {
    const { rows: [r] } = await db.query("SELECT id FROM reservations WHERE id=$1 AND status='in_house'", [Number(reservation_id)]);
    if (!r) throw new HttpError(400, 'Room service is only for in-house guests.');
    resId = r.id;
  }
  const { rows: [c] } = await db.query(
    'INSERT INTO pos_checks (outlet_id, table_id, reservation_id, covers, business_date, shift_id, opened_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [o.id, tableId, resId, Math.max(1, Number(covers) || 1), s.business_date, shift.id, user.id, text(notes, 'Notes', { max: 300 })]);
  await audit(db, user, 'pos.check_open', 'pos_check', c.id, { code: c.code, outlet: o.name, table_id: tableId, reservation_id: resId });
  return c;
}

export async function getCheck(db, id) {
  const { rows: [c] } = await db.query(
    `SELECT c.*, o.name AS outlet_name, t.name AS table_name, rm.number AS room_number, g.first_name, g.last_name, u.full_name AS opened_by_name
     FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id LEFT JOIN dining_tables t ON t.id=c.table_id
     LEFT JOIN reservations r ON r.id=c.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN guests g ON g.id=r.guest_id
     LEFT JOIN users u ON u.id=c.opened_by WHERE c.id=$1`, [id]);
  if (!c) throw new HttpError(404, 'Bill not found.');
  const lines = (await db.query('SELECT * FROM pos_check_lines WHERE check_id=$1 ORDER BY id', [id])).rows;
  const payments = (await db.query(
    `SELECT p.*, rm.number AS room_number FROM pos_payments p LEFT JOIN reservations r ON r.id=p.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE check_id=$1 ORDER BY p.id`, [id])).rows;
  const total = lines.filter((l) => l.status !== 'voided').reduce((a, l) => a + l.unit_price * l.qty, 0);
  return { check: c, lines, payments, total, paid: payments.reduce((a, p) => a + p.amount, 0) };
}
async function checkTotal(db, id) {
  const { rows: [r] } = await db.query("SELECT COALESCE(SUM(unit_price*qty),0) AS t FROM pos_check_lines WHERE check_id=$1 AND status <> 'voided'", [id]);
  return Number(r.t);
}

export async function addLine(db, user, checkId, { item_id, qty = 1, note }) {
  await requireShift(db, user);
  const c = await getCheckForUpdate(db, checkId); requireOpen(c);
  const q = Number(qty);
  if (!Number.isInteger(q) || q < 1 || q > 999) throw new HttpError(400, 'Quantity must be between 1 and 999.');
  const { rows: [item] } = await db.query(
    'SELECT i.*, c.station FROM menu_items i JOIN menu_categories c ON c.id=i.category_id WHERE i.id=$1 AND i.active AND c.active', [Number(item_id)]);
  if (!item) throw new HttpError(400, 'That item is not on the menu.');
  const n = text(note, 'Note', { max: 200 });
  // Merge with an identical unsent line so the bill stays tidy
  const { rows: [same] } = await db.query("SELECT id FROM pos_check_lines WHERE check_id=$1 AND item_id=$2 AND status='pending' AND note IS NOT DISTINCT FROM $3", [c.id, item.id, n]);
  if (same) { await db.query('UPDATE pos_check_lines SET qty = qty + $2 WHERE id=$1', [same.id, q]); return { id: same.id }; }
  const { rows: [l] } = await db.query(
    'INSERT INTO pos_check_lines (check_id, item_id, name, unit_price, qty, note, station, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [c.id, item.id, item.name, item.price, q, n, item.station, user.id]);
  return l;
}

/** Change qty of, or remove, a line. Unsent lines change freely; sent lines need pos.void and a reason. */
export async function changeLine(db, user, lineId, { qty, reason, note }) {
  const { rows: [l] } = await db.query('SELECT * FROM pos_check_lines WHERE id=$1 FOR UPDATE', [lineId]);
  if (!l) throw new HttpError(404, 'Line not found.');
  const c = await getCheckForUpdate(db, l.check_id); requireOpen(c);
  if (l.status === 'voided') throw new HttpError(409, 'This item is already void.');
  if (note !== undefined && qty === undefined) {
    if (l.status !== 'pending') throw new HttpError(409, 'Notes can only be changed before the item is sent.');
    await db.query('UPDATE pos_check_lines SET note=$2 WHERE id=$1', [l.id, text(note, 'Note', { max: 200 })]);
    return { ok: true };
  }
  const q = Number(qty);
  if (!Number.isInteger(q) || q < 0) throw new HttpError(400, 'Invalid quantity.');
  if (l.status === 'pending') {
    if (q === 0) await db.query('DELETE FROM pos_check_lines WHERE id=$1', [l.id]);
    else await db.query('UPDATE pos_check_lines SET qty=$2 WHERE id=$1', [l.id, q]);
    return { ok: true };
  }
  // already sent to the kitchen/bar
  if (!can(user, 'pos.void')) throw new HttpError(403, 'Only a manager can remove items that were already sent to the kitchen or bar.');
  if (q !== 0) throw new HttpError(400, 'Sent items can only be voided, not changed. Add a new line instead.');
  const why = text(reason, 'Void reason', { required: true, max: 300 });
  await db.query("UPDATE pos_check_lines SET status='voided', voided_by=$2, void_reason=$3 WHERE id=$1", [l.id, user.id, why]);
  await audit(db, user, 'pos.void_item', 'pos_check', c.id, { line_id: l.id, item: l.name, qty: l.qty, amount: l.unit_price * l.qty, reason: why });
  return { ok: true };
}

/** Send unsent items to the kitchen and/or bar as tickets. */
export async function sendCheck(db, user, checkId) {
  const c = await getCheckForUpdate(db, checkId); requireOpen(c);
  const { rows: pending } = await db.query("SELECT * FROM pos_check_lines WHERE check_id=$1 AND status='pending' FOR UPDATE", [c.id]);
  const tickets = [];
  for (const station of ['kitchen', 'bar']) {
    const lines = pending.filter((l) => l.station === station);
    if (!lines.length) continue;
    const { rows: [t] } = await db.query('INSERT INTO kitchen_tickets (check_id, station) VALUES ($1,$2) RETURNING id', [c.id, station]);
    await db.query("UPDATE pos_check_lines SET status='sent', ticket_id=$2 WHERE id = ANY($1::bigint[])", [lines.map((l) => l.id), t.id]);
    tickets.push({ id: t.id, station, items: lines.length });
  }
  if (tickets.length) await audit(db, user, 'pos.send', 'pos_check', c.id, { tickets });
  return { tickets };
}

/**
 * Settle a bill. payments: [{ method: cash|card|mobile_money|room, amount, reservation_id?, reference? }]
 * The amounts must add up to the bill total exactly (give change for cash outside the system).
 */
export async function settleCheck(db, user, checkId, { payments }) {
  const shift = await requireShift(db, user);
  const c = await getCheckForUpdate(db, checkId); requireOpen(c);
  await sendCheck(db, user, c.id); // anything not yet sent goes now
  const total = await checkTotal(db, c.id);
  if (total === 0) throw new HttpError(409, 'This bill has nothing to pay. Void it instead.');
  if (!Array.isArray(payments) || !payments.length || payments.length > 6) throw new HttpError(400, 'Add at least one payment.');
  const tenders = payments.map((p) => {
    const method = String(p.method || '');
    if (!POS_METHODS.includes(method)) throw new HttpError(400, 'Unknown payment method.');
    const amount = Number(p.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Each payment must be a whole number of shillings above zero.');
    return { method, amount, reservation_id: method === 'room' ? Number(p.reservation_id || c.reservation_id) : null, reference: text(p.reference, 'Reference', { max: 80 }) };
  });
  const sum = tenders.reduce((a, t) => a + t.amount, 0);
  if (sum !== total) throw new HttpError(400, `Payments add up to UGX ${sum.toLocaleString('en-US')} but the bill is UGX ${total.toLocaleString('en-US')}.`);

  const s = await getSettings(db);
  const { rows: [o] } = await db.query('SELECT name FROM outlets WHERE id=$1', [c.outlet_id]);
  const direct = tenders.filter((t) => t.method !== 'room');
  let entryId = null;
  if (direct.length) {
    entryId = await postJournal(db, { date: s.business_date, description: `${o.name} ${c.code}`, refType: 'pos_check', refId: c.id, userId: user.id, lines: saleLines('fnb', direct, s.vat_rate) });
  }
  for (const t of tenders) {
    let folioChargeId = null, journalId = entryId;
    if (t.method === 'room') {
      const { rows: [r] } = await db.query("SELECT * FROM reservations WHERE id=$1 FOR UPDATE", [t.reservation_id]);
      if (!r || r.status !== 'in_house') throw new HttpError(400, 'Charge to room is only possible for an in-house guest.');
      const charge = await insertCharge(db, user, r, s, { department: 'fnb', amount: t.amount, description: `${o.name} bill ${c.code}` });
      folioChargeId = charge.id; journalId = charge.journal_entry_id;
    }
    await db.query(
      `INSERT INTO pos_payments (check_id, method, amount, reservation_id, folio_charge_id, reference, business_date, shift_id, posted_by, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.id, t.method, t.amount, t.reservation_id, folioChargeId, t.reference, s.business_date, shift.id, user.id, journalId]);
  }
  await db.query("UPDATE pos_checks SET status='settled', settled_by=$2, settled_at=now(), business_date=$3 WHERE id=$1", [c.id, user.id, s.business_date]);
  await audit(db, user, 'pos.settle', 'pos_check', c.id, { code: c.code, total, payments: tenders.map((t) => ({ method: t.method, amount: t.amount })) });
  return getCheck(db, c.id);
}

export async function voidCheck(db, user, checkId, reason) {
  const c = await getCheckForUpdate(db, checkId); requireOpen(c);
  const why = text(reason, 'Void reason', { required: true, max: 300 });
  const { rows: sent } = await db.query("SELECT count(*)::int AS n FROM pos_check_lines WHERE check_id=$1 AND status='sent'", [c.id]);
  if (sent[0].n > 0 && !can(user, 'pos.void')) throw new HttpError(403, 'Only a manager can void a bill with items already sent to the kitchen or bar.');
  await db.query("UPDATE pos_check_lines SET status='voided', voided_by=$2, void_reason=$3 WHERE check_id=$1 AND status <> 'voided'", [c.id, user.id, why]);
  await db.query("UPDATE pos_checks SET status='voided', void_reason=$2, settled_by=$3, settled_at=now() WHERE id=$1", [c.id, why, user.id]);
  await audit(db, user, 'pos.void_check', 'pos_check', c.id, { code: c.code, reason: why });
}

export async function moveCheck(db, user, checkId, { table_id }) {
  const c = await getCheckForUpdate(db, checkId); requireOpen(c);
  const { rows: [t] } = await db.query('SELECT * FROM dining_tables WHERE id=$1 AND outlet_id=$2 AND active', [Number(table_id), c.outlet_id]);
  if (!t) throw new HttpError(400, 'Choose a table in the same outlet.');
  await db.query('UPDATE pos_checks SET table_id=$2 WHERE id=$1', [c.id, t.id]);
  await audit(db, user, 'pos.move_table', 'pos_check', c.id, { to: t.name });
}

/* ---------------- kitchen / bar display ---------------- */
export async function tickets(db, station) {
  const { rows } = await db.query(
    `SELECT k.*, c.code, o.name AS outlet_name, dt.name AS table_name, rm.number AS room_number,
            json_agg(json_build_object('name', l.name, 'qty', l.qty, 'note', l.note, 'voided', l.status = 'voided') ORDER BY l.id) AS items
     FROM kitchen_tickets k JOIN pos_checks c ON c.id=k.check_id JOIN outlets o ON o.id=c.outlet_id
     LEFT JOIN dining_tables dt ON dt.id=c.table_id LEFT JOIN reservations r ON r.id=c.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id
     JOIN pos_check_lines l ON l.ticket_id=k.id
     WHERE k.station=$1 AND (k.status <> 'served' OR k.served_at > now() - interval '30 minutes')
     GROUP BY k.id, c.code, o.name, dt.name, rm.number ORDER BY k.status = 'served', k.created_at`, [station]);
  return rows;
}
export async function setTicketStatus(db, user, ticketId, status) {
  if (!['ready', 'served'].includes(status)) throw new HttpError(400, 'Unknown status.');
  const { rows: [t] } = await db.query('SELECT * FROM kitchen_tickets WHERE id=$1 FOR UPDATE', [ticketId]);
  if (!t) throw new HttpError(404, 'Ticket not found.');
  await db.query(`UPDATE kitchen_tickets SET status=$2, ${status === 'ready' ? 'ready_at' : 'served_at'}=now() WHERE id=$1`, [t.id, status]);
}

/* ---------------- reports ---------------- */
export async function salesReport(db, date) {
  const q = async (sql) => (await db.query(sql, [date])).rows;
  const byOutlet = await q(`SELECT o.name AS outlet, count(*)::int AS bills, SUM(c.covers)::int AS covers,
      SUM((SELECT SUM(amount) FROM pos_payments p WHERE p.check_id=c.id))::bigint AS amount
    FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id WHERE c.status='settled' AND c.business_date=$1 GROUP BY o.name ORDER BY o.name`);
  const byMethod = await q(`SELECT method, SUM(amount)::bigint AS amount FROM pos_payments WHERE business_date=$1 GROUP BY method`);
  const items = await q(`SELECT l.name, SUM(l.qty)::int AS qty, SUM(l.qty*l.unit_price)::bigint AS amount FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id
    WHERE c.status='settled' AND c.business_date=$1 AND l.status <> 'voided' GROUP BY l.name ORDER BY amount DESC LIMIT 50`);
  const voids = await q(`SELECT c.code, l.name, l.qty, l.unit_price*l.qty AS amount, l.void_reason, u.full_name AS voided_by FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id
    LEFT JOIN users u ON u.id=l.voided_by WHERE l.status='voided' AND c.business_date=$1 ORDER BY l.id`);
  const shifts = await q(`SELECT s.id FROM pos_shifts s WHERE s.business_date=$1 ORDER BY s.id`);
  const shiftRows = [];
  for (const sh of shifts) shiftRows.push(await shiftSummary(db, sh.id));
  const num = (x) => x.map((r) => ({ ...r, amount: Number(r.amount) }));
  return {
    date, by_outlet: num(byOutlet), items: num(items), voids: num(voids), shifts: shiftRows,
    by_method: Object.fromEntries(POS_METHODS.map((m) => [m, Number(byMethod.find((x) => x.method === m)?.amount || 0)])),
    total: byMethod.reduce((a, x) => a + Number(x.amount), 0),
  };
}
