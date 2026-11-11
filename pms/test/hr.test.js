// Phase 6: HR & payroll (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok } from './helpers.js';
import { paye } from '../src/services/hr.js';

let admin, hro, mgr, acc, staff, waiter, agnes, joseph, charles;
const users = {};
const lastJournal = async () => ok(await admin.get('/api/accounts/journal?limit=1'))[0].lines.map((l) => [l.account, l.debit, l.credit]);

before(async () => {
  await startTestServer({ hr: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['hrofficer', 'hr_officer'], ['manager1', 'manager'], ['accounts1', 'accountant'], ['agnes', 'front_office'], ['waiter1', 'waiter']]) {
    users[username] = ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  hro = client(); await hro.login('hrofficer', 'password-123');
  mgr = client(); await mgr.login('manager1', 'password-123');
  acc = client(); await acc.login('accounts1', 'password-123');
  staff = client(); await staff.login('agnes', 'password-123');
  waiter = client(); await waiter.login('waiter1', 'password-123');
});
after(stopTestServer);

test('PAYE follows the Uganda monthly bands', () => {
  assert.equal(paye(235000), 0);
  assert.equal(paye(300000), 6500);
  assert.equal(paye(400000), 23000);
  assert.equal(paye(1000000), 202000);
  assert.equal(paye(12000000), 3702000);
});

test('employees: records, permissions, validation', async () => {
  assert.equal((await waiter.get('/api/hr/employees')).status, 403);
  assert.equal((await mgr.post('/api/hr/advances', {})).status, 403);
  const base = { department: 'Front Office', job_title: 'Receptionist', pay_method: 'bank', bank_name: 'Stanbic', bank_account: '9030001234' };
  assert.equal((await hro.post('/api/hr/employees', { ...base, first_name: 'X', last_name: 'Y', start_date: '2026-01-01', basic_salary: 1, pay_method: 'mobile_money' })).status, 400);
  agnes = ok(await hro.post('/api/hr/employees', { ...base, first_name: 'Agnes', last_name: 'Nalubega', gender: 'female', start_date: '2026-01-01', basic_salary: 1000000, housing_allowance: 200000, tin: '1001', nssf_no: 'NS1', user_id: users.agnes.id }));
  assert.match(agnes.emp_no, /^E\d+$/);
  assert.equal((await hro.post('/api/hr/employees', { ...base, first_name: 'Dup', last_name: 'Link', start_date: '2026-01-01', basic_salary: 1, user_id: users.agnes.id })).status, 409);
  joseph = ok(await hro.post('/api/hr/employees', { first_name: 'Joseph', last_name: 'Wasswa', department: 'Housekeeping', job_title: 'Room attendant', start_date: '2026-10-16', basic_salary: 600000, pay_method: 'mobile_money', momo_number: '0772000111' }));
  charles = ok(await hro.post('/api/hr/employees', { first_name: 'Charles', last_name: 'Mutebi', department: 'Kitchen', job_title: 'Head chef', start_date: '2025-03-01', basic_salary: 2000000, pay_method: 'cash' }));
  ok(await hro.post(`/api/hr/employees/${charles.id}/leave-company`, { end_date: '2026-10-20', reason: 'Resigned' }));
  assert.equal(ok(await hro.get('/api/hr/employees')).length, 2);
  assert.equal(ok(await hro.get('/api/hr/employees?status=all')).length, 3);
  const log = ok(await admin.get('/api/audit-log?limit=20'));
  assert.ok(log.some((l) => l.action === 'hr.employee_left'));
});

test('leave: balances, approval by someone else, self-service', async () => {
  let me = ok(await staff.get('/api/hr/me'));
  assert.equal(me.linked, true); assert.equal(me.leave_balance.remaining, 21);
  assert.equal((await staff.post('/api/hr/me/leave', { type: 'annual', from_date: '2026-12-01', to_date: '2026-12-25' })).status, 409); // 25 days > 21
  const req = ok(await staff.post('/api/hr/me/leave', { type: 'annual', from_date: '2026-12-01', to_date: '2026-12-05', reason: 'Family visit' }));
  assert.equal(req.days, 5);
  assert.equal((await staff.post('/api/hr/me/leave', { type: 'sick', from_date: '2026-12-04', to_date: '2026-12-06' })).status, 409); // overlaps
  assert.equal((await hro.post(`/api/hr/leave/${req.id}/decide`, { decision: 'approved' })).status, 403); // HR officer records, managers approve
  ok(await mgr.post(`/api/hr/leave/${req.id}/decide`, { decision: 'approved' }));
  me = ok(await staff.get('/api/hr/me'));
  assert.equal(me.leave_balance.taken, 5); assert.equal(me.leave_balance.remaining, 16);
  // unpaid leave in October (affects October pay)
  const unpaid = ok(await hro.post('/api/hr/leave', { employee_id: agnes.id, type: 'unpaid', from_date: '2026-10-05', to_date: '2026-10-06' }));
  assert.equal((await mgr.post(`/api/hr/leave/${unpaid.id}/decide`, { decision: 'rejected' })).status, 400); // rejection needs a reason
  ok(await mgr.post(`/api/hr/leave/${unpaid.id}/decide`, { decision: 'approved' }));
  assert.equal((await waiter.post('/api/hr/me/leave', { type: 'annual', from_date: '2026-12-01', to_date: '2026-12-01' })).status, 403); // not linked
});

test('rosters and attendance', async () => {
  const setup = ok(await hro.get('/api/hr/setup'));
  const morning = setup.shifts.find((s) => s.code === 'M');
  ok(await mgr.put('/api/hr/roster', { entries: [
    { employee_id: agnes.id, date: '2026-11-09', shift_id: morning.id }, { employee_id: agnes.id, date: '2026-11-10', shift_id: morning.id },
    { employee_id: joseph.id, date: '2026-11-09', shift_id: morning.id }, { employee_id: joseph.id, date: '2026-11-10', shift_id: null }] }));
  const copy = ok(await mgr.post('/api/hr/roster/copy', { from: '2026-11-16' }));
  assert.equal(copy.copied, 4); // both staff, the 9th and 10th (including Joseph's day off), a week later
  const wk = ok(await mgr.get('/api/hr/roster?from=2026-11-16'));
  assert.equal(wk.employees.find((e) => e.id === agnes.id).days[0].shift_id, morning.id);
  const dec = ok(await mgr.get('/api/hr/roster?from=2026-12-01'));
  assert.equal(dec.employees.find((e) => e.id === agnes.id).days[0].leave, 'annual');
  // attendance: Agnes late on the 9th, Joseph absent; Agnes signs herself in today
  ok(await mgr.post('/api/hr/attendance', { employee_id: agnes.id, date: '2026-11-09', clock_in: '07:25', clock_out: '15:05' }));
  const day = ok(await mgr.get('/api/hr/attendance?date=2026-11-09'));
  assert.equal(day.find((r) => r.id === agnes.id).status, 'late');
  assert.equal(day.find((r) => r.id === agnes.id).hours, 7.67);
  assert.equal(day.find((r) => r.id === joseph.id).status, 'absent');
  ok(await staff.post('/api/hr/me/clock', { action: 'in' }));
  assert.equal((await staff.post('/api/hr/me/clock', { action: 'in' })).status, 409);
  ok(await staff.post('/api/hr/me/clock', { action: 'out' }));
  const today = ok(await mgr.get('/api/hr/attendance?date=2026-11-10'));
  assert.equal(today.find((r) => r.id === joseph.id).status, 'off');
  assert.ok(today.find((r) => r.id === agnes.id).clock_in);
  // night shift sign-out after midnight
  ok(await mgr.post('/api/hr/attendance', { employee_id: joseph.id, date: '2026-11-08', clock_in: '23:00', clock_out: '07:00' }));
  assert.equal(ok(await mgr.get('/api/hr/attendance?date=2026-11-08')).find((r) => r.id === joseph.id).hours, 8);
});

let run;
test('payroll: proration, unpaid leave, overtime, NSSF, PAYE and advances', async () => {
  assert.ok(ok(await hro.get('/api/finance/accounts')).some((x) => x.code === '1030' && x.is_cash)); // payroll staff can pick the paying account
  ok(await hro.post('/api/hr/advances', { employee_id: agnes.id, amount: 300000, monthly_recovery: 100000, paid_from: '1000', reason: 'School fees' }));
  assert.deepEqual(await lastJournal(), [['1250', 300000, 0], ['1000', 0, 300000]]);
  assert.equal((await hro.post('/api/hr/payroll', { period: '2026-12' })).status, 400); // future month
  run = ok(await hro.post('/api/hr/payroll', { period: '2026-10' }));
  assert.equal((await hro.post('/api/hr/payroll', { period: '2026-10' })).status, 409);
  ok(await hro.put(`/api/hr/payroll/${run.id}/lines/${agnes.id}`, { overtime_hours: 10 }));
  const r = ok(await hro.get(`/api/hr/payroll/${run.id}`));
  assert.equal(r.lines.length, 3);
  const a = r.lines.find((l) => l.employee_id === agnes.id);
  // 1,000,000 less 2 unpaid days of 31 = 935,484; housing 200,000; 10 h overtime at 1.5× = 72,115
  assert.deepEqual([a.unpaid_days, a.basic, a.allowances, a.overtime, a.gross, a.nssf_employee, a.nssf_employer, a.paye, a.advance_recovery, a.net],
    [2, 935484, 200000, 72115, 1207599, 60380, 120760, 264280, 100000, 782939]);
  const j = r.lines.find((l) => l.employee_id === joseph.id);
  assert.deepEqual([j.days_worked, j.basic, j.gross, j.nssf_employee, j.paye, j.net], [16, 309677, 309677, 15484, 7468, 286725]); // joined 16 Oct
  const c = r.lines.find((l) => l.employee_id === charles.id);
  assert.deepEqual([c.days_worked, c.basic, c.paye], [20, 1290323, 289097]); // left 20 Oct
  // approval by someone other than the preparer; no edits after approval
  assert.equal((await hro.post(`/api/hr/payroll/${run.id}/approve`)).status, 403);
  assert.equal((await hro.post(`/api/hr/payroll/${run.id}/post`)).status, 409);
  ok(await mgr.post(`/api/hr/payroll/${run.id}/approve`));
  assert.equal((await hro.put(`/api/hr/payroll/${run.id}/lines/${agnes.id}`, { overtime_hours: 1 })).status, 409);
  // draft payslips are not visible to staff
  assert.equal((await staff.get(`/api/hr/payslip/${run.id}`)).status, 404);
  const t = ok(await acc.post(`/api/hr/payroll/${run.id}/post`));
  assert.equal(t.gross, 1207599 + 309677 + 1290323);
  const jl = await lastJournal();
  assert.deepEqual(jl, [['6000', t.gross, 0], ['6010', t.nssf_employer, 0], ['2400', 0, t.paye], ['2410', 0, t.nssf_employee + t.nssf_employer], ['1250', 0, 100000], ['2420', 0, t.net]]);
  ok(await acc.post(`/api/hr/payroll/${run.id}/pay`, { paid_from: '1030' }));
  assert.deepEqual(await lastJournal(), [['2420', t.net, 0], ['1030', 0, t.net]]);
  const adv = ok(await hro.get('/api/hr/advances'));
  assert.equal(adv[0].recovered, 100000);
  assert.equal((await hro.post(`/api/hr/payroll/${run.id}/void`)).status, 409); // posted payroll cannot be deleted
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
  // department wage cost
  assert.equal(r.departments.find((d) => d.department === 'Kitchen').gross, 1290323);
});

test('payslips and leavers', async () => {
  const mine = ok(await staff.get(`/api/hr/payslip/${run.id}`));
  assert.equal(mine.net, 782939); assert.equal(mine.first_name, 'Agnes');
  const other = ok(await staff.get(`/api/hr/payslip/${run.id}?employee_id=${joseph.id}`)); // staff only ever see their own
  assert.equal(other.first_name, 'Agnes');
  assert.equal(ok(await hro.get(`/api/hr/payslip/${run.id}?employee_id=${joseph.id}`)).first_name, 'Joseph');
  assert.equal(ok(await staff.get('/api/hr/me')).payslips.length, 1);
  // a leaver's sign-in is switched off
  ok(await hro.post(`/api/hr/employees/${agnes.id}/leave-company`, { end_date: '2026-11-30', reason: 'Contract ended' }));
  assert.equal((await staff.get('/api/hr/me')).status, 401);
});
