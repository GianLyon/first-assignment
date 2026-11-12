// Phase 5: accounting & finance (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, roomId, book, DAY0 } from './helpers.js';

let admin, acc, fd, mgr, store, guest, company, stay;
const lastJournal = async () => ok(await admin.get('/api/accounts/journal?limit=1'))[0].lines.map((l) => [l.account, l.debit, l.credit]);

before(async () => {
  await startTestServer({ inventory: true, distribution: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['accounts1', 'accountant'], ['frontdesk', 'front_office'], ['manager1', 'manager'], ['store1', 'storekeeper']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  acc = client(); await acc.login('accounts1', 'password-123');
  fd = client(); await fd.login('frontdesk', 'password-123');
  mgr = client(); await mgr.login('manager1', 'password-123');
  store = client(); await store.login('store1', 'password-123');
  guest = client();
});
after(stopTestServer);

test('permissions', async () => {
  assert.equal((await fd.get('/api/finance/pl')).status, 403);
  ok(await mgr.get('/api/finance/pl'));
  assert.equal((await mgr.post('/api/finance/expenses', {})).status, 403);
  ok(await fd.get('/api/finance/companies')); // front desk picks companies when billing a stay
});

test('company accounts: credit limits, invoices with extra charges, receipts and aging', async () => {
  stay = ok(await book(fd, await typeId(fd, 'DLX'), DAY0, '2026-11-12', 'Corporate', { rate: 300000 }));
  ok(await fd.post(`/api/reservations/${stay.id}/check-in`, { room_id: await roomId(fd, '201') }));
  ok(await fd.post(`/api/reservations/${stay.id}/charges`, { description: 'Dinner', department: 'fnb', amount: 118000 }));
  assert.equal((await fd.post(`/api/reservations/${stay.id}/payments`, { method: 'company_account', amount: 118000 })).status, 400); // no company yet
  company = ok(await acc.post('/api/finance/companies', { name: 'Kampala Traders Ltd', tin: '1000123456', credit_limit: 500000, terms_days: 30, email: 'accounts@kt.example' }));
  ok(await fd.post(`/api/reservations/${stay.id}/payments`, { method: 'company_account', amount: 118000, company_id: company.id }));
  assert.equal((await fd.post(`/api/reservations/${stay.id}/payments`, { method: 'company_account', amount: 400000, company_id: company.id })).status, 409); // over limit
  let ca = ok(await acc.get(`/api/finance/companies/${company.id}`));
  assert.equal(ca.unbilled.length, 1); assert.equal(ca.balance, 118000);
  // invoice: the stay + a meeting room hire billed directly
  const inv = ok(await acc.post('/api/finance/invoices', { company_id: company.id, payment_ids: [ca.unbilled[0].id], extra_lines: [{ department: 'events', description: 'Boardroom hire, 10 Nov', amount: 236000 }] }));
  assert.match(inv.number, /^INV\d+$/); assert.equal(inv.total, 354000); assert.equal(inv.due_date, '2026-12-10');
  assert.deepEqual(await lastJournal(), [['1200', 236000, 0], ['4300', 0, 200000], ['2100', 0, 36000]]);
  assert.equal((await acc.post('/api/finance/invoices', { company_id: company.id, payment_ids: [ca.unbilled[0].id] })).status, 400); // already invoiced
  // part payment by bank transfer
  assert.equal((await acc.post('/api/finance/receipts', { company_id: company.id, account_code: '1030', amount: 100000, allocations: [{ invoice_id: inv.id, amount: 200000 }] })).status, 400);
  ok(await acc.post('/api/finance/receipts', { company_id: company.id, account_code: '1030', amount: 100000, reference: 'EFT 5521', allocations: [{ invoice_id: inv.id, amount: 100000 }] }));
  assert.deepEqual(await lastJournal(), [['1030', 100000, 0], ['1200', 0, 100000]]);
  const full = ok(await acc.get(`/api/finance/invoices/${inv.id}`));
  assert.equal(full.balance, 254000); assert.equal(full.lines.length, 2);
  assert.equal((await acc.post(`/api/finance/invoices/${inv.id}/void`, { reason: 'x' })).status, 409); // has a payment
  const aging = ok(await acc.get('/api/finance/ar-aging'));
  const row = aging.rows.find((r) => r.name === 'Kampala Traders Ltd');
  assert.equal(row.current, 254000); assert.equal(row.total, 254000);
  ca = ok(await acc.get(`/api/finance/companies/${company.id}`));
  assert.equal(ca.balance, 254000);
});

let sup, grn;
test('supplier bills (deliveries and expenses with input VAT) and supplier payments', async () => {
  const S = ok(await store.get('/api/inventory/setup'));
  sup = S.suppliers[0];
  grn = ok(await store.post('/api/inventory/receipts', { supplier_id: sup.id, store_id: S.stores[0].id, invoice_ref: 'KF-889', lines: [{ item_id: S.items.find((i) => i.code === 'RICE').id, qty: 20, unit_cost: 4500 }] }));
  const before = ok(await acc.get(`/api/finance/suppliers/${sup.id}`));
  assert.equal(before.unbilled_grns.length, 1); assert.equal(before.balance, 90000);
  const bill = ok(await acc.post('/api/finance/bills', { supplier_id: sup.id, bill_number: 'KF-889', kind: 'stock', grn_ids: [grn.id] }));
  assert.equal(bill.total, 90000);
  assert.equal((await acc.post('/api/finance/bills', { supplier_id: sup.id, bill_number: 'KF-890', kind: 'stock', grn_ids: [grn.id] })).status, 400); // already billed
  assert.equal((await acc.post('/api/finance/bills', { supplier_id: sup.id, bill_number: 'KF-889', kind: 'expense', lines: [{ account_code: '6100', description: 'x', amount: 1 }] })).status, 409); // duplicate number
  // electricity bill with input VAT
  const power = ok(await acc.post('/api/finance/bills', { supplier_id: sup.id, bill_number: 'UMEME-11', kind: 'expense', lines: [{ account_code: '6100', description: 'Electricity October', amount: 100000, vat: 18000 }] }));
  assert.equal(power.total, 118000);
  assert.deepEqual(await lastJournal(), [['6100', 100000, 0], ['2100', 18000, 0], ['2000', 0, 118000]]);
  assert.equal((await acc.post('/api/finance/bills', { supplier_id: sup.id, bill_number: 'BAD', kind: 'expense', lines: [{ account_code: '1200', description: 'x', amount: 1 }] })).status, 400); // control account
  ok(await acc.post('/api/finance/supplier-payments', { supplier_id: sup.id, account_code: '1030', amount: 208000, reference: 'CHQ 0012', allocations: [{ bill_id: bill.id, amount: 90000 }, { bill_id: power.id, amount: 118000 }] }));
  assert.deepEqual(await lastJournal(), [['2000', 208000, 0], ['1030', 0, 208000]]);
  const after2 = ok(await acc.get(`/api/finance/suppliers/${sup.id}`));
  assert.equal(after2.balance, 0);
  assert.ok(!ok(await acc.get('/api/finance/ap-aging')).rows.some((r) => r.id === sup.id));
});

test('expenses, VAT payments and transfers between accounts', async () => {
  ok(await acc.post('/api/finance/expenses', { account_code: '6500', paid_from: '1000', amount: 50000, payee: 'Total petrol station', description: 'Shuttle fuel' }));
  assert.deepEqual(await lastJournal(), [['6500', 50000, 0], ['1000', 0, 50000]]);
  assert.equal((await acc.post('/api/finance/expenses', { account_code: '2000', paid_from: '1000', amount: 1, payee: 'x', description: 'x' })).status, 400);
  assert.equal((await acc.post('/api/finance/expenses', { account_code: '6500', paid_from: '6100', amount: 1, payee: 'x', description: 'x' })).status, 400); // not a cash account
  // card takings settle into the bank, less the bank's fee
  ok(await acc.post('/api/finance/transfers', { from_account: '1010', to_account: '1030', amount: 100000, fee: 3000, description: 'Card settlement' }));
  assert.deepEqual(await lastJournal(), [['1030', 97000, 0], ['5800', 3000, 0], ['1010', 0, 100000]]);
  assert.equal((await acc.post('/api/finance/transfers', { from_account: '1030', to_account: '1030', amount: 5 })).status, 400);
});

test('chart of accounts, manual journals and closing the books', async () => {
  ok(await acc.post('/api/finance/accounts', { code: '6700', name: 'Staff welfare', type: 'expense' }));
  assert.equal((await acc.post('/api/finance/accounts', { code: '1700', name: 'Wrong', type: 'expense' })).status, 400);
  ok(await acc.post('/api/finance/accounts', { code: '1040', name: 'Stanbic bank', type: 'asset', is_cash: true }));
  assert.equal((await acc.post('/api/finance/journals', { description: 'x', lines: [{ account_code: '1030', debit: 10 }, { account_code: '3000', credit: 9 }] })).status, 400);
  assert.equal((await acc.post('/api/finance/journals', { description: 'x', lines: [{ account_code: '1200', debit: 10 }, { account_code: '3000', credit: 10 }] })).status, 400);
  ok(await acc.post('/api/finance/journals', { description: 'Owner capital injection', lines: [{ account_code: '1040', debit: 5000000 }, { account_code: '3000', credit: 5000000 }] }));
  // run a night so there is a closed day, then lock it
  ok(await admin.post('/api/night-audit'));
  assert.equal((await acc.put('/api/finance/lock', { until: '2026-11-11' })).status, 400); // not before business date
  ok(await acc.put('/api/finance/lock', { until: DAY0 }));
  const late = await acc.post('/api/finance/journals', { date: DAY0, description: 'Backdated', lines: [{ account_code: '6700', debit: 100 }, { account_code: '1000', credit: 100 }] });
  assert.equal(late.status, 409); assert.match(late.data.error, /closed up to 2026-11-10/);
  assert.equal((await acc.put('/api/finance/lock', { until: null })).status, 403); // only an administrator reopens
  ok(await admin.put('/api/finance/lock', { until: null }));
});

test('statements: P&L, balance sheet, ledger and VAT', async () => {
  const pl = ok(await acc.get('/api/finance/pl?from=2026-11-01&to=2026-11-30'));
  assert.ok(pl.total_revenue > 0);
  assert.equal(pl.revenue.find((r) => r.code === '4300').amount, 200000);
  assert.equal(pl.expenses.find((r) => r.code === '6100').amount, 100000);
  assert.equal(pl.net_profit, pl.total_revenue - pl.total_cost_of_sales - pl.total_expenses);
  const bs = ok(await acc.get('/api/finance/balance-sheet?to=2026-11-11'));
  assert.equal(bs.balanced, true, JSON.stringify({ a: bs.total_assets, l: bs.total_liabilities, e: bs.total_equity }));
  const gl = ok(await acc.get('/api/finance/ledger/1030?from=2026-11-01&to=2026-11-30'));
  assert.equal(gl.closing, 100000 - 208000 + 97000);
  assert.equal(gl.lines.at(-1).balance, gl.closing);
  const vat = ok(await acc.get('/api/finance/vat?from=2026-11-01&to=2026-11-30'));
  assert.equal(vat.input_vat, 18000);
  assert.ok(vat.output_vat >= 36000 + 18000); // events + dinner (+ room nights)
  assert.equal(vat.net_vat, vat.output_vat - vat.input_vat);
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
});

test('bank reconciliation', async () => {
  const rec = ok(await acc.post('/api/finance/reconciliations', { account_code: '1030', statement_date: '2026-11-11', statement_balance: 100000 - 208000 }));
  assert.equal((await acc.post('/api/finance/reconciliations', { account_code: '1030', statement_date: '2026-11-11', statement_balance: 0 })).status, 409);
  let r = ok(await acc.get(`/api/finance/reconciliations/${rec.id}`));
  assert.equal(r.items.length, 3);
  const receipt = r.items.find((i) => i.debit === 100000), chq = r.items.find((i) => i.credit === 208000);
  r = ok(await acc.put(`/api/finance/reconciliations/${rec.id}/lines`, { line_ids: [receipt.id], cleared: true }));
  assert.equal(r.difference, -208000);
  assert.equal((await acc.post(`/api/finance/reconciliations/${rec.id}/finish`)).status, 409);
  r = ok(await acc.put(`/api/finance/reconciliations/${rec.id}/lines`, { line_ids: [chq.id], cleared: true }));
  assert.equal(r.difference, 0);
  ok(await acc.post(`/api/finance/reconciliations/${rec.id}/finish`));
  // the card settlement (not on this statement) is left for next time
  const next = ok(await acc.post('/api/finance/reconciliations', { account_code: '1030', statement_date: '2026-11-11', statement_balance: 100000 - 208000 + 97000 }));
  const n = ok(await acc.get(`/api/finance/reconciliations/${next.id}`));
  assert.equal(n.items.length, 1); assert.equal(n.opening_cleared, -108000);
});

test('OTA commission is accrued each night for channel bookings', async () => {
  const sim = ok(await admin.get('/api/distribution/channels')).channels.find((c) => c.code === 'simulator');
  const s = ok(await admin.get('/api/settings'));
  const t = ok(await admin.post(`/api/distribution/channels/${sim.id}/test-booking`, { arrival: s.business_date, departure: '2026-11-14', room_code: 'STD', rate_code: 'BAR' }));
  const res = ok(await fd.get('/api/reservations?view=arrivals')).find((x) => x.code === t.reservation_code);
  ok(await fd.post(`/api/reservations/${res.id}/check-in`, { room_id: await roomId(fd, '105') }));
  ok(await admin.post('/api/night-audit'));
  const j = ok(await admin.get('/api/accounts/journal?limit=50'));
  const comm = j.find((e) => /commission 15%/.test(e.description));
  assert.ok(comm, 'commission entry');
  assert.deepEqual(comm.lines.map((l) => [l.account, l.debit, l.credit]), [['5300', 37500, 0], ['2300', 0, 37500]]); // 15% of 250,000
});

test('online prepayment through the test checkout', async () => {
  const s = ok(await admin.get('/api/settings'));
  const nrf = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-01', departure: '2026-12-03', adults: 1, room_type_id: 1, rate_plan_id: 2, guest: { first_name: 'Lea', last_name: 'Ross', email: 'lea@example.com', phone: '1' } }));
  assert.equal((await guest.post('/api/public/bookings/pay', { code: nrf.code, email: 'lea@example.com' })).status, 403); // switched off
  assert.equal((await guest.post('/api/public/pay/test', { token: 'x', outcome: 'paid' })).status, 403);
  assert.equal((await acc.put('/api/finance/online-payments', { enabled: true, provider: 'simulator' })).status, 403);
  ok(await admin.put('/api/finance/online-payments', { enabled: true, provider: 'simulator' }));
  assert.equal(ok(await guest.get('/api/public/info')).online_payments, true);
  assert.equal((await guest.post('/api/public/bookings/pay', { code: nrf.code, email: 'wrong@example.com' })).status, 404);
  const start = ok(await guest.post('/api/public/bookings/pay', { code: nrf.code, email: 'lea@example.com' }));
  assert.equal(start.amount, 450000); assert.equal(start.full, true); // non-refundable: pay in full
  const token = new URL(start.checkout_url, 'http://x').searchParams.get('t');
  assert.equal(ok(await guest.get(`/api/public/pay/${token}`)).amount, 450000);
  const done = ok(await guest.post('/api/public/pay/test', { token, outcome: 'paid', method: 'mobile_money' }));
  assert.equal(done.status, 'paid');
  assert.equal(ok(await guest.post('/api/public/pay/test', { token, outcome: 'paid' })).already, true); // repeat changes nothing
  const res = ok(await fd.get('/api/reservations?view=upcoming')).find((x) => x.code === nrf.code);
  assert.equal(res.balance, -450000); // prepaid
  assert.equal((await guest.post('/api/public/bookings/pay', { code: nrf.code, email: 'lea@example.com' })).status, 409); // nothing more due
  // flexible rate: deposit = first night
  const flex = ok(await guest.post('/api/public/bookings', { arrival: '2026-12-05', departure: '2026-12-08', adults: 1, room_type_id: 1, rate_plan_id: 1, guest: { first_name: 'Tim', last_name: 'Ng', email: 'tim@example.com', phone: '1' } }));
  const dep = ok(await guest.post('/api/public/bookings/pay', { code: flex.code, email: 'tim@example.com' }));
  assert.equal(dep.amount, 250000); assert.equal(dep.full, false);
  const t2 = new URL(dep.checkout_url, 'http://x').searchParams.get('t');
  assert.equal(ok(await guest.post('/api/public/pay/test', { token: t2, outcome: 'failed' })).status, 'failed');
  void s;
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
});
