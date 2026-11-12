// Phase 6: HR & payroll — employees, rosters, attendance, leave, staff advances and payroll.
import { HttpError, audit, can } from '../auth.js';
import { postJournal } from '../ledger.js';
import { getSettings } from './frontoffice.js';

export const DEPARTMENTS = ['Front Office', 'Housekeeping', 'Kitchen', 'Restaurant', 'Bar', 'Maintenance', 'Security', 'Spa', 'Sales & Marketing', 'Finance', 'HR & Administration', 'Management'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysIncl = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
const money0 = (v, field) => { const n = Number(v || 0); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a whole number of shillings.`); return n; };
const A = { advances: '1250', paye: '2400', nssf: '2410', netPay: '2420', otherDed: '2430', wages: '6000', employerNssf: '6010' };

/* ---------------- Uganda statutory deductions ----------------
 * PAYE, resident individual, monthly chargeable income (Income Tax Act, 2nd Schedule):
 *   up to 235,000: nil; 235,001–335,000: 10% of the excess over 235,000;
 *   335,001–410,000: 10,000 + 20% of the excess over 335,000;
 *   above 410,000: 25,000 + 30% of the excess over 410,000, plus a further 10% on any excess over 10,000,000.
 * NSSF: 5% employee + 10% employer of gross pay.
 * Confirm current rates with URA / NSSF before relying on these figures. */
export function paye(gross) {
  const g = Math.max(0, Math.round(gross));
  let t = 0;
  if (g > 410000) t = 25000 + 0.3 * (g - 410000);
  else if (g > 335000) t = 10000 + 0.2 * (g - 335000);
  else if (g > 235000) t = 0.1 * (g - 235000);
  if (g > 10000000) t += 0.1 * (g - 10000000);
  return Math.round(t);
}
export const NSSF_EMPLOYEE = 0.05, NSSF_EMPLOYER = 0.10;
export const OVERTIME_HOURS_PER_MONTH = 208, OVERTIME_MULTIPLIER = 1.5;

/* ---------------- employees ---------------- */
export async function saveEmployee(db, user, id, b) {
  const dept = String(b.department || '');
  if (!DEPARTMENTS.includes(dept)) throw new HttpError(400, 'Choose a department.');
  if (!isDate(b.start_date)) throw new HttpError(400, 'Start date is required.');
  const basic = money0(b.basic_salary, 'Basic salary');
  const payMethod = ['bank', 'mobile_money', 'cash'].includes(b.pay_method) ? b.pay_method : 'bank';
  let userId = b.user_id ? Number(b.user_id) : null;
  if (userId) {
    const { rows: [u] } = await db.query('SELECT id FROM users WHERE id=$1', [userId]);
    if (!u) throw new HttpError(400, 'That sign-in account does not exist.');
    const { rows: [taken] } = await db.query('SELECT emp_no FROM employees WHERE user_id=$1 AND id IS DISTINCT FROM $2', [userId, id ?? null]);
    if (taken) throw new HttpError(409, `That sign-in is already linked to employee ${taken.emp_no}.`);
  }
  const vals = [
    text(b.first_name, 'First name', { required: true, max: 80 }), text(b.last_name, 'Last name', { required: true, max: 80 }),
    ['female', 'male'].includes(b.gender) ? b.gender : null, isDate(b.date_of_birth) ? b.date_of_birth : null,
    text(b.phone, 'Phone', { max: 40 }), text(b.email, 'Email', { max: 120 }), text(b.nin, 'NIN', { max: 20 }), text(b.tin, 'TIN', { max: 20 }), text(b.nssf_no, 'NSSF number', { max: 30 }),
    dept, text(b.job_title, 'Job title', { required: true, max: 80 }), ['permanent', 'contract', 'casual', 'intern'].includes(b.employment_type) ? b.employment_type : 'permanent',
    b.start_date, basic, money0(b.housing_allowance, 'Housing allowance'), money0(b.transport_allowance, 'Transport allowance'), money0(b.other_allowance, 'Other allowance'),
    payMethod, text(b.bank_name, 'Bank', { max: 60 }), text(b.bank_account, 'Account number', { max: 40 }), text(b.momo_number, 'Mobile money number', { max: 20 }),
    Math.min(60, Math.max(0, Number(b.annual_leave_days ?? 21) || 0)), userId, text(b.notes, 'Notes', { max: 1000 }),
  ];
  if (payMethod === 'bank' && !vals[19]) throw new HttpError(400, 'Enter the bank account number (or choose another payment method).');
  if (payMethod === 'mobile_money' && !vals[20]) throw new HttpError(400, 'Enter the mobile money number.');
  const cols = 'first_name, last_name, gender, date_of_birth, phone, email, nin, tin, nssf_no, department, job_title, employment_type, start_date, basic_salary, housing_allowance, transport_allowance, other_allowance, pay_method, bank_name, bank_account, momo_number, annual_leave_days, user_id, notes';
  let e;
  if (id) {
    const { rows: [old] } = await db.query('SELECT * FROM employees WHERE id=$1', [id]);
    if (!old) throw new HttpError(404, 'Employee not found.');
    ({ rows: [e] } = await db.query(`UPDATE employees SET (${cols}) = (${vals.map((_, i) => '$' + (i + 2)).join(',')}) WHERE id=$1 RETURNING *`, [id, ...vals]));
    const changed = ['basic_salary', 'housing_allowance', 'transport_allowance', 'other_allowance', 'department', 'job_title', 'bank_account', 'momo_number'].filter((k) => String(old[k] ?? '') !== String(e[k] ?? ''));
    await audit(db, user, 'hr.employee_update', 'employee', e.id, { emp_no: e.emp_no, changed, from_salary: old.basic_salary, to_salary: e.basic_salary });
  } else {
    ({ rows: [e] } = await db.query(`INSERT INTO employees (${cols}) VALUES (${vals.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals));
    await audit(db, user, 'hr.employee_create', 'employee', e.id, { emp_no: e.emp_no, name: `${e.first_name} ${e.last_name}` });
  }
  return e;
}
export async function endEmployment(db, user, id, { end_date, reason }) {
  const { rows: [e] } = await db.query('SELECT * FROM employees WHERE id=$1 FOR UPDATE', [id]);
  if (!e) throw new HttpError(404, 'Employee not found.');
  if (!isDate(end_date) || end_date < String(e.start_date).slice(0, 10)) throw new HttpError(400, 'Enter a leaving date on or after the start date.');
  const why = text(reason, 'Reason', { required: true, max: 300 });
  await db.query("UPDATE employees SET end_date=$2, status='left', leaving_reason=$3 WHERE id=$1", [id, end_date, why]);
  await db.query('DELETE FROM roster WHERE employee_id=$1 AND date > $2', [id, end_date]);
  if (e.user_id) await db.query('UPDATE users SET active=false WHERE id=$1', [e.user_id]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [e.user_id]);
  await audit(db, user, 'hr.employee_left', 'employee', id, { end_date, reason: why });
}
export async function myEmployee(db, user) {
  const { rows: [e] } = await db.query('SELECT * FROM employees WHERE user_id=$1', [user.id]);
  return e || null;
}

/* ---------------- leave ---------------- */
export async function leaveBalance(db, employeeId, year) {
  const { rows: [e] } = await db.query('SELECT annual_leave_days, start_date FROM employees WHERE id=$1', [employeeId]);
  if (!e) throw new HttpError(404, 'Employee not found.');
  const { rows } = await db.query(
    `SELECT l.status, SUM(l.days)::int AS days FROM leave_requests l JOIN leave_types t ON t.code=l.type
     WHERE l.employee_id=$1 AND t.uses_balance AND l.status IN ('approved','pending') AND extract(year FROM l.from_date) = $2 GROUP BY l.status`, [employeeId, year]);
  const taken = rows.find((r) => r.status === 'approved')?.days || 0, pending = rows.find((r) => r.status === 'pending')?.days || 0;
  return { year, entitlement: e.annual_leave_days, taken, pending, remaining: e.annual_leave_days - taken - pending };
}
export async function requestLeave(db, user, b, { self = false } = {}) {
  let empId = Number(b.employee_id);
  if (self) {
    const me = await myEmployee(db, user);
    if (!me) throw new HttpError(403, 'Your sign-in is not linked to an employee record. Ask HR to link it.');
    empId = me.id;
  }
  const { rows: [e] } = await db.query("SELECT * FROM employees WHERE id=$1 AND status='active'", [empId]);
  if (!e) throw new HttpError(400, 'Choose an active employee.');
  const { rows: [t] } = await db.query('SELECT * FROM leave_types WHERE code=$1', [String(b.type || '')]);
  if (!t) throw new HttpError(400, 'Choose a type of leave.');
  if (!isDate(b.from_date) || !isDate(b.to_date) || b.to_date < b.from_date) throw new HttpError(400, 'Choose valid leave dates.');
  const days = daysIncl(b.from_date, b.to_date);
  if (days > 120) throw new HttpError(400, 'Leave requests are limited to 120 days at a time.');
  const { rows: [clash] } = await db.query("SELECT id FROM leave_requests WHERE employee_id=$1 AND status IN ('pending','approved') AND from_date <= $3 AND to_date >= $2", [e.id, b.from_date, b.to_date]);
  if (clash) throw new HttpError(409, 'This overlaps leave that is already requested or approved.');
  if (t.uses_balance) {
    const bal = await leaveBalance(db, e.id, Number(b.from_date.slice(0, 4)));
    if (days > bal.remaining) throw new HttpError(409, `Not enough annual leave: ${bal.remaining} day(s) left this year.`);
  }
  const { rows: [l] } = await db.query('INSERT INTO leave_requests (employee_id, type, from_date, to_date, days, reason, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [e.id, t.code, b.from_date, b.to_date, days, text(b.reason, 'Reason', { max: 300 }), user.id]);
  await audit(db, user, 'hr.leave_request', 'employee', e.id, { type: t.code, from: b.from_date, to: b.to_date, days });
  return l;
}
export async function decideLeave(db, user, id, { decision, note }) {
  const { rows: [l] } = await db.query('SELECT l.*, e.user_id FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.id=$1 FOR UPDATE OF l', [id]);
  if (!l) throw new HttpError(404, 'Leave request not found.');
  if (l.status !== 'pending') throw new HttpError(409, 'This request has already been decided.');
  if (l.user_id === user.id && user.role !== 'admin') throw new HttpError(403, 'You cannot approve your own leave.');
  if (!['approved', 'rejected'].includes(decision)) throw new HttpError(400, 'Approve or reject.');
  const n = text(note, 'Note', { required: decision === 'rejected', max: 300 });
  await db.query('UPDATE leave_requests SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1', [id, decision, user.id, n]);
  await audit(db, user, `hr.leave_${decision}`, 'employee', l.employee_id, { request: id, days: l.days });
}
export async function cancelLeave(db, user, id) {
  const { rows: [l] } = await db.query('SELECT l.*, e.user_id FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.id=$1 FOR UPDATE OF l', [id]);
  if (!l) throw new HttpError(404, 'Leave request not found.');
  const s = await getSettings(db);
  const own = l.user_id === user.id;
  if (!(own && l.status === 'pending') && !(can(user, 'hr.manage') && ['pending', 'approved'].includes(l.status) && String(l.from_date).slice(0, 10) > s.business_date)) {
    throw new HttpError(403, own ? 'Approved leave can only be cancelled by HR.' : 'You cannot cancel this request.');
  }
  await db.query("UPDATE leave_requests SET status='cancelled' WHERE id=$1", [id]);
  await audit(db, user, 'hr.leave_cancel', 'employee', l.employee_id, { request: id });
}

/* ---------------- rosters ---------------- */
export async function rosterWeek(db, from, department) {
  const to = addDays(from, 6);
  const { rows: emps } = await db.query(
    `SELECT id, emp_no, first_name, last_name, department, job_title FROM employees
     WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1) AND ($3::text IS NULL OR department=$3) ORDER BY department, first_name`, [from, to, department || null]);
  const ids = emps.map((e) => e.id);
  const { rows: ros } = await db.query(`SELECT employee_id, to_char(date,'YYYY-MM-DD') AS date, shift_id FROM roster WHERE employee_id = ANY($1) AND date BETWEEN $2 AND $3`, [ids, from, to]);
  const { rows: lv } = await db.query(`SELECT employee_id, type, to_char(from_date,'YYYY-MM-DD') AS f, to_char(to_date,'YYYY-MM-DD') AS t FROM leave_requests WHERE employee_id = ANY($1) AND status='approved' AND from_date <= $3 AND to_date >= $2`, [ids, from, to]);
  const days = [...Array(7)].map((_, i) => addDays(from, i));
  return {
    from, to, days,
    employees: emps.map((e) => ({ ...e, days: days.map((d) => {
      const leave = lv.find((l) => l.employee_id === e.id && l.f <= d && d <= l.t);
      const r = ros.find((x) => x.employee_id === e.id && x.date === d);
      return { date: d, shift_id: r ? r.shift_id : undefined, leave: leave?.type || null };
    }) })),
  };
}
export async function saveRoster(db, user, entries) {
  if (!Array.isArray(entries) || entries.length > 2000) throw new HttpError(400, 'Nothing to save.');
  for (const x of entries) {
    if (!isDate(x.date)) throw new HttpError(400, 'Invalid date.');
    const emp = Number(x.employee_id);
    if (x.shift_id === undefined || x.shift_id === '') { await db.query('DELETE FROM roster WHERE employee_id=$1 AND date=$2', [emp, x.date]); continue; }
    await db.query('INSERT INTO roster (employee_id, date, shift_id) VALUES ($1,$2,$3) ON CONFLICT (employee_id, date) DO UPDATE SET shift_id=EXCLUDED.shift_id',
      [emp, x.date, x.shift_id === null || x.shift_id === 'off' ? null : Number(x.shift_id)]);
  }
  await audit(db, user, 'hr.roster_save', 'roster', null, { entries: entries.length });
  return { ok: true };
}
export async function copyRosterWeek(db, user, from, department) {
  const prev = addDays(from, -7);
  const { rowCount } = await db.query(
    `INSERT INTO roster (employee_id, date, shift_id)
     SELECT r.employee_id, r.date + 7, r.shift_id FROM roster r JOIN employees e ON e.id=r.employee_id
     WHERE r.date BETWEEN $1 AND $1::date + 6 AND ($2::text IS NULL OR e.department=$2) AND (e.end_date IS NULL OR e.end_date >= r.date + 7)
     ON CONFLICT (employee_id, date) DO NOTHING`, [prev, department || null]);
  await audit(db, user, 'hr.roster_copy', 'roster', null, { from, department, entries: rowCount });
  return { copied: rowCount };
}

/* ---------------- attendance ---------------- */
const TZ = 'Africa/Kampala';
export async function attendanceDay(db, date, department) {
  const { rows } = await db.query(
    `SELECT e.id, e.emp_no, e.first_name, e.last_name, e.department, e.job_title, r.shift_id, st.name AS shift_name, to_char(st.start_time,'HH24:MI') AS shift_start, to_char(st.end_time,'HH24:MI') AS shift_end,
            (r.employee_id IS NOT NULL) AS rostered, to_char(a.clock_in AT TIME ZONE $3,'HH24:MI') AS clock_in, to_char(a.clock_out AT TIME ZONE $3,'HH24:MI') AS clock_out,
            EXTRACT(EPOCH FROM (a.clock_out - a.clock_in))/3600 AS hours, a.source, a.note,
            (SELECT type FROM leave_requests l WHERE l.employee_id=e.id AND l.status='approved' AND $1 BETWEEN l.from_date AND l.to_date LIMIT 1) AS leave,
            (a.clock_in AT TIME ZONE $3) > ($1::date + st.start_time + interval '10 minutes') AS late
     FROM employees e LEFT JOIN roster r ON r.employee_id=e.id AND r.date=$1 LEFT JOIN shift_templates st ON st.id=r.shift_id
     LEFT JOIN attendance a ON a.employee_id=e.id AND a.date=$1
     WHERE e.start_date <= $1 AND (e.end_date IS NULL OR e.end_date >= $1) AND ($2::text IS NULL OR e.department=$2)
     ORDER BY e.department, e.first_name`, [date, department || null, TZ]);
  const s = await getSettings(db);
  return rows.map((r) => ({
    ...r, hours: r.hours == null ? null : Math.round(Number(r.hours) * 100) / 100,
    status: r.leave ? 'leave' : r.clock_in ? (r.late ? 'late' : 'present') : r.rostered && !r.shift_id ? 'off' : r.shift_id ? (date < s.business_date ? 'absent' : 'expected') : 'not rostered',
  }));
}
function stamp(date, hhmm) { return /^\d{2}:\d{2}$/.test(hhmm || '') ? `${date} ${hhmm}` : null; }
export async function recordAttendance(db, user, b) {
  if (!isDate(b.date)) throw new HttpError(400, 'Invalid date.');
  const inT = stamp(b.date, b.clock_in), outT = stamp(b.date, b.clock_out);
  if (!inT && !outT) throw new HttpError(400, 'Enter a sign-in or sign-out time.');
  // a sign-out earlier than the sign-in is on the next day (night shifts)
  const outNextDay = inT && outT && b.clock_out < b.clock_in;
  await db.query(
    `INSERT INTO attendance (employee_id, date, clock_in, clock_out, source, note, recorded_by)
     VALUES ($1, $2, ($3::timestamp AT TIME ZONE $7), ($4::timestamp AT TIME ZONE $7) + ($8 * interval '1 day'), 'manual', $5, $6)
     ON CONFLICT (employee_id, date) DO UPDATE SET clock_in=EXCLUDED.clock_in, clock_out=EXCLUDED.clock_out, source='manual', note=EXCLUDED.note, recorded_by=EXCLUDED.recorded_by`,
    [Number(b.employee_id), b.date, inT, outT, text(b.note, 'Note', { max: 200 }), user.id, TZ, outNextDay ? 1 : 0]);
  await audit(db, user, 'hr.attendance', 'employee', b.employee_id, { date: b.date, clock_in: b.clock_in, clock_out: b.clock_out });
  return { ok: true };
}
/** Staff sign themselves in or out (today's business date). */
export async function selfClock(db, user, action) {
  const me = await myEmployee(db, user);
  if (!me || me.status !== 'active') throw new HttpError(403, 'Your sign-in is not linked to an active employee record.');
  const s = await getSettings(db);
  const { rows: [a] } = await db.query('SELECT * FROM attendance WHERE employee_id=$1 AND date=$2 FOR UPDATE', [me.id, s.business_date]);
  if (action === 'in') {
    if (a?.clock_in) throw new HttpError(409, 'You have already signed in today.');
    await db.query(`INSERT INTO attendance (employee_id, date, clock_in, source, recorded_by) VALUES ($1,$2,now(),'self',$3) ON CONFLICT (employee_id, date) DO UPDATE SET clock_in=now()`, [me.id, s.business_date, user.id]);
  } else {
    if (!a?.clock_in) throw new HttpError(409, 'Sign in first.');
    if (a.clock_out) throw new HttpError(409, 'You have already signed out today.');
    await db.query('UPDATE attendance SET clock_out=now() WHERE id=$1', [a.id]);
  }
  return { ok: true };
}

/* ---------------- staff advances ---------------- */
export async function giveAdvance(db, user, b) {
  const { rows: [e] } = await db.query("SELECT * FROM employees WHERE id=$1 AND status='active'", [Number(b.employee_id)]);
  if (!e) throw new HttpError(400, 'Choose an active employee.');
  const amount = money0(b.amount, 'Amount'), rec = money0(b.monthly_recovery, 'Monthly recovery');
  if (!amount || !rec) throw new HttpError(400, 'Enter the amount and the monthly recovery.');
  if (rec > amount) throw new HttpError(400, 'The monthly recovery cannot be more than the advance.');
  const { rows: [acct] } = await db.query('SELECT * FROM accounts WHERE code=$1 AND is_cash AND active', [String(b.paid_from || '')]);
  if (!acct) throw new HttpError(400, 'Choose the cash, bank or mobile money account it is paid from.');
  const s = await getSettings(db);
  const { rows: [adv] } = await db.query('INSERT INTO staff_advances (employee_id, advance_date, amount, monthly_recovery, paid_from, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [e.id, s.business_date, amount, rec, acct.code, text(b.reason, 'Reason', { max: 200 }), user.id]);
  const entry = await postJournal(db, { date: s.business_date, description: `Staff advance: ${e.first_name} ${e.last_name}`, refType: 'staff_advance', refId: adv.id, userId: user.id, lines: [{ account: A.advances, debit: amount }, { account: acct.code, credit: amount }] });
  await db.query('UPDATE staff_advances SET journal_entry_id=$2 WHERE id=$1', [adv.id, entry]);
  await audit(db, user, 'hr.advance', 'employee', e.id, { amount, monthly_recovery: rec });
  return adv;
}

/* ---------------- payroll ---------------- */
const periodBounds = (period) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) throw new HttpError(400, 'Choose a month.');
  const first = period + '-01';
  const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
  return { first, last, days: daysIncl(first, last) };
};
async function computeLine(db, e, period, inputs = {}) {
  const { first, last, days } = periodBounds(period);
  const start = String(e.start_date).slice(0, 10), end = e.end_date ? String(e.end_date).slice(0, 10) : null;
  const from = start > first ? start : first, to = end && end < last ? end : last;
  if (to < from) return null; // not employed this month
  const worked = daysIncl(from, to);
  const { rows: [u] } = await db.query(
    `SELECT COALESCE(SUM(LEAST(to_date, $3::date) - GREATEST(from_date, $2::date) + 1),0)::int AS d FROM leave_requests l JOIN leave_types t ON t.code=l.type
     WHERE l.employee_id=$1 AND l.status='approved' AND NOT t.paid AND l.from_date <= $3 AND l.to_date >= $2`, [e.id, from, to]);
  const unpaid = Math.min(worked, u.d);
  const daily = e.basic_salary / days;
  const basic = Math.max(0, Math.round(daily * worked) - Math.round(daily * unpaid));
  const allowances = Math.round(((e.housing_allowance + e.transport_allowance + e.other_allowance) * worked) / days);
  const otHours = Math.max(0, Math.round(Number(inputs.overtime_hours || 0) * 100) / 100);
  if (otHours > 200) throw new HttpError(400, 'Overtime hours look too high (more than 200).');
  const overtime = Math.round((e.basic_salary / OVERTIME_HOURS_PER_MONTH) * OVERTIME_MULTIPLIER * otHours);
  const additions = money0(inputs.other_additions, 'Other additions'), otherDed = money0(inputs.other_deductions, 'Other deductions');
  const gross = basic + allowances + overtime + additions;
  const nssfEe = Math.round(gross * NSSF_EMPLOYEE), nssfEr = Math.round(gross * NSSF_EMPLOYER), tax = paye(gross);
  const available = gross - nssfEe - tax - otherDed;
  if (available < 0) throw new HttpError(400, `Deductions for ${e.first_name} ${e.last_name} are more than their pay.`);
  // advance recovery: oldest advances first, never more than what is left to pay
  const { rows: adv } = await db.query('SELECT amount - recovered AS left, monthly_recovery FROM staff_advances WHERE employee_id=$1 AND recovered < amount ORDER BY advance_date, id', [e.id]);
  let recovery = 0;
  for (const a of adv) recovery += Math.min(Number(a.left), Number(a.monthly_recovery));
  recovery = Math.min(recovery, available);
  return {
    employee_id: e.id, department: e.department, days_worked: worked, days_in_month: days, unpaid_days: unpaid, basic, allowances,
    overtime_hours: otHours, overtime, other_additions: additions, gross, nssf_employee: nssfEe, nssf_employer: nssfEr, paye: tax,
    advance_recovery: recovery, other_deductions: otherDed, net: available - recovery, note: text(inputs.note, 'Note', { max: 200 }),
  };
}
async function writeLine(db, runId, l) {
  const cols = Object.keys(l);
  await db.query(`INSERT INTO payroll_lines (run_id, ${cols.join(',')}) VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(',')})
    ON CONFLICT (run_id, employee_id) DO UPDATE SET ${cols.filter((c) => c !== 'employee_id').map((c) => `${c}=EXCLUDED.${c}`).join(', ')}`, [runId, ...cols.map((c) => l[c])]);
}
async function runForUpdate(db, id) {
  const { rows: [r] } = await db.query('SELECT * FROM payroll_runs WHERE id=$1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Payroll not found.');
  return r;
}
export async function createRun(db, user, period) {
  const { first, last } = periodBounds(period);
  const s = await getSettings(db);
  if (first > s.business_date) throw new HttpError(400, 'You cannot run payroll for a future month.');
  const { rows: [dup] } = await db.query("SELECT id FROM payroll_runs WHERE period=$1 AND status <> 'void'", [period]);
  if (dup) throw new HttpError(409, 'There is already a payroll for this month.');
  const { rows: [run] } = await db.query('INSERT INTO payroll_runs (period, created_by) VALUES ($1,$2) RETURNING *', [period, user.id]);
  const { rows: emps } = await db.query('SELECT * FROM employees WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1) ORDER BY department, first_name', [first, last]);
  let n = 0;
  for (const e of emps) { const l = await computeLine(db, e, period); if (l) { await writeLine(db, run.id, l); n++; } }
  if (!n) throw new HttpError(400, 'Nobody was employed in that month.');
  await audit(db, user, 'hr.payroll_create', 'payroll_run', run.id, { period, employees: n });
  return run;
}
/** Re-read salaries, joiners/leavers, unpaid leave and advances, keeping the overtime and adjustments already entered. */
export async function refreshRun(db, user, id) {
  const run = await runForUpdate(db, id);
  if (run.status !== 'draft') throw new HttpError(409, 'Only a draft payroll can be refreshed.');
  const { first, last } = periodBounds(run.period);
  const { rows: old } = await db.query('SELECT * FROM payroll_lines WHERE run_id=$1', [id]);
  await db.query('DELETE FROM payroll_lines WHERE run_id=$1', [id]);
  const { rows: emps } = await db.query('SELECT * FROM employees WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)', [first, last]);
  for (const e of emps) { const o = old.find((x) => x.employee_id === e.id) || {}; const l = await computeLine(db, e, run.period, o); if (l) await writeLine(db, id, l); }
  await audit(db, user, 'hr.payroll_refresh', 'payroll_run', id, { period: run.period });
}
export async function updateLine(db, user, id, employeeId, b) {
  const run = await runForUpdate(db, id);
  if (run.status !== 'draft') throw new HttpError(409, 'Only a draft payroll can be changed. Send it back to draft first.');
  const { rows: [e] } = await db.query('SELECT * FROM employees WHERE id=$1', [employeeId]);
  const { rows: [cur] } = await db.query('SELECT * FROM payroll_lines WHERE run_id=$1 AND employee_id=$2', [id, employeeId]);
  if (!e || !cur) throw new HttpError(404, 'Employee is not on this payroll.');
  const l = await computeLine(db, e, run.period, { ...cur, ...b });
  await writeLine(db, id, l);
  await audit(db, user, 'hr.payroll_line', 'payroll_run', id, { employee: e.emp_no, overtime_hours: l.overtime_hours, other_additions: l.other_additions, other_deductions: l.other_deductions });
  return l;
}
export async function approveRun(db, user, id) {
  const run = await runForUpdate(db, id);
  if (run.status !== 'draft') throw new HttpError(409, 'Only a draft payroll can be approved.');
  if (run.created_by === user.id && user.role !== 'admin') throw new HttpError(403, 'Someone other than the person who prepared the payroll must approve it.');
  await db.query("UPDATE payroll_runs SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [id, user.id]);
  await audit(db, user, 'hr.payroll_approve', 'payroll_run', id, { period: run.period });
}
export async function reopenRun(db, user, id) {
  const run = await runForUpdate(db, id);
  if (run.status !== 'approved') throw new HttpError(409, 'Only an approved, not yet posted payroll can go back to draft.');
  await db.query("UPDATE payroll_runs SET status='draft', approved_by=NULL, approved_at=NULL WHERE id=$1", [id]);
  await audit(db, user, 'hr.payroll_reopen', 'payroll_run', id, { period: run.period });
}
export async function voidRun(db, user, id) {
  const run = await runForUpdate(db, id);
  if (!['draft', 'approved'].includes(run.status)) throw new HttpError(409, 'A posted payroll cannot be deleted.');
  await db.query("UPDATE payroll_runs SET status='void' WHERE id=$1", [id]);
  await audit(db, user, 'hr.payroll_void', 'payroll_run', id, { period: run.period });
}
export async function totals(db, id) {
  const { rows: [t] } = await db.query(
    `SELECT count(*)::int AS employees, COALESCE(SUM(gross),0) AS gross, COALESCE(SUM(nssf_employee),0) AS nssf_employee, COALESCE(SUM(nssf_employer),0) AS nssf_employer,
            COALESCE(SUM(paye),0) AS paye, COALESCE(SUM(advance_recovery),0) AS advance_recovery, COALESCE(SUM(other_deductions),0) AS other_deductions, COALESCE(SUM(net),0) AS net
     FROM payroll_lines WHERE run_id=$1`, [id]);
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Number(v)]));
}
/** Post the approved payroll to the accounts and recover staff advances. */
export async function postRun(db, user, id) {
  const run = await runForUpdate(db, id);
  if (run.status !== 'approved') throw new HttpError(409, 'Approve the payroll before posting it.');
  const s = await getSettings(db);
  const { last } = periodBounds(run.period);
  const date = last < s.business_date ? last : s.business_date;
  const t = await totals(db, id);
  const entry = await postJournal(db, { date, description: `Payroll ${run.period}`, refType: 'payroll', refId: id, userId: user.id, lines: [
    { account: A.wages, debit: t.gross }, { account: A.employerNssf, debit: t.nssf_employer },
    { account: A.paye, credit: t.paye }, { account: A.nssf, credit: t.nssf_employee + t.nssf_employer },
    { account: A.advances, credit: t.advance_recovery }, { account: A.otherDed, credit: t.other_deductions }, { account: A.netPay, credit: t.net },
  ] });
  // reduce outstanding advances, oldest first
  const { rows: lines } = await db.query('SELECT employee_id, advance_recovery FROM payroll_lines WHERE run_id=$1 AND advance_recovery > 0', [id]);
  for (const l of lines) {
    let left = Number(l.advance_recovery);
    const { rows: adv } = await db.query('SELECT id, amount - recovered AS rem, monthly_recovery FROM staff_advances WHERE employee_id=$1 AND recovered < amount ORDER BY advance_date, id FOR UPDATE', [l.employee_id]);
    for (const a of adv) { if (!left) break; const take = Math.min(left, Number(a.rem), Number(a.monthly_recovery)); await db.query('UPDATE staff_advances SET recovered = recovered + $2 WHERE id=$1', [a.id, take]); left -= take; }
  }
  await db.query("UPDATE payroll_runs SET status='posted', posted_by=$2, posted_at=now(), post_entry_id=$3 WHERE id=$1", [id, user.id, entry]);
  await audit(db, user, 'hr.payroll_post', 'payroll_run', id, { period: run.period, gross: t.gross, net: t.net });
  return t;
}
export async function payRun(db, user, id, paidFrom) {
  const run = await runForUpdate(db, id);
  if (run.status !== 'posted') throw new HttpError(409, 'Post the payroll before paying it.');
  const { rows: [acct] } = await db.query('SELECT * FROM accounts WHERE code=$1 AND is_cash AND active', [String(paidFrom || '')]);
  if (!acct) throw new HttpError(400, 'Choose the account the salaries are paid from.');
  const s = await getSettings(db);
  const t = await totals(db, id);
  const entry = await postJournal(db, { date: s.business_date, description: `Salaries paid ${run.period}`, refType: 'payroll_payment', refId: id, userId: user.id, lines: [{ account: A.netPay, debit: t.net }, { account: acct.code, credit: t.net }] });
  await db.query("UPDATE payroll_runs SET status='paid', paid_from=$2, paid_at=now(), pay_entry_id=$3 WHERE id=$1", [id, acct.code, entry]);
  await audit(db, user, 'hr.payroll_paid', 'payroll_run', id, { period: run.period, net: t.net, from: acct.code });
}
export async function getRun(db, id) {
  const { rows: [run] } = await db.query(
    `SELECT r.*, cu.full_name AS created_by_name, au.full_name AS approved_by_name, pu.full_name AS posted_by_name FROM payroll_runs r
     LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users au ON au.id=r.approved_by LEFT JOIN users pu ON pu.id=r.posted_by WHERE r.id=$1`, [id]);
  if (!run) throw new HttpError(404, 'Payroll not found.');
  const { rows: lines } = await db.query(
    `SELECT l.*, e.emp_no, e.first_name, e.last_name, e.job_title, e.tin, e.nssf_no, e.nin, e.pay_method, e.bank_name, e.bank_account, e.momo_number
     FROM payroll_lines l JOIN employees e ON e.id=l.employee_id WHERE l.run_id=$1 ORDER BY l.department, e.first_name`, [id]);
  const byDept = {};
  for (const l of lines) { byDept[l.department] = byDept[l.department] || { department: l.department, employees: 0, gross: 0, employer_cost: 0 }; byDept[l.department].employees++; byDept[l.department].gross += Number(l.gross); byDept[l.department].employer_cost += Number(l.gross) + Number(l.nssf_employer); }
  return { ...run, lines: lines.map((l) => ({ ...l, overtime_hours: Number(l.overtime_hours) })), totals: await totals(db, id), departments: Object.values(byDept) };
}
