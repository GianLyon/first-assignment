// Phase 23: fuller HR. Documents, public holidays, leave types, discipline, appraisals, alerts and attendance summaries.
import { HttpError, audit } from '../auth.js';
import { getSettings } from './frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
async function employee(db, id) {
  const { rows: [e] } = await db.query('SELECT * FROM employees WHERE id=$1', [Number(id)]);
  if (!e) throw new HttpError(404, 'Employee not found.');
  return e;
}

/* ---------------- documents ---------------- */
export const DOC_KINDS = ['national_id', 'passport', 'cv', 'contract', 'certificate', 'medical', 'letter', 'other'];
const DOC_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** A file sent as a data URL ("data:application/pdf;base64,…"), up to 3 MB. */
export async function addDocument(db, user, employeeId, b) {
  const e = await employee(db, employeeId);
  if (!DOC_KINDS.includes(b.kind)) throw new HttpError(400, 'Choose what kind of document this is.');
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.file || ''));
  if (!m || !DOC_TYPES[m[1]]) throw new HttpError(400, 'Upload a PDF or a photo (JPG, PNG or WebP).');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > 3 * 1024 * 1024) throw new HttpError(400, 'Files can be up to 3 MB.');
  const title = text(b.title, 'Title', { max: 120 }) || b.kind.replace('_', ' ');
  const filename = (text(b.filename, 'File name', { max: 150 }) || `${title}.${DOC_TYPES[m[1]]}`).replace(/[^\w. -]+/g, '_');
  const { rows: [d] } = await db.query(`INSERT INTO employee_documents (employee_id, kind, title, filename, mime, size, data, expires_on, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, kind, title, filename, mime, size, expires_on, uploaded_at`,
  [e.id, b.kind, title, filename, m[1], data.length, data, isDate(b.expires_on) ? b.expires_on : null, user.id]);
  await audit(db, user, 'hr.document_add', 'employee', e.id, { kind: b.kind, title, size: data.length });
  return d;
}
export async function removeDocument(db, user, docId) {
  const { rows: [d] } = await db.query('DELETE FROM employee_documents WHERE id=$1 RETURNING employee_id, title', [Number(docId)]);
  if (!d) throw new HttpError(404, 'Document not found.');
  await audit(db, user, 'hr.document_remove', 'employee', d.employee_id, { title: d.title });
}

/* ---------------- public holidays & leave types ---------------- */
export async function saveHoliday(db, user, b) {
  if (!isDate(b.date)) throw new HttpError(400, 'Choose the date.');
  const name = text(b.name, 'Name', { required: true, max: 80 });
  await db.query('INSERT INTO public_holidays (date, name) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET name=EXCLUDED.name', [b.date, name]);
  await audit(db, user, 'hr.holiday_save', 'public_holiday', null, { date: b.date, name });
  return { date: b.date, name };
}
export async function removeHoliday(db, user, date) {
  if (!isDate(date)) throw new HttpError(400, 'Invalid date.');
  await db.query('DELETE FROM public_holidays WHERE date=$1', [date]);
  await audit(db, user, 'hr.holiday_remove', 'public_holiday', null, { date });
}
export async function saveLeaveType(db, user, code, b) {
  const name = text(b.name, 'Name', { required: true, max: 60 });
  const max = b.max_days_year === '' || b.max_days_year == null ? null : Number(b.max_days_year);
  if (max !== null && !(Number.isInteger(max) && max >= 1 && max <= 365)) throw new HttpError(400, 'Days a year must be between 1 and 365.');
  const vals = [name, b.paid !== false, !!b.uses_balance, max, b.active !== false, Number(b.sort) || 0];
  if (code) {
    const { rowCount } = await db.query('UPDATE leave_types SET name=$2, paid=$3, uses_balance=$4, max_days_year=$5, active=$6, sort=$7 WHERE code=$1', [code, ...vals]);
    if (!rowCount) throw new HttpError(404, 'Leave type not found.');
  } else {
    code = String(b.code || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    if (!code) throw new HttpError(400, 'Give the leave type a name.');
    const { rows: [dup] } = await db.query('SELECT 1 FROM leave_types WHERE code=$1', [code]);
    if (dup) throw new HttpError(409, 'There is already a leave type with that name.');
    await db.query('INSERT INTO leave_types (code, name, paid, uses_balance, max_days_year, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)', [code, ...vals]);
  }
  await audit(db, user, 'hr.leave_type_save', 'leave_type', null, { code, name });
  return { code };
}

/* ---------------- discipline ---------------- */
export const CASE_KINDS = ['counselling', 'verbal_warning', 'written_warning', 'final_warning', 'suspension', 'dismissal', 'other'];
const WARNING_MONTHS = { verbal_warning: 6, written_warning: 12, final_warning: 12 };
export async function saveCase(db, user, id, b) {
  let empId = Number(b.employee_id);
  if (id) {
    const { rows: [c] } = await db.query('SELECT employee_id FROM disciplinary_cases WHERE id=$1', [id]);
    if (!c) throw new HttpError(404, 'Case not found.');
    empId = c.employee_id;
  }
  await employee(db, empId);
  if (!CASE_KINDS.includes(b.kind)) throw new HttpError(400, 'Choose the type of case.');
  if (!isDate(b.case_date)) throw new HttpError(400, 'Choose the date.');
  let expires = isDate(b.expires_on) ? b.expires_on : null;
  if (!expires && WARNING_MONTHS[b.kind] && !id) { const d = new Date(b.case_date + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + WARNING_MONTHS[b.kind]); expires = d.toISOString().slice(0, 10); }
  const vals = [b.case_date, b.kind, text(b.subject, 'Subject', { required: true, max: 150 }), text(b.details, 'Details', { max: 3000 }), text(b.action_taken, 'Action taken', { max: 1000 }), expires, b.status === 'closed' ? 'closed' : 'open'];
  let c;
  if (id) ({ rows: [c] } = await db.query('UPDATE disciplinary_cases SET case_date=$2, kind=$3, subject=$4, details=$5, action_taken=$6, expires_on=$7, status=$8 WHERE id=$1 RETURNING *', [id, ...vals]));
  else ({ rows: [c] } = await db.query('INSERT INTO disciplinary_cases (employee_id, case_date, kind, subject, details, action_taken, expires_on, status, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [empId, ...vals, user.id]));
  await audit(db, user, id ? 'hr.case_update' : 'hr.case_create', 'employee', empId, { case: c.id, kind: c.kind, status: c.status });
  return c;
}

/* ---------------- appraisals ---------------- */
export const CRITERIA = [['quality', 'Quality of work'], ['guest_service', 'Guest service'], ['teamwork', 'Teamwork'], ['attendance', 'Attendance & punctuality'], ['initiative', 'Initiative'], ['grooming', 'Grooming & standards']];
export async function saveAppraisal(db, user, id, b) {
  let a = null;
  if (id) {
    ({ rows: [a] } = await db.query('SELECT * FROM appraisals WHERE id=$1 FOR UPDATE', [id]));
    if (!a) throw new HttpError(404, 'Appraisal not found.');
    if (a.status === 'acknowledged') throw new HttpError(409, 'The employee has already signed this appraisal off.');
  }
  const emp = await employee(db, a?.employee_id ?? b.employee_id);
  if (!isDate(b.review_date)) throw new HttpError(400, 'Choose the review date.');
  const scores = {};
  for (const [k] of CRITERIA) {
    if (b.scores?.[k] === undefined || b.scores[k] === '' || b.scores[k] === null) continue;
    const v = Number(b.scores[k]);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, 'Scores are whole numbers from 1 to 5.');
    scores[k] = v;
  }
  const vals = Object.values(scores);
  const overall = vals.length ? Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 100) / 100 : null;
  const rec = ['confirm', 'extend_probation', 'increment', 'promotion', 'training', 'pip', 'none'].includes(b.recommendation) ? b.recommendation : null;
  const status = b.status === 'shared' ? 'shared' : 'draft';
  const row = [text(b.period, 'Period', { required: true, max: 60 }), b.review_date, scores, overall, text(b.strengths, 'Strengths', { max: 2000 }), text(b.improvements, 'To improve', { max: 2000 }), text(b.goals, 'Goals', { max: 2000 }), rec, status];
  let out;
  if (a) ({ rows: [out] } = await db.query('UPDATE appraisals SET period=$2, review_date=$3, scores=$4, overall=$5, strengths=$6, improvements=$7, goals=$8, recommendation=$9, status=$10 WHERE id=$1 RETURNING *', [id, ...row]));
  else ({ rows: [out] } = await db.query('INSERT INTO appraisals (employee_id, period, review_date, scores, overall, strengths, improvements, goals, recommendation, status, reviewer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [emp.id, ...row, user.id]));
  await audit(db, user, a ? 'hr.appraisal_update' : 'hr.appraisal_create', 'employee', emp.id, { appraisal: out.id, overall, status });
  return out;
}
/** The employee reads a shared appraisal and signs it off, with an optional comment. */
export async function acknowledgeAppraisal(db, user, id, comment) {
  const { rows: [a] } = await db.query('SELECT a.*, e.user_id FROM appraisals a JOIN employees e ON e.id=a.employee_id WHERE a.id=$1 FOR UPDATE OF a', [id]);
  if (!a || a.user_id !== user.id) throw new HttpError(404, 'Appraisal not found.');
  if (a.status !== 'shared') throw new HttpError(409, a.status === 'acknowledged' ? 'You have already signed this appraisal off.' : 'This appraisal has not been shared with you yet.');
  await db.query("UPDATE appraisals SET status='acknowledged', employee_comment=$2 WHERE id=$1", [id, text(comment, 'Comment', { max: 2000 })]);
  await audit(db, user, 'hr.appraisal_ack', 'employee', a.employee_id, { appraisal: id });
}

/* ---------------- alerts ---------------- */
/** What HR should act on soon: contracts and probation ending, IDs and documents expiring, birthdays, open cases, leave waiting. */
export async function alerts(db) {
  const s = await getSettings(db);
  const today = s.business_date, in30 = addDays(today, 30), in14 = addDays(today, 14);
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const name = "e.first_name || ' ' || e.last_name";
  const list = [
    ...(await q(`SELECT e.id, ${name} AS name, to_char(e.contract_end,'YYYY-MM-DD') AS date FROM employees e WHERE e.status='active' AND e.contract_end BETWEEN $1::date - 30 AND $2 ORDER BY e.contract_end`, [today, in30]))
      .map((r) => ({ ...r, kind: 'contract', level: r.date < today ? 'bad' : 'warn', text: r.date < today ? `Contract ended ${r.date}: renew or record leaving` : `Contract ends ${r.date}` })),
    ...(await q(`SELECT e.id, ${name} AS name, to_char(e.probation_end,'YYYY-MM-DD') AS date FROM employees e WHERE e.status='active' AND e.probation_end BETWEEN $1::date - 14 AND $2 ORDER BY e.probation_end`, [today, in14]))
      .map((r) => ({ ...r, kind: 'probation', level: 'warn', text: `Probation ${r.date < today ? 'ended' : 'ends'} ${r.date}: do the probation review` })),
    ...(await q(`SELECT e.id, ${name} AS name, to_char(e.id_expiry,'YYYY-MM-DD') AS date FROM employees e WHERE e.status='active' AND e.id_expiry <= $1 ORDER BY e.id_expiry`, [in30]))
      .map((r) => ({ ...r, kind: 'id', level: r.date < today ? 'bad' : 'warn', text: `ID / passport ${r.date < today ? 'expired' : 'expires'} ${r.date}` })),
    ...(await q(`SELECT e.id, ${name} AS name, d.title, to_char(d.expires_on,'YYYY-MM-DD') AS date FROM employee_documents d JOIN employees e ON e.id=d.employee_id WHERE e.status='active' AND d.expires_on <= $1 ORDER BY d.expires_on`, [in30]))
      .map((r) => ({ ...r, kind: 'document', level: r.date < today ? 'bad' : 'warn', text: `${r.title} ${r.date < today ? 'expired' : 'expires'} ${r.date}` })),
    ...(await q(`SELECT e.id, ${name} AS name, to_char(e.date_of_birth,'DD Mon') AS date FROM employees e WHERE e.status='active' AND e.date_of_birth IS NOT NULL
        AND to_char(e.date_of_birth,'MM-DD') IN (SELECT to_char(d,'MM-DD') FROM generate_series($1::date, $1::date + 6, interval '1 day') d)`, [today]))
      .map((r) => ({ ...r, kind: 'birthday', level: 'info', text: `Birthday ${r.date}` })),
    ...(await q(`SELECT e.id, ${name} AS name, c.subject, c.kind AS ckind FROM disciplinary_cases c JOIN employees e ON e.id=c.employee_id WHERE c.status='open' ORDER BY c.case_date`, []))
      .map((r) => ({ id: r.id, name: r.name, kind: 'case', level: 'warn', text: `Open case: ${r.subject}` })),
    ...(await q(`SELECT e.id, ${name} AS name, a.period FROM appraisals a JOIN employees e ON e.id=a.employee_id WHERE a.status='draft'`, []))
      .map((r) => ({ id: r.id, name: r.name, kind: 'appraisal', level: 'info', text: `Appraisal "${r.period}" not yet shared` })),
  ];
  const { rows: [lv] } = await db.query("SELECT count(*)::int AS n FROM leave_requests WHERE status='pending'");
  return { today, alerts: list, leave_waiting: lv.n };
}

/* ---------------- attendance summary ---------------- */
/** Per employee for a month: days rostered, present, late, absent, on leave, hours worked and overtime (hours beyond each rostered shift). */
export async function attendanceMonth(db, period, department = null) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) throw new HttpError(400, 'Choose a month.');
  const s = await getSettings(db);
  const first = period + '-01';
  const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
  const upTo = last < s.business_date ? last : addDays(s.business_date, -1); // only finished days count as absent
  const { rows } = await db.query(
    `WITH days AS (SELECT d::date AS d FROM generate_series($1::date, $2::date, interval '1 day') d),
     x AS (
       SELECT e.id, d.d, r.shift_id, st.start_time, st.end_time, a.clock_in, a.clock_out,
              EXISTS (SELECT 1 FROM leave_requests l WHERE l.employee_id=e.id AND l.status='approved' AND d.d BETWEEN l.from_date AND l.to_date) AS on_leave,
              EXISTS (SELECT 1 FROM public_holidays h WHERE h.date=d.d) AS holiday
       FROM employees e CROSS JOIN days d
       LEFT JOIN roster r ON r.employee_id=e.id AND r.date=d.d LEFT JOIN shift_templates st ON st.id=r.shift_id
       LEFT JOIN attendance a ON a.employee_id=e.id AND a.date=d.d
       WHERE e.start_date <= d.d AND (e.end_date IS NULL OR e.end_date >= d.d) AND ($4::text IS NULL OR e.department=$4))
     SELECT e.id, e.emp_no, e.first_name, e.last_name, e.department,
       count(*) FILTER (WHERE x.shift_id IS NOT NULL)::int AS rostered,
       count(*) FILTER (WHERE x.clock_in IS NOT NULL)::int AS present,
       count(*) FILTER (WHERE x.clock_in IS NOT NULL AND x.start_time IS NOT NULL AND (x.clock_in AT TIME ZONE 'Africa/Kampala') > (x.d + x.start_time + interval '10 minutes'))::int AS late,
       count(*) FILTER (WHERE x.shift_id IS NOT NULL AND x.clock_in IS NULL AND NOT x.on_leave AND x.d <= $3)::int AS absent,
       count(*) FILTER (WHERE x.on_leave)::int AS leave_days,
       count(*) FILTER (WHERE x.holiday AND x.clock_in IS NOT NULL)::int AS holidays_worked,
       COALESCE(round(SUM(EXTRACT(EPOCH FROM (x.clock_out - x.clock_in))/3600)::numeric, 2), 0) AS hours,
       COALESCE(round(SUM(GREATEST(0, EXTRACT(EPOCH FROM (x.clock_out - x.clock_in))/3600
         - (EXTRACT(EPOCH FROM (x.end_time - x.start_time))/3600 + CASE WHEN x.end_time < x.start_time THEN 24 ELSE 0 END))) FILTER (WHERE x.shift_id IS NOT NULL AND x.clock_out IS NOT NULL)::numeric, 2), 0) AS overtime
     FROM x JOIN employees e ON e.id=x.id GROUP BY e.id ORDER BY e.department, e.first_name`, [first, last, upTo, department]);
  return { period, first, last, employees: rows.map((r) => ({ ...r, hours: Number(r.hours), overtime: Number(r.overtime) })) };
}
