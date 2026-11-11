import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, can } from '../auth.js';
import * as hr from '../services/hr.js';
import { getSettings } from '../services/frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function hrRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req, k = 'id') => { const n = Number(req.params[k]); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const view = requirePerm('hr.view'), manage = requirePerm('hr.manage'), approve = requirePerm('hr.approve'), payroll = requirePerm('payroll.manage');
  const anyOf = (...p) => (req, _res, next) => { if (!p.some((x) => can(req.user, x))) throw new HttpError(403, 'You do not have permission to do this.'); next(); };
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const dept = (req) => (hr.DEPARTMENTS.includes(req.query.department) ? req.query.department : null);

  r.get('/setup', anyOf('hr.view', 'roster.manage', 'attendance.record', 'payroll.manage', 'staff.self'), async (_req, res) => res.json({
    departments: hr.DEPARTMENTS, shifts: await q("SELECT id, code, name, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time, active FROM shift_templates ORDER BY start_time"),
    leave_types: await q('SELECT * FROM leave_types ORDER BY sort'),
  }));

  /* ---------- employees ---------- */
  r.get('/employees', anyOf('hr.view', 'roster.manage', 'attendance.record', 'payroll.manage'), async (req, res) => {
    const showPay = can(req.user, 'hr.view');
    const rows = await q(`SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.id=e.user_id WHERE ($1::text IS NULL OR e.status=$1) ORDER BY e.department, e.first_name`, [req.query.status === 'all' ? null : (req.query.status || 'active')]);
    res.json(showPay ? rows : rows.map(({ id: i, emp_no, first_name, last_name, department, job_title, status }) => ({ id: i, emp_no, first_name, last_name, department, job_title, status })));
  });
  r.get('/employees/:id', view, async (req, res) => {
    const [e] = await q('SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.id=e.user_id WHERE e.id=$1', [id(req)]);
    if (!e) throw new HttpError(404, 'Employee not found.');
    const s = await getSettings(pool);
    res.json({ employee: e, leave_balance: await hr.leaveBalance(pool, e.id, Number(s.business_date.slice(0, 4))),
      leave: await q("SELECT l.*, to_char(from_date,'YYYY-MM-DD') AS f, to_char(to_date,'YYYY-MM-DD') AS t, t.name AS type_name FROM leave_requests l JOIN leave_types t ON t.code=l.type WHERE employee_id=$1 ORDER BY from_date DESC LIMIT 30", [e.id]),
      advances: await q("SELECT *, to_char(advance_date,'YYYY-MM-DD') AS d FROM staff_advances WHERE employee_id=$1 ORDER BY id DESC", [e.id]),
      payslips: await q(`SELECT r.id, r.period, r.status, l.gross, l.net FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE l.employee_id=$1 AND r.status IN ('posted','paid') ORDER BY r.period DESC LIMIT 24`, [e.id]) });
  });
  r.post('/employees', manage, inTx((db, req) => hr.saveEmployee(db, req.user, null, req.body || {})));
  r.put('/employees/:id', manage, inTx((db, req) => hr.saveEmployee(db, req.user, id(req), req.body || {})));
  r.post('/employees/:id/leave-company', manage, inTx(async (db, req) => { await hr.endEmployment(db, req.user, id(req), req.body || {}); return { ok: true }; }));
  r.get('/users-unlinked', manage, async (_req, res) => res.json(await q('SELECT u.id, u.username, u.full_name FROM users u WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id=u.id) ORDER BY u.full_name')));

  /* ---------- rosters & attendance ---------- */
  r.get('/roster', anyOf('roster.manage', 'hr.view', 'attendance.record'), async (req, res) => {
    const s = await getSettings(pool);
    res.json(await hr.rosterWeek(pool, DATE_RE.test(req.query.from || '') ? req.query.from : s.business_date, dept(req)));
  });
  r.put('/roster', requirePerm('roster.manage'), inTx((db, req) => hr.saveRoster(db, req.user, req.body?.entries)));
  r.post('/roster/copy', requirePerm('roster.manage'), inTx((db, req) => { if (!DATE_RE.test(req.body?.from || '')) throw new HttpError(400, 'Choose the week.'); return hr.copyRosterWeek(db, req.user, req.body.from, hr.DEPARTMENTS.includes(req.body?.department) ? req.body.department : null); }));
  r.get('/attendance', anyOf('attendance.record', 'hr.view'), async (req, res) => {
    const s = await getSettings(pool);
    res.json(await hr.attendanceDay(pool, DATE_RE.test(req.query.date || '') ? req.query.date : s.business_date, dept(req)));
  });
  r.post('/attendance', requirePerm('attendance.record'), inTx(async (db, req) => hr.recordAttendance(db, req.user, req.body || {})));

  /* ---------- leave ---------- */
  r.get('/leave', anyOf('hr.view', 'hr.approve'), async (req, res) => res.json(await q(
    `SELECT l.*, to_char(l.from_date,'YYYY-MM-DD') AS f, to_char(l.to_date,'YYYY-MM-DD') AS t, e.first_name, e.last_name, e.department, e.user_id, lt.name AS type_name, du.full_name AS decided_by_name
     FROM leave_requests l JOIN employees e ON e.id=l.employee_id JOIN leave_types lt ON lt.code=l.type LEFT JOIN users du ON du.id=l.decided_by
     WHERE ($1 = 'pending' AND l.status='pending') OR ($1 = 'upcoming' AND l.status='approved' AND l.to_date >= CURRENT_DATE - 1) OR ($1 = 'all')
     ORDER BY l.from_date DESC LIMIT 200`, [['pending', 'upcoming', 'all'].includes(req.query.view) ? req.query.view : 'pending'])));
  r.post('/leave', manage, inTx((db, req) => hr.requestLeave(db, req.user, req.body || {})));
  r.post('/leave/:id/decide', approve, inTx(async (db, req) => { await hr.decideLeave(db, req.user, id(req), req.body || {}); return { ok: true }; }));
  r.post('/leave/:id/cancel', anyOf('hr.manage', 'staff.self'), inTx(async (db, req) => { await hr.cancelLeave(db, req.user, id(req)); return { ok: true }; }));

  /* ---------- advances ---------- */
  r.get('/advances', anyOf('hr.view', 'payroll.manage'), async (_req, res) => res.json(await q("SELECT a.*, to_char(a.advance_date,'YYYY-MM-DD') AS d, e.first_name, e.last_name FROM staff_advances a JOIN employees e ON e.id=a.employee_id ORDER BY a.recovered >= a.amount, a.id DESC LIMIT 200")));
  r.post('/advances', payroll, inTx((db, req) => hr.giveAdvance(db, req.user, req.body || {})));

  /* ---------- payroll ---------- */
  r.get('/payroll', anyOf('hr.view', 'payroll.manage', 'hr.approve'), async (_req, res) => res.json(await q(
    `SELECT r.id, r.period, r.status, r.created_at, cu.full_name AS created_by_name, (SELECT count(*) FROM payroll_lines WHERE run_id=r.id)::int AS employees,
            (SELECT COALESCE(SUM(gross),0) FROM payroll_lines WHERE run_id=r.id)::bigint AS gross, (SELECT COALESCE(SUM(net),0) FROM payroll_lines WHERE run_id=r.id)::bigint AS net
     FROM payroll_runs r LEFT JOIN users cu ON cu.id=r.created_by WHERE r.status <> 'void' ORDER BY r.period DESC LIMIT 36`)));
  r.post('/payroll', payroll, inTx((db, req) => hr.createRun(db, req.user, req.body?.period)));
  r.get('/payroll/:id', anyOf('hr.view', 'payroll.manage', 'hr.approve'), async (req, res) => res.json(await hr.getRun(pool, id(req))));
  r.post('/payroll/:id/refresh', payroll, inTx(async (db, req) => { await hr.refreshRun(db, req.user, id(req)); return { ok: true }; }));
  r.put('/payroll/:id/lines/:emp', payroll, inTx((db, req) => hr.updateLine(db, req.user, id(req), id(req, 'emp'), req.body || {})));
  r.post('/payroll/:id/approve', approve, inTx(async (db, req) => { await hr.approveRun(db, req.user, id(req)); return { ok: true }; }));
  r.post('/payroll/:id/reopen', anyOf('hr.approve', 'payroll.manage'), inTx(async (db, req) => { await hr.reopenRun(db, req.user, id(req)); return { ok: true }; }));
  r.post('/payroll/:id/void', payroll, inTx(async (db, req) => { await hr.voidRun(db, req.user, id(req)); return { ok: true }; }));
  r.post('/payroll/:id/post', payroll, inTx((db, req) => hr.postRun(db, req.user, id(req))));
  r.post('/payroll/:id/pay', payroll, inTx(async (db, req) => { await hr.payRun(db, req.user, id(req), req.body?.paid_from); return { ok: true }; }));

  /* ---------- self-service ---------- */
  const self = requirePerm('staff.self');
  r.get('/me', self, async (req, res) => {
    const me = await hr.myEmployee(pool, req.user);
    if (!me) return res.json({ linked: false });
    const s = await getSettings(pool);
    const week = await hr.rosterWeek(pool, s.business_date, null);
    const mine = week.employees.find((e) => e.id === me.id);
    const [att] = await q("SELECT to_char(clock_in AT TIME ZONE 'Africa/Kampala','HH24:MI') AS clock_in, to_char(clock_out AT TIME ZONE 'Africa/Kampala','HH24:MI') AS clock_out FROM attendance WHERE employee_id=$1 AND date=$2", [me.id, s.business_date]);
    res.json({ linked: true, employee: { id: me.id, emp_no: me.emp_no, first_name: me.first_name, last_name: me.last_name, department: me.department, job_title: me.job_title },
      today: s.business_date, attendance: att || null, week: mine ? mine.days : [], leave_balance: await hr.leaveBalance(pool, me.id, Number(s.business_date.slice(0, 4))),
      leave: await q("SELECT l.id, l.type, l.days, l.status, to_char(from_date,'YYYY-MM-DD') AS f, to_char(to_date,'YYYY-MM-DD') AS t, t.name AS type_name FROM leave_requests l JOIN leave_types t ON t.code=l.type WHERE employee_id=$1 ORDER BY from_date DESC LIMIT 20", [me.id]),
      payslips: await q("SELECT r.id, r.period, l.net FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE l.employee_id=$1 AND r.status IN ('posted','paid') ORDER BY r.period DESC LIMIT 24", [me.id]) });
  });
  r.post('/me/clock', self, inTx((db, req) => hr.selfClock(db, req.user, req.body?.action === 'out' ? 'out' : 'in')));
  r.post('/me/leave', self, inTx((db, req) => hr.requestLeave(db, req.user, req.body || {}, { self: true })));
  r.get('/payslip/:run', anyOf('staff.self', 'hr.view', 'payroll.manage'), async (req, res) => {
    const me = await hr.myEmployee(pool, req.user);
    const empId = req.query.employee_id && (can(req.user, 'hr.view') || can(req.user, 'payroll.manage')) ? Number(req.query.employee_id) : me?.id;
    if (!empId) throw new HttpError(403, 'Your sign-in is not linked to an employee record.');
    const [l] = await q(
      `SELECT l.*, r.period, r.status, e.emp_no, e.first_name, e.last_name, e.job_title, e.tin, e.nssf_no, e.pay_method, e.bank_name, e.bank_account, e.momo_number
       FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id JOIN employees e ON e.id=l.employee_id WHERE l.run_id=$1 AND l.employee_id=$2`, [id(req, 'run'), empId]);
    if (!l) throw new HttpError(404, 'Payslip not found.');
    if (!['posted', 'paid'].includes(l.status) && !(can(req.user, 'hr.view') || can(req.user, 'payroll.manage'))) throw new HttpError(404, 'Payslip not found.');
    res.json({ ...l, overtime_hours: Number(l.overtime_hours) });
  });
  return r;
}
