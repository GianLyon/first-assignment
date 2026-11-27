// Phase 23: fuller HR. Staff records, documents, holidays and leave types, discipline, appraisals, alerts,
// attendance summaries, Local Service Tax, service charge, staff loans and payment files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok } from './helpers.js';
import { lstAnnual } from '../src/services/hr.js';

let admin, hro, mgr, acc, staff, waiter, ann, ben;
const users = {};

before(async () => {
  await startTestServer({ hr: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['hrofficer', 'hr_officer'], ['manager1', 'manager'], ['accounts1', 'accountant'], ['ann', 'front_office'], ['waiter1', 'waiter']]) {
    users[username] = ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  hro = client(); await hro.login('hrofficer', 'password-123');
  mgr = client(); await mgr.login('manager1', 'password-123');
  acc = client(); await acc.login('accounts1', 'password-123');
  staff = client(); await staff.login('ann', 'password-123');
  waiter = client(); await waiter.login('waiter1', 'password-123');
});
after(stopTestServer);

test('LST bands', () => {
  assert.deepEqual([100000, 150000, 250000, 350000, 450000, 999999, 1000001].map(lstAnnual), [0, 5000, 10000, 20000, 30000, 90000, 100000]);
});

test('staff records: contract, probation, next of kin, documents; alerts', async () => {
  const base = { department: 'Front Office', job_title: 'Receptionist', pay_method: 'mobile_money', momo_number: '0772000111' };
  // business date in tests is 2026-11-10
  ann = ok(await hro.post('/api/hr/employees', { ...base, first_name: 'Ann', last_name: 'Akello', start_date: '2026-06-01', basic_salary: 800000, user_id: users.ann.id,
    probation_end: '2026-11-15', contract_end: '2026-12-01', id_expiry: '2026-11-20', next_of_kin_name: 'Peter Okello', next_of_kin_relation: 'Brother', next_of_kin_phone: '0700111222',
    emergency_name: 'Mary', emergency_phone: '0700333444', address: 'Ntinda', marital_status: 'single', leave_carry_forward: 4, date_of_birth: '1995-11-12' }));
  ben = ok(await hro.post('/api/hr/employees', { ...base, first_name: 'Ben', last_name: 'Mugisha', department: 'Bar', job_title: 'Barman', start_date: '2026-01-01', basic_salary: 400000, service_charge_share: true, lst_exempt: false }));
  assert.equal((await hro.post('/api/hr/employees', { ...base, first_name: 'Bad', last_name: 'Dates', start_date: '2026-06-01', basic_salary: 1, contract_end: '2026-01-01' })).status, 400);
  const e = ok(await hro.get(`/api/hr/employees/${ann.id}`));
  assert.equal(e.employee.next_of_kin_name, 'Peter Okello');
  assert.equal(e.leave_balance.entitlement, 25); // 21 + 4 carried forward

  // documents: a small PDF; only HR can upload; front desk cannot read
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64');
  assert.equal((await staff.post(`/api/hr/employees/${ann.id}/documents`, { kind: 'cv', file: pdf })).status, 403);
  assert.equal((await hro.post(`/api/hr/employees/${ann.id}/documents`, { kind: 'cv', file: 'data:text/html;base64,PGI+' })).status, 400);
  const doc = ok(await hro.post(`/api/hr/employees/${ann.id}/documents`, { kind: 'contract', title: 'Contract 2026', file: pdf, filename: 'contract.pdf', expires_on: '2026-12-01' }));
  const raw = await hro.raw(`/api/hr/documents/${doc.id}`);
  assert.equal(raw.status, 200); assert.equal(raw.headers.get('content-type'), 'application/pdf'); assert.equal(await raw.text(), '%PDF-1.4 test');
  assert.equal((await staff.raw(`/api/hr/documents/${doc.id}`)).status, 403);
  assert.equal(ok(await hro.get(`/api/hr/employees/${ann.id}`)).documents.length, 1);
  // a bigger upload is accepted (over the normal 1 MB request limit)
  const big = 'data:image/png;base64,' + Buffer.alloc(1_500_000, 1).toString('base64');
  ok(await hro.post(`/api/hr/employees/${ann.id}/documents`, { kind: 'national_id', file: big }));

  const a = ok(await hro.get('/api/hr/alerts'));
  const kinds = a.alerts.filter((x) => x.id === ann.id).map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['birthday', 'contract', 'document', 'id', 'probation']);
  assert.equal((await waiter.get('/api/hr/alerts')).status, 403);
});

test('public holidays are not counted as leave; leave types with a yearly cap', async () => {
  // 24–28 Dec includes Christmas and Boxing Day
  const l = ok(await hro.post('/api/hr/leave', { employee_id: ann.id, type: 'annual', from_date: '2026-12-24', to_date: '2026-12-28' }));
  assert.equal(l.days, 3);
  ok(await hro.put('/api/hr/holidays', { date: '2026-11-20', name: 'Test holiday' }));
  assert.ok(ok(await hro.get('/api/hr/setup')).holidays.some((h) => h.date === '2026-11-20'));
  // a new leave type limited to 3 days a year
  const t = ok(await hro.post('/api/hr/leave-types', { name: 'Study leave', paid: true, max_days_year: 3 }));
  assert.equal(t.code, 'study_leave');
  ok(await hro.post('/api/hr/leave', { employee_id: ben.id, type: 'study_leave', from_date: '2026-11-11', to_date: '2026-11-12' }));
  const over = await hro.post('/api/hr/leave', { employee_id: ben.id, type: 'study_leave', from_date: '2026-11-25', to_date: '2026-11-26' });
  assert.equal(over.status, 409); assert.match(over.data.error, /1 left/);
  ok(await hro.put('/api/hr/leave-types/study_leave', { name: 'Study leave', paid: true, max_days_year: 3, active: false }));
  assert.equal((await hro.post('/api/hr/leave', { employee_id: ben.id, type: 'study_leave', from_date: '2026-11-27', to_date: '2026-11-27' })).status, 400);
});

test('discipline and appraisals, with the employee signing off', async () => {
  const c = ok(await hro.post('/api/hr/cases', { employee_id: ben.id, case_date: '2026-11-09', kind: 'written_warning', subject: 'Cash short at close of shift', details: 'UGX 50,000 short' }));
  assert.equal(String(c.expires_on).slice(0, 10), '2027-11-09'); // written warnings count for 12 months
  assert.equal(ok(await hro.get('/api/hr/cases')).length, 1);
  ok(await hro.put(`/api/hr/cases/${c.id}`, { case_date: '2026-11-09', kind: 'written_warning', subject: 'Cash short at close of shift', action_taken: 'Repaid', status: 'closed', expires_on: '2027-11-09' }));
  assert.equal((await staff.post('/api/hr/cases', { employee_id: ben.id, case_date: '2026-11-09', kind: 'other', subject: 'x' })).status, 403);

  // a manager appraises Ann, shares it; Ann reads and signs it off
  const ap = ok(await mgr.post('/api/hr/appraisals', { employee_id: ann.id, period: 'Probation review', review_date: '2026-11-10', scores: { quality: 4, guest_service: 5, teamwork: 3 }, strengths: 'Warm with guests', recommendation: 'confirm' }));
  assert.equal(Number(ap.overall), 4);
  assert.equal((await mgr.post('/api/hr/appraisals', { employee_id: ann.id, period: 'x', review_date: '2026-11-10', scores: { quality: 7 } })).status, 400);
  assert.equal(ok(await staff.get('/api/hr/me')).appraisals.length, 0); // drafts are not shown
  assert.equal((await staff.post(`/api/hr/me/appraisals/${ap.id}/acknowledge`, {})).status, 409);
  ok(await mgr.put(`/api/hr/appraisals/${ap.id}`, { period: 'Probation review', review_date: '2026-11-10', scores: { quality: 4, guest_service: 5, teamwork: 3 }, status: 'shared' }));
  assert.equal(ok(await staff.get('/api/hr/me')).appraisals.length, 1);
  ok(await staff.post(`/api/hr/me/appraisals/${ap.id}/acknowledge`, { comment: 'Thank you' }));
  assert.equal((await mgr.put(`/api/hr/appraisals/${ap.id}`, { period: 'x', review_date: '2026-11-10' })).status, 409); // signed off: locked
  assert.equal(ok(await hro.get(`/api/hr/employees/${ann.id}`)).appraisals[0].employee_comment, 'Thank you');
});

test('attendance month summary: late, absent, overtime beyond the shift', async () => {
  const setup = ok(await hro.get('/api/hr/setup'));
  const day = setup.shifts[0]; // seeded shifts
  ok(await hro.put('/api/hr/roster', { entries: [{ employee_id: ben.id, date: '2026-11-02', shift_id: day.id }, { employee_id: ben.id, date: '2026-11-03', shift_id: day.id }, { employee_id: ben.id, date: '2026-11-04', shift_id: day.id }] }));
  const [h, m] = day.start_time.split(':').map(Number);
  const t = (hh, mm) => `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const [eh] = day.end_time.split(':').map(Number);
  ok(await hro.post('/api/hr/attendance', { employee_id: ben.id, date: '2026-11-02', clock_in: t(h, m), clock_out: t(eh + 2, 0) })); // 2 h over
  ok(await hro.post('/api/hr/attendance', { employee_id: ben.id, date: '2026-11-03', clock_in: t(h, m + 30), clock_out: t(eh, 0) })); // late
  // 4 Nov: rostered, no clock-in → absent
  const s = ok(await hro.get('/api/hr/attendance-month?period=2026-11')).employees.find((x) => x.id === ben.id);
  assert.deepEqual([s.rostered, s.present, s.late, s.absent, s.overtime], [3, 2, 1, 1, 2]);
});

test('payroll: service charge shared by days paid, LST only July–October, loans, payment files', async () => {
  ok(await acc.post('/api/hr/advances', { employee_id: ben.id, kind: 'loan', amount: 300000, monthly_recovery: 100000, paid_from: '1000', reason: 'School fees' }));
  const run = ok(await hro.post('/api/hr/payroll', { period: '2026-10', service_charge: 300000 }));
  let r = ok(await hro.get(`/api/hr/payroll/${run.id}`));
  const ann1 = r.lines.find((l) => l.employee_id === ann.id), ben1 = r.lines.find((l) => l.employee_id === ben.id);
  assert.equal(ann1.service_charge + ben1.service_charge, 300000);
  assert.equal(ann1.service_charge, 150000); // both worked all 31 days
  assert.equal(ben1.lst, Math.round(lstAnnual(ben1.gross) / 4));
  assert.equal(ben1.advance_recovery, 100000);
  assert.equal(r.totals.service_charge, 300000);
  // the pool can be changed while in draft; Ann stops sharing → Ben gets it all
  ok(await hro.put(`/api/hr/employees/${ann.id}`, { ...ok(await hro.get(`/api/hr/employees/${ann.id}`)).employee, start_date: '2026-06-01', service_charge_share: false }));
  ok(await hro.post(`/api/hr/payroll/${run.id}/refresh`));
  ok(await hro.put(`/api/hr/payroll/${run.id}/service-charge`, { amount: 200000 }));
  r = ok(await hro.get(`/api/hr/payroll/${run.id}`));
  assert.equal(r.lines.find((l) => l.employee_id === ben.id).service_charge, 200000);
  assert.equal(r.lines.find((l) => l.employee_id === ann.id).service_charge, 0);
  // payment file
  const f = await hro.raw(`/api/hr/payroll/${run.id}/file?method=mobile_money`);
  assert.equal(f.status, 200);
  const csv = await f.text();
  assert.match(csv, /^"Employee no","Name","Mobile number","Amount \(UGX\)","Reference"/);
  assert.match(csv, /"Ben Mugisha","0772000111"/);
  // November: no LST
  const nov = ok(await hro.post('/api/hr/payroll', { period: '2026-11' }));
  assert.ok(ok(await hro.get(`/api/hr/payroll/${nov.id}`)).lines.every((l) => l.lst === 0));
  // post October: LST goes to 2440
  ok(await mgr.post(`/api/hr/payroll/${run.id}/approve`));
  const t = ok(await acc.post(`/api/hr/payroll/${run.id}/post`));
  assert.ok(t.lst > 0);
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
  // payslip shows LST and service charge
  const slip = ok(await hro.get(`/api/hr/payslip/${run.id}?employee_id=${ben.id}`));
  assert.equal(slip.service_charge, 200000); assert.ok(slip.lst > 0);
});
