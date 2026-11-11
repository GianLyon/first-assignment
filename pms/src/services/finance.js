// Phase 5: Accounting & finance — receivables, payables, expenses, transfers, chart of accounts,
// manual journals, books lock, financial statements, VAT summary and bank reconciliation.
import { HttpError, audit } from '../auth.js';
import { postJournal, vatPortion, REVENUE } from '../ledger.js';
import { getSettings } from './frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const money = (v, field = 'Amount') => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} must be a whole number of shillings above zero.`); return n; };
const money0 = (v, field) => { const n = Number(v || 0); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a whole number of shillings.`); return n; };
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
/** Ledgers kept by the system itself: never posted to by hand. */
export const CONTROL = ['1100', '1200', '1300', '2000'];
const AR = '1200', AP = '2000', VAT = '2100', BANK_CHARGES = '5800';

async function account(db, code, { cash = false, types = null } = {}) {
  const { rows: [a] } = await db.query('SELECT * FROM accounts WHERE code=$1 AND active', [String(code || '')]);
  if (!a) throw new HttpError(400, 'Choose an account.');
  if (cash && !a.is_cash) throw new HttpError(400, `${a.name} is not a cash, bank or mobile money account.`);
  if (types && !types.includes(a.type)) throw new HttpError(400, `${a.name} cannot be used here.`);
  return a;
}
async function bizDate(db, d) {
  const s = await getSettings(db);
  if (d == null || d === '') return s.business_date;
  if (!isDate(d)) throw new HttpError(400, 'Invalid date.');
  if (d > s.business_date) throw new HttpError(400, 'The date cannot be after the current business date.');
  return d;
}

/* =============== companies & receivables =============== */
export async function saveCompany(db, user, id, b) {
  const vals = [text(b.name, 'Name', { required: true, max: 120 }), text(b.tin, 'TIN', { max: 30 }), text(b.contact, 'Contact', { max: 80 }), text(b.phone, 'Phone', { max: 40 }),
    text(b.email, 'Email', { max: 120 }), text(b.address, 'Address', { max: 300 }), money0(b.credit_limit, 'Credit limit'), Math.min(180, Math.max(0, Number(b.terms_days ?? 30) || 0))];
  let c;
  if (id) ({ rows: [c] } = await db.query('UPDATE companies SET name=$2, tin=$3, contact=$4, phone=$5, email=$6, address=$7, credit_limit=$8, terms_days=$9, active=$10 WHERE id=$1 RETURNING *', [id, ...vals, b.active !== false]));
  else ({ rows: [c] } = await db.query('INSERT INTO companies (name, tin, contact, phone, email, address, credit_limit, terms_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', vals));
  if (!c) throw new HttpError(404, 'Company not found.');
  await audit(db, user, id ? 'finance.company_update' : 'finance.company_create', 'company', c.id, { name: c.name, credit_limit: c.credit_limit });
  return c;
}

/** Guest bills moved to a company account that are not on an invoice yet. */
export async function unbilled(db, companyId) {
  const { rows } = await db.query(
    `SELECT p.id, p.amount, p.business_date, r.code, g.first_name, g.last_name, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure
     FROM payments p JOIN reservations r ON r.id=p.reservation_id JOIN guests g ON g.id=r.guest_id
     WHERE p.company_id=$1 AND p.method='company_account' AND NOT p.voided AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.payment_id=p.id)
     ORDER BY p.business_date, p.id`, [companyId]);
  return rows;
}
const invoiceBalanceSql = `i.total - COALESCE((SELECT SUM(amount) FROM ar_allocations WHERE invoice_id=i.id),0)`;

export async function createInvoice(db, user, b) {
  const s = await getSettings(db);
  const { rows: [co] } = await db.query('SELECT * FROM companies WHERE id=$1', [Number(b.company_id)]);
  if (!co) throw new HttpError(400, 'Choose a company.');
  const ids = [...new Set((b.payment_ids || []).map(Number))];
  const open = await unbilled(db, co.id);
  const picked = ids.map((pid) => { const p = open.find((x) => x.id === pid); if (!p) throw new HttpError(400, 'A selected stay is already invoiced or not on this company account.'); return p; });
  const extra = (b.extra_lines || []).filter((l) => l && (l.description || l.amount)).map((l) => {
    if (!REVENUE[l.department]) throw new HttpError(400, 'Choose a department for each extra charge.');
    return { department: l.department, description: text(l.description, 'Description', { required: true, max: 200 }), amount: money(l.amount) };
  });
  if (!picked.length && !extra.length) throw new HttpError(400, 'Add at least one stay or charge to the invoice.');
  const total = picked.reduce((a, p) => a + p.amount, 0) + extra.reduce((a, l) => a + l.amount, 0);
  const date = s.business_date;
  const { rows: [inv] } = await db.query('INSERT INTO invoices (company_id, invoice_date, due_date, total, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [co.id, date, addDays(date, co.terms_days), total, text(b.notes, 'Notes', { max: 500 }), user.id]);
  for (const p of picked) await db.query('INSERT INTO invoice_lines (invoice_id, payment_id, description, amount) VALUES ($1,$2,$3,$4)', [inv.id, p.id, `Stay ${p.code}: ${p.first_name} ${p.last_name}, ${p.arrival} to ${p.departure}`, p.amount]);
  for (const l of extra) await db.query('INSERT INTO invoice_lines (invoice_id, department, description, amount) VALUES ($1,$2,$3,$4)', [inv.id, l.department, l.description, l.amount]);
  if (extra.length) {
    // extra charges billed straight to the company: Dr receivable, Cr revenue (net) and VAT
    const lines = [{ account: AR, debit: extra.reduce((a, l) => a + l.amount, 0) }];
    let vatTotal = 0;
    for (const l of extra) { const v = vatPortion(l.amount, s.vat_rate); vatTotal += v; lines.push({ account: REVENUE[l.department], credit: l.amount - v }); }
    lines.push({ account: VAT, credit: vatTotal });
    const merged = Object.values(lines.reduce((m, l) => { const k = l.account + (l.debit ? 'd' : 'c'); m[k] = m[k] ? { ...m[k], debit: (m[k].debit || 0) + (l.debit || 0), credit: (m[k].credit || 0) + (l.credit || 0) } : { ...l }; return m; }, {}));
    const entry = await postJournal(db, { date, description: `${inv.number} ${co.name}: charges`, refType: 'invoice', refId: inv.id, userId: user.id, lines: merged });
    await db.query('UPDATE invoices SET journal_entry_id=$2 WHERE id=$1', [inv.id, entry]);
  }
  await audit(db, user, 'finance.invoice_create', 'invoice', inv.id, { number: inv.number, company: co.name, total });
  return inv;
}

export async function voidInvoice(db, user, id, reason) {
  const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id]);
  if (!inv || inv.status !== 'issued') throw new HttpError(409, 'Only issued invoices can be voided.');
  const { rows: [al] } = await db.query('SELECT count(*)::int AS n FROM ar_allocations WHERE invoice_id=$1', [id]);
  if (al.n) throw new HttpError(409, 'Payments are allocated to this invoice. Remove them first.');
  const { rows: [ev] } = await db.query('SELECT code FROM events WHERE invoice_id=$1', [id]);
  if (ev) throw new HttpError(409, `This invoice is the final bill for event ${ev.code} and cannot be voided. Issue a credit through a manual journal instead.`);
  const why = text(reason, 'Reason', { required: true, max: 300 });
  const s = await getSettings(db);
  if (inv.journal_entry_id) {
    const { rows } = await db.query('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=$1', [inv.journal_entry_id]);
    await postJournal(db, { date: s.business_date, description: `VOID ${inv.number}`, refType: 'invoice_void', refId: inv.id, userId: user.id, lines: rows.map((l) => ({ account: l.account_code, debit: l.credit, credit: l.debit })) });
  }
  await db.query('UPDATE invoice_lines SET payment_id=NULL WHERE invoice_id=$1', [id]); // stays can be invoiced again
  await db.query("UPDATE invoices SET status='void', void_reason=$2 WHERE id=$1", [id, why]);
  await audit(db, user, 'finance.invoice_void', 'invoice', id, { number: inv.number, reason: why });
}

async function allocate(db, table, keyCol, docTable, docId, partyCol, partyId, allocations, available) {
  let used = 0;
  for (const a of allocations || []) {
    const amt = money(a.amount, 'Allocation');
    const { rows: [doc] } = await db.query(`SELECT d.*, d.total - COALESCE((SELECT SUM(amount) FROM ${table} WHERE ${keyCol}=d.id),0) AS open FROM ${docTable} d WHERE d.id=$1 FOR UPDATE`, [Number(a[keyCol])]);
    if (!doc || doc[partyCol] !== partyId) throw new HttpError(400, 'An allocation is for a document of a different account.');
    if (doc.status === 'void') throw new HttpError(400, 'Cannot allocate to a void document.');
    if (amt > Number(doc.open)) throw new HttpError(400, `Allocation is more than the open balance (${Number(doc.open).toLocaleString('en-US')}).`);
    used += amt;
    if (used > available) throw new HttpError(400, 'Allocations add up to more than the payment.');
    await db.query(`INSERT INTO ${table} (${table === 'ar_allocations' ? 'receipt_id' : 'payment_id'}, ${keyCol}, amount) VALUES ($1,$2,$3)
      ON CONFLICT (${table === 'ar_allocations' ? 'receipt_id' : 'payment_id'}, ${keyCol}) DO UPDATE SET amount = ${table}.amount + EXCLUDED.amount`, [docId, doc.id, amt]);
  }
  return used;
}

export async function createReceipt(db, user, b) {
  const { rows: [co] } = await db.query('SELECT * FROM companies WHERE id=$1', [Number(b.company_id)]);
  if (!co) throw new HttpError(400, 'Choose a company.');
  const acct = await account(db, b.account_code, { cash: true });
  const amount = money(b.amount);
  const date = await bizDate(db, b.receipt_date);
  const { rows: [r] } = await db.query('INSERT INTO ar_receipts (company_id, receipt_date, account_code, amount, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [co.id, date, acct.code, amount, text(b.reference, 'Reference', { max: 80 }), user.id]);
  await allocate(db, 'ar_allocations', 'invoice_id', 'invoices', r.id, 'company_id', co.id, b.allocations, amount);
  const entry = await postJournal(db, { date, description: `${r.number} from ${co.name}`, refType: 'receipt', refId: r.id, userId: user.id, lines: [{ account: acct.code, debit: amount }, { account: AR, credit: amount }] });
  await db.query('UPDATE ar_receipts SET journal_entry_id=$2 WHERE id=$1', [r.id, entry]);
  await audit(db, user, 'finance.receipt', 'company', co.id, { number: r.number, amount });
  return r;
}
export async function allocateReceipt(db, user, receiptId, allocations) {
  const { rows: [r] } = await db.query(`SELECT r.*, r.amount - COALESCE((SELECT SUM(amount) FROM ar_allocations WHERE receipt_id=r.id),0) AS unallocated FROM ar_receipts r WHERE id=$1 FOR UPDATE`, [receiptId]);
  if (!r) throw new HttpError(404, 'Receipt not found.');
  await allocate(db, 'ar_allocations', 'invoice_id', 'invoices', r.id, 'company_id', r.company_id, allocations, Number(r.unallocated));
  await audit(db, user, 'finance.receipt_allocate', 'company', r.company_id, { number: r.number });
}

export async function companyAccount(db, companyId) {
  const s = await getSettings(db);
  const { rows: [co] } = await db.query('SELECT * FROM companies WHERE id=$1', [companyId]);
  if (!co) throw new HttpError(404, 'Company not found.');
  const invoices = (await db.query(`SELECT i.*, ${invoiceBalanceSql} AS balance FROM invoices i WHERE company_id=$1 ORDER BY i.invoice_date DESC, i.id DESC`, [co.id])).rows.map((i) => ({ ...i, balance: Number(i.balance) }));
  const receipts = (await db.query(`SELECT r.*, a.name AS account_name, r.amount - COALESCE((SELECT SUM(amount) FROM ar_allocations WHERE receipt_id=r.id),0) AS unallocated FROM ar_receipts r JOIN accounts a ON a.code=r.account_code WHERE company_id=$1 ORDER BY r.receipt_date DESC, r.id DESC`, [co.id])).rows.map((r) => ({ ...r, unallocated: Number(r.unallocated) }));
  const open = await unbilled(db, co.id);
  const owed = invoices.filter((i) => i.status === 'issued').reduce((a, i) => a + i.balance, 0) + open.reduce((a, p) => a + p.amount, 0) - receipts.reduce((a, r) => a + r.unallocated, 0);
  return { company: co, business_date: s.business_date, unbilled: open, invoices, receipts, balance: owed };
}
export async function getInvoice(db, id) {
  const { rows: [inv] } = await db.query(`SELECT i.*, ${invoiceBalanceSql} AS balance, c.name AS company_name, c.tin, c.address, c.email, c.phone FROM invoices i JOIN companies c ON c.id=i.company_id WHERE i.id=$1`, [id]);
  if (!inv) throw new HttpError(404, 'Invoice not found.');
  const lines = (await db.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id', [id])).rows;
  const payments = (await db.query('SELECT r.number, r.receipt_date, a.amount FROM ar_allocations a JOIN ar_receipts r ON r.id=a.receipt_id WHERE a.invoice_id=$1 ORDER BY r.receipt_date', [id])).rows;
  return { ...inv, balance: Number(inv.balance), lines, payments };
}

function bucket(daysOverdue) { return daysOverdue <= 0 ? 'current' : daysOverdue <= 30 ? 'd30' : daysOverdue <= 60 ? 'd60' : daysOverdue <= 90 ? 'd90' : 'over90'; }
export async function arAging(db) {
  const s = await getSettings(db);
  const { rows: cos } = await db.query('SELECT id, name, credit_limit FROM companies ORDER BY name');
  const out = [];
  for (const c of cos) {
    const row = { id: c.id, name: c.name, credit_limit: Number(c.credit_limit), unbilled: 0, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, credits: 0 };
    row.unbilled = (await unbilled(db, c.id)).reduce((a, p) => a + p.amount, 0);
    const { rows: inv } = await db.query(`SELECT to_char(i.due_date,'YYYY-MM-DD') AS due, ${invoiceBalanceSql} AS bal FROM invoices i WHERE company_id=$1 AND status='issued'`, [c.id]);
    for (const i of inv) if (Number(i.bal) > 0) row[bucket(daysBetween(i.due, s.business_date))] += Number(i.bal);
    const { rows: [cr] } = await db.query('SELECT COALESCE(SUM(r.amount - COALESCE((SELECT SUM(amount) FROM ar_allocations WHERE receipt_id=r.id),0)),0) AS c FROM ar_receipts r WHERE company_id=$1', [c.id]);
    row.credits = Number(cr.c);
    row.total = row.unbilled + row.current + row.d30 + row.d60 + row.d90 + row.over90 - row.credits;
    if (row.total || row.unbilled || row.credits) out.push(row);
  }
  return { as_at: s.business_date, rows: out };
}

/* =============== suppliers & payables =============== */
export async function createBill(db, user, b) {
  const s = await getSettings(db);
  const { rows: [sup] } = await db.query('SELECT * FROM suppliers WHERE id=$1', [Number(b.supplier_id)]);
  if (!sup) throw new HttpError(400, 'Choose a supplier.');
  const billNo = text(b.bill_number, "Supplier's invoice number", { required: true, max: 60 });
  const billDate = await bizDate(db, b.bill_date);
  const due = isDate(b.due_date) ? b.due_date : addDays(billDate, 30);
  const kind = b.kind === 'expense' ? 'expense' : 'stock';
  let total = 0, vat = 0, grns = [], lines = [];
  if (kind === 'stock') {
    const ids = [...new Set((b.grn_ids || []).map(Number))];
    if (!ids.length) throw new HttpError(400, 'Choose the deliveries this invoice covers.');
    ({ rows: grns } = await db.query(`SELECT g.* FROM goods_received g WHERE g.id = ANY($1) AND g.supplier_id=$2 AND NOT g.is_opening AND NOT EXISTS (SELECT 1 FROM bill_grns bg WHERE bg.grn_id=g.id) FOR UPDATE`, [ids, sup.id]));
    if (grns.length !== ids.length) throw new HttpError(400, 'A selected delivery is already billed or is from another supplier.');
    total = grns.reduce((a, g) => a + g.total, 0);
    if (b.total != null && Number(b.total) !== total) throw new HttpError(400, `The deliveries add up to UGX ${total.toLocaleString('en-US')}. Enter differences (e.g. price changes) as a separate expense bill or credit.`);
  } else {
    lines = (b.lines || []).filter((l) => l && (l.amount || l.description)).map((l) => ({ account_code: String(l.account_code || ''), description: text(l.description, 'Description', { required: true, max: 200 }), amount: money(l.amount), vat: money0(l.vat, 'VAT') }));
    if (!lines.length) throw new HttpError(400, 'Add at least one line.');
    for (const l of lines) { const a = await account(db, l.account_code, { types: ['expense', 'asset'] }); if (CONTROL.includes(a.code) || a.is_cash) throw new HttpError(400, `${a.name} cannot be used on a bill.`); }
    vat = lines.reduce((a, l) => a + l.vat, 0); total = lines.reduce((a, l) => a + l.amount + l.vat, 0);
  }
  const { rows: [bill] } = await db.query('INSERT INTO supplier_bills (supplier_id, bill_number, bill_date, due_date, kind, total, vat, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [sup.id, billNo, billDate, due, kind, total, vat, text(b.notes, 'Notes', { max: 500 }), user.id]);
  for (const g of grns) await db.query('INSERT INTO bill_grns (bill_id, grn_id) VALUES ($1,$2)', [bill.id, g.id]);
  if (kind === 'expense') {
    for (const l of lines) await db.query('INSERT INTO bill_lines (bill_id, account_code, description, amount, vat) VALUES ($1,$2,$3,$4,$5)', [bill.id, l.account_code, l.description, l.amount, l.vat]);
    const jl = lines.map((l) => ({ account: l.account_code, debit: l.amount }));
    if (vat) jl.push({ account: VAT, debit: vat }); // input VAT reduces what is owed to URA
    jl.push({ account: AP, credit: total });
    const entry = await postJournal(db, { date: billDate, description: `Bill ${billNo} from ${sup.name}`, refType: 'bill', refId: bill.id, userId: user.id, lines: jl });
    await db.query('UPDATE supplier_bills SET journal_entry_id=$2 WHERE id=$1', [bill.id, entry]);
  }
  // stock bills: the deliveries already credited the supplier, so no new posting is needed
  await audit(db, user, 'finance.bill_create', 'supplier', sup.id, { bill: billNo, kind, total, vat });
  return bill;
}
export async function voidBill(db, user, id, reason) {
  const { rows: [bill] } = await db.query('SELECT * FROM supplier_bills WHERE id=$1 FOR UPDATE', [id]);
  if (!bill || bill.status !== 'open') throw new HttpError(409, 'Only open bills can be voided.');
  const { rows: [al] } = await db.query('SELECT count(*)::int AS n FROM ap_allocations WHERE bill_id=$1', [id]);
  if (al.n) throw new HttpError(409, 'Payments are allocated to this bill.');
  const why = text(reason, 'Reason', { required: true, max: 300 });
  if (bill.journal_entry_id) {
    const s = await getSettings(db);
    const { rows } = await db.query('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=$1', [bill.journal_entry_id]);
    await postJournal(db, { date: s.business_date, description: `VOID bill ${bill.bill_number}`, refType: 'bill_void', refId: bill.id, userId: user.id, lines: rows.map((l) => ({ account: l.account_code, debit: l.credit, credit: l.debit })) });
  }
  await db.query('DELETE FROM bill_grns WHERE bill_id=$1', [id]);
  await db.query("UPDATE supplier_bills SET status='void', notes=concat_ws(' · ', notes, $2::text) WHERE id=$1", [id, 'VOID: ' + why]);
  await audit(db, user, 'finance.bill_void', 'supplier', bill.supplier_id, { bill: bill.bill_number, reason: why });
}
export async function supplierPayment(db, user, b) {
  const { rows: [sup] } = await db.query('SELECT * FROM suppliers WHERE id=$1', [Number(b.supplier_id)]);
  if (!sup) throw new HttpError(400, 'Choose a supplier.');
  const acct = await account(db, b.account_code, { cash: true });
  const amount = money(b.amount);
  const date = await bizDate(db, b.payment_date);
  const { rows: [p] } = await db.query('INSERT INTO supplier_payments (supplier_id, payment_date, account_code, amount, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [sup.id, date, acct.code, amount, text(b.reference, 'Reference', { max: 80 }), user.id]);
  await allocate(db, 'ap_allocations', 'bill_id', 'supplier_bills', p.id, 'supplier_id', sup.id, b.allocations, amount);
  const entry = await postJournal(db, { date, description: `${p.number} to ${sup.name}`, refType: 'supplier_payment', refId: p.id, userId: user.id, lines: [{ account: AP, debit: amount }, { account: acct.code, credit: amount }] });
  await db.query('UPDATE supplier_payments SET journal_entry_id=$2 WHERE id=$1', [p.id, entry]);
  await audit(db, user, 'finance.supplier_payment', 'supplier', sup.id, { number: p.number, amount });
  return p;
}
export async function supplierAccount(db, supplierId) {
  const { rows: [sup] } = await db.query('SELECT * FROM suppliers WHERE id=$1', [supplierId]);
  if (!sup) throw new HttpError(404, 'Supplier not found.');
  const bills = (await db.query(`SELECT b.*, b.total - COALESCE((SELECT SUM(amount) FROM ap_allocations WHERE bill_id=b.id),0) AS balance FROM supplier_bills b WHERE supplier_id=$1 ORDER BY bill_date DESC, id DESC`, [sup.id])).rows.map((x) => ({ ...x, balance: Number(x.balance) }));
  const payments = (await db.query(`SELECT p.*, a.name AS account_name, p.amount - COALESCE((SELECT SUM(amount) FROM ap_allocations WHERE payment_id=p.id),0) AS unallocated FROM supplier_payments p JOIN accounts a ON a.code=p.account_code WHERE supplier_id=$1 ORDER BY payment_date DESC, id DESC`, [sup.id])).rows.map((x) => ({ ...x, unallocated: Number(x.unallocated) }));
  const unbilledGrns = (await db.query(`SELECT g.id, g.code, g.business_date, g.total, g.invoice_ref FROM goods_received g WHERE supplier_id=$1 AND NOT is_opening AND NOT EXISTS (SELECT 1 FROM bill_grns bg WHERE bg.grn_id=g.id) ORDER BY g.id`, [sup.id])).rows;
  const balance = bills.filter((x) => x.status === 'open').reduce((a, x) => a + x.balance, 0) + unbilledGrns.reduce((a, g) => a + g.total, 0) - payments.reduce((a, p) => a + p.unallocated, 0);
  return { supplier: sup, bills, payments, unbilled_grns: unbilledGrns, balance };
}
export async function apAging(db) {
  const s = await getSettings(db);
  const { rows: sups } = await db.query('SELECT id, name FROM suppliers ORDER BY name');
  const out = [];
  for (const x of sups) {
    const row = { id: x.id, name: x.name, not_billed: 0, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, credits: 0 };
    row.not_billed = Number((await db.query('SELECT COALESCE(SUM(total),0) AS t FROM goods_received g WHERE supplier_id=$1 AND NOT is_opening AND NOT EXISTS (SELECT 1 FROM bill_grns bg WHERE bg.grn_id=g.id)', [x.id])).rows[0].t);
    const { rows: bills } = await db.query(`SELECT to_char(due_date,'YYYY-MM-DD') AS due, b.total - COALESCE((SELECT SUM(amount) FROM ap_allocations WHERE bill_id=b.id),0) AS bal FROM supplier_bills b WHERE supplier_id=$1 AND status='open'`, [x.id]);
    for (const b of bills) if (Number(b.bal) > 0) row[bucket(daysBetween(b.due, s.business_date))] += Number(b.bal);
    row.credits = Number((await db.query('SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(amount) FROM ap_allocations WHERE payment_id=p.id),0)),0) AS c FROM supplier_payments p WHERE supplier_id=$1', [x.id])).rows[0].c);
    row.total = row.not_billed + row.current + row.d30 + row.d60 + row.d90 + row.over90 - row.credits;
    if (row.total || row.credits) out.push(row);
  }
  return { as_at: s.business_date, rows: out };
}

/* =============== money out, transfers =============== */
export async function recordExpense(db, user, b) {
  const target = await account(db, b.account_code, { types: ['expense', 'liability'] });
  if (CONTROL.includes(target.code)) throw new HttpError(400, `Use supplier payments for ${target.name}.`);
  const from = await account(db, b.paid_from, { cash: true });
  const amount = money(b.amount);
  const vat = target.type === 'expense' ? money0(b.vat, 'VAT') : 0;
  if (vat >= amount) throw new HttpError(400, 'VAT must be less than the amount paid.');
  const date = await bizDate(db, b.expense_date);
  const { rows: [e] } = await db.query('INSERT INTO expenses (expense_date, account_code, paid_from, amount, vat, payee, description, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [date, target.code, from.code, amount, vat, text(b.payee, 'Paid to', { required: true, max: 120 }), text(b.description, 'Description', { required: true, max: 200 }), text(b.reference, 'Reference', { max: 80 }), user.id]);
  const jl = [{ account: target.code, debit: amount - vat }];
  if (vat) jl.push({ account: VAT, debit: vat });
  jl.push({ account: from.code, credit: amount });
  const entry = await postJournal(db, { date, description: `${e.description} (${e.payee})`, refType: 'expense', refId: e.id, userId: user.id, lines: jl });
  await db.query('UPDATE expenses SET journal_entry_id=$2 WHERE id=$1', [e.id, entry]);
  await audit(db, user, 'finance.expense', 'expense', e.id, { account: target.code, amount, payee: e.payee });
  return e;
}
export async function recordTransfer(db, user, b) {
  const from = await account(db, b.from_account);
  if (!(from.is_cash || from.code === '1010')) throw new HttpError(400, 'Transfer from a cash, bank, mobile money or card clearing account.');
  const to = await account(db, b.to_account, { cash: true });
  if (from.code === to.code) throw new HttpError(400, 'Choose two different accounts.');
  const amount = money(b.amount), fee = money0(b.fee, 'Fee');
  if (fee >= amount) throw new HttpError(400, 'The fee must be less than the amount.');
  const date = await bizDate(db, b.transfer_date);
  const { rows: [t] } = await db.query('INSERT INTO transfers (transfer_date, from_account, to_account, amount, fee, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [date, from.code, to.code, amount, fee, text(b.description, 'Description', { max: 200 }), user.id]);
  const jl = [{ account: to.code, debit: amount - fee }];
  if (fee) jl.push({ account: BANK_CHARGES, debit: fee });
  jl.push({ account: from.code, credit: amount });
  const entry = await postJournal(db, { date, description: t.description || `Transfer ${from.name} → ${to.name}`, refType: 'transfer', refId: t.id, userId: user.id, lines: jl });
  await db.query('UPDATE transfers SET journal_entry_id=$2 WHERE id=$1', [t.id, entry]);
  await audit(db, user, 'finance.transfer', 'transfer', t.id, { from: from.code, to: to.code, amount, fee });
  return t;
}

/* =============== chart of accounts, manual journals, books lock =============== */
export async function saveAccount(db, user, code, b) {
  if (code) {
    const { rows: [a] } = await db.query('SELECT * FROM accounts WHERE code=$1', [code]);
    if (!a) throw new HttpError(404, 'Account not found.');
    const name = text(b.name, 'Name', { required: true, max: 100 });
    const active = a.system ? true : b.active !== false;
    const isCash = a.system ? a.is_cash : !!b.is_cash && a.type === 'asset';
    const { rows: [u] } = await db.query('UPDATE accounts SET name=$2, active=$3, is_cash=$4 WHERE code=$1 RETURNING *', [code, name, active, isCash]);
    await audit(db, user, 'finance.account_update', 'account', code, { name, active, is_cash: isCash });
    return u;
  }
  const newCode = String(b.code || '').trim();
  if (!/^\d{4}$/.test(newCode)) throw new HttpError(400, 'Account codes are 4 digits.');
  if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(b.type)) throw new HttpError(400, 'Choose an account type.');
  const expectedFirst = { asset: '1', liability: '2', equity: '3', revenue: '4', expense: ['5', '6', '7', '8', '9'] }[b.type];
  if (!(Array.isArray(expectedFirst) ? expectedFirst.includes(newCode[0]) : newCode[0] === expectedFirst)) throw new HttpError(400, 'Codes start with 1 assets, 2 liabilities, 3 equity, 4 revenue, 5–9 expenses.');
  const { rows: [a] } = await db.query('INSERT INTO accounts (code, name, type, is_cash) VALUES ($1,$2,$3,$4) RETURNING *', [newCode, text(b.name, 'Name', { required: true, max: 100 }), b.type, b.type === 'asset' && !!b.is_cash]);
  await audit(db, user, 'finance.account_create', 'account', newCode, { name: a.name, type: a.type });
  return a;
}
export async function manualJournal(db, user, b) {
  const date = await bizDate(db, b.date);
  const description = text(b.description, 'Description', { required: true, max: 200 });
  const lines = (b.lines || []).filter((l) => l && l.account_code && (Number(l.debit) || Number(l.credit))).map((l) => ({ account: String(l.account_code), debit: money0(l.debit, 'Debit'), credit: money0(l.credit, 'Credit') }));
  if (lines.length < 2) throw new HttpError(400, 'A journal needs at least two lines.');
  for (const l of lines) {
    if (l.debit && l.credit) throw new HttpError(400, 'Each line is either a debit or a credit.');
    const a = await account(db, l.account);
    if (CONTROL.includes(a.code)) throw new HttpError(400, `${a.name} is kept by the system and cannot be posted to by hand.`);
  }
  const dr = lines.reduce((a, l) => a + l.debit, 0), cr = lines.reduce((a, l) => a + l.credit, 0);
  if (dr !== cr) throw new HttpError(400, `Debits (${dr.toLocaleString('en-US')}) and credits (${cr.toLocaleString('en-US')}) must be equal.`);
  const entry = await postJournal(db, { date, description, refType: 'manual', refId: null, userId: user.id, lines });
  await audit(db, user, 'finance.manual_journal', 'journal_entry', entry, { date, description, total: dr });
  return { id: entry };
}
export async function setLock(db, user, until) {
  const s = await getSettings(db);
  if (until !== null && !isDate(until)) throw new HttpError(400, 'Choose a date.');
  if (until && until >= s.business_date) throw new HttpError(400, 'You can only close dates before the current business date.');
  const current = s.books_locked_until ? String(s.books_locked_until).slice(0, 10) : null;
  if (current && (until === null || until < current) && user.role !== 'admin') throw new HttpError(403, 'Only an administrator can reopen closed dates.');
  await db.query('UPDATE settings SET books_locked_until=$1 WHERE id=1', [until]);
  await audit(db, user, 'finance.books_lock', 'settings', 1, { from: current, to: until });
  return { books_locked_until: until };
}

/* =============== statements =============== */
async function balancesBetween(db, from, to) {
  const { rows } = await db.query(
    `SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit) FILTER (WHERE e.id IS NOT NULL),0) AS dr, COALESCE(SUM(l.credit) FILTER (WHERE e.id IS NOT NULL),0) AS cr
     FROM accounts a LEFT JOIN journal_lines l ON l.account_code=a.code
     LEFT JOIN journal_entries e ON e.id=l.entry_id AND ($1::date IS NULL OR e.business_date >= $1) AND e.business_date <= $2
     GROUP BY a.code ORDER BY a.code`, [from, to]);
  return rows.map((r) => ({ code: r.code, name: r.name, type: r.type, dr: Number(r.dr), cr: Number(r.cr) }));
}
export async function profitAndLoss(db, from, to) {
  const rows = await balancesBetween(db, from, to);
  const revenue = rows.filter((r) => r.type === 'revenue').map((r) => ({ ...r, amount: r.cr - r.dr })).filter((r) => r.amount);
  const COS = ['5000']; // cost of food & beverage sold
  const cos = rows.filter((r) => r.type === 'expense' && COS.includes(r.code)).map((r) => ({ ...r, amount: r.dr - r.cr })).filter((r) => r.amount);
  const opex = rows.filter((r) => r.type === 'expense' && !COS.includes(r.code)).map((r) => ({ ...r, amount: r.dr - r.cr })).filter((r) => r.amount);
  const sum = (l) => l.reduce((a, r) => a + r.amount, 0);
  const totalRevenue = sum(revenue), totalCos = sum(cos), totalOpex = sum(opex);
  return { from, to, revenue, cost_of_sales: cos, expenses: opex, total_revenue: totalRevenue, total_cost_of_sales: totalCos, gross_profit: totalRevenue - totalCos, total_expenses: totalOpex, net_profit: totalRevenue - totalCos - totalOpex };
}
export async function balanceSheet(db, asAt) {
  const rows = await balancesBetween(db, null, asAt);
  const pick = (type, sign) => rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amount: sign * (r.dr - r.cr) })).filter((r) => r.amount);
  const assets = pick('asset', 1), liabilities = pick('liability', -1), equity = pick('equity', -1);
  const earnings = rows.filter((r) => r.type === 'revenue').reduce((a, r) => a + r.cr - r.dr, 0) - rows.filter((r) => r.type === 'expense').reduce((a, r) => a + r.dr - r.cr, 0);
  const sum = (l) => l.reduce((a, r) => a + r.amount, 0);
  const totalAssets = sum(assets), totalLiab = sum(liabilities), totalEquity = sum(equity) + earnings;
  return { as_at: asAt, assets, liabilities, equity, earnings, total_assets: totalAssets, total_liabilities: totalLiab, total_equity: totalEquity, balanced: totalAssets === totalLiab + totalEquity };
}
export async function generalLedger(db, code, from, to) {
  const a = await account(db, code).catch(async () => { const { rows: [x] } = await db.query('SELECT * FROM accounts WHERE code=$1', [code]); if (!x) throw new HttpError(404, 'Account not found.'); return x; });
  const debitNormal = ['asset', 'expense'].includes(a.type);
  const { rows: [ob] } = await db.query('SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND e.business_date < $2', [a.code, from]);
  let running = (debitNormal ? 1 : -1) * Number(ob.b);
  const opening = running;
  const { rows } = await db.query(
    `SELECT e.id, to_char(e.business_date,'YYYY-MM-DD') AS date, e.description, e.ref_type, l.debit, l.credit, u.full_name
     FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id LEFT JOIN users u ON u.id=e.created_by
     WHERE l.account_code=$1 AND e.business_date BETWEEN $2 AND $3 ORDER BY e.business_date, e.id, l.id LIMIT 2000`, [a.code, from, to]);
  const lines = rows.map((r) => { running += (debitNormal ? 1 : -1) * (Number(r.debit) - Number(r.credit)); return { ...r, debit: Number(r.debit), credit: Number(r.credit), balance: running }; });
  return { account: a, from, to, opening, closing: running, lines };
}
export async function vatSummary(db, from, to) {
  const q = async (sql) => Number((await db.query(sql, [from, to])).rows[0].v);
  const output = await q(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    WHERE l.account_code='2100' AND e.business_date BETWEEN $1 AND $2 AND e.ref_type IN ('charge','charge_void','pos_check','invoice','invoice_void')`);
  const input = await q(`SELECT COALESCE((SELECT SUM(vat) FROM supplier_bills WHERE status='open' AND bill_date BETWEEN $1 AND $2),0) + COALESCE((SELECT SUM(vat) FROM expenses WHERE expense_date BETWEEN $1 AND $2),0) AS v`);
  const paid = await q("SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE account_code='2100' AND expense_date BETWEEN $1 AND $2");
  const { rows: [bal] } = await db.query(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code='2100' AND e.business_date <= $1`, [to]);
  return { from, to, output_vat: output, input_vat: input, net_vat: output - input, paid_to_ura: paid, vat_account_balance: Number(bal.v) };
}

/* =============== bank reconciliation =============== */
export async function startReconciliation(db, user, b) {
  const acct = await account(db, b.account_code, { cash: true });
  if (!isDate(b.statement_date)) throw new HttpError(400, 'Enter the statement date.');
  const bal = Number(b.statement_balance); if (!Number.isInteger(bal)) throw new HttpError(400, 'Enter the statement closing balance in whole shillings.');
  const { rows: [o] } = await db.query("SELECT 1 FROM bank_reconciliations WHERE account_code=$1 AND status='open'", [acct.code]);
  if (o) throw new HttpError(409, `A reconciliation is already open for ${acct.name}.`);
  const { rows: [r] } = await db.query('INSERT INTO bank_reconciliations (account_code, statement_date, statement_balance, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [acct.code, b.statement_date, bal, user.id]);
  await audit(db, user, 'finance.rec_start', 'account', acct.code, { statement_date: b.statement_date, statement_balance: bal });
  return r;
}
export async function getReconciliation(db, id) {
  const { rows: [r] } = await db.query("SELECT r.*, to_char(r.statement_date,'YYYY-MM-DD') AS sdate, a.name AS account_name FROM bank_reconciliations r JOIN accounts a ON a.code=r.account_code WHERE r.id=$1", [id]);
  if (!r) throw new HttpError(404, 'Reconciliation not found.');
  const { rows: [prev] } = await db.query(`SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN bank_reconciliations br ON br.id=l.reconciliation_id WHERE l.account_code=$1 AND br.status='finished' AND br.id <> $2`, [r.account_code, r.id]);
  const { rows: items } = await db.query(
    `SELECT l.id, to_char(e.business_date,'YYYY-MM-DD') AS date, e.description, l.debit, l.credit, l.reconciliation_id = $2 AS cleared
     FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
     WHERE l.account_code=$1 AND e.business_date <= $3 AND (l.reconciliation_id IS NULL OR l.reconciliation_id = $2) ORDER BY e.business_date, l.id`, [r.account_code, r.id, r.sdate]);
  const opening = Number(prev.b);
  const cleared = items.filter((i) => i.cleared).reduce((a, i) => a + Number(i.debit) - Number(i.credit), 0);
  return { ...r, opening_cleared: opening, cleared_balance: opening + cleared, difference: r.statement_balance - (opening + cleared), items: items.map((i) => ({ ...i, debit: Number(i.debit), credit: Number(i.credit) })) };
}
export async function markCleared(db, user, id, lineIds, cleared) {
  const { rows: [r] } = await db.query('SELECT * FROM bank_reconciliations WHERE id=$1 FOR UPDATE', [id]);
  if (!r || r.status !== 'open') throw new HttpError(409, 'This reconciliation is not open.');
  const ids = (lineIds || []).map(Number).filter(Number.isInteger);
  if (cleared) await db.query('UPDATE journal_lines SET reconciliation_id=$1 WHERE id = ANY($2) AND account_code=$3 AND reconciliation_id IS NULL', [id, ids, r.account_code]);
  else await db.query('UPDATE journal_lines SET reconciliation_id=NULL WHERE id = ANY($2) AND reconciliation_id=$1', [id, ids]);
  return getReconciliation(db, id);
}
export async function finishReconciliation(db, user, id) {
  const rec = await getReconciliation(db, id);
  if (rec.status !== 'open') throw new HttpError(409, 'This reconciliation is not open.');
  if (rec.difference !== 0) throw new HttpError(409, `The cleared balance differs from the statement by UGX ${rec.difference.toLocaleString('en-US')}. Tick the remaining items or record missing bank charges first.`);
  await db.query("UPDATE bank_reconciliations SET status='finished', finished_by=$2, finished_at=now() WHERE id=$1", [id, user.id]);
  await audit(db, user, 'finance.rec_finish', 'account', rec.account_code, { statement_date: rec.sdate, balance: rec.statement_balance });
  return { ok: true };
}
