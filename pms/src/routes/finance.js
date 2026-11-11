import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, can, audit } from '../auth.js';
import * as fin from '../services/finance.js';
import { getSettings } from '../services/frontoffice.js';
import { providers } from '../payments/index.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function financeRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const view = requirePerm('finance.view'), manage = requirePerm('finance.manage'), books = requirePerm('accounts.journal');
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const range = async (req) => {
    const s = await getSettings(pool);
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : s.business_date;
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : to.slice(0, 8) + '01';
    if (from > to) throw new HttpError(400, 'The start date is after the end date.');
    return { from, to };
  };

  /* ---------- lists used by forms ---------- */
  r.get('/accounts', (req, _res, next) => { if (!['finance.view', 'accounts.view', 'payments.post'].some((p) => can(req.user, p))) throw new HttpError(403, 'You do not have permission to do this.'); next(); },
    async (_req, res) => res.json(await q(`SELECT a.*, COALESCE((SELECT SUM(debit - credit) FROM journal_lines WHERE account_code=a.code),0) AS balance FROM accounts a ORDER BY code`)));
  r.get('/companies', (req, _res, next) => { if (!['finance.view', 'payments.post'].some((p) => can(req.user, p))) throw new HttpError(403, 'You do not have permission to do this.'); next(); },
    async (_req, res) => res.json(await q('SELECT id, name, tin, contact, phone, email, address, credit_limit, terms_days, active FROM companies ORDER BY name')));

  /* ---------- receivables ---------- */
  r.post('/companies', manage, inTx((db, req) => fin.saveCompany(db, req.user, null, req.body || {})));
  r.put('/companies/:id', manage, inTx((db, req) => fin.saveCompany(db, req.user, id(req), req.body || {})));
  r.get('/companies/:id', view, async (req, res) => res.json(await fin.companyAccount(pool, id(req))));
  r.post('/invoices', manage, inTx((db, req) => fin.createInvoice(db, req.user, req.body || {})));
  r.get('/invoices/:id', view, async (req, res) => res.json(await fin.getInvoice(pool, id(req))));
  r.post('/invoices/:id/void', manage, inTx(async (db, req) => { await fin.voidInvoice(db, req.user, id(req), req.body?.reason); return { ok: true }; }));
  r.post('/receipts', manage, inTx((db, req) => fin.createReceipt(db, req.user, req.body || {})));
  r.post('/receipts/:id/allocate', manage, inTx(async (db, req) => { await fin.allocateReceipt(db, req.user, id(req), req.body?.allocations); return { ok: true }; }));
  r.get('/ar-aging', view, async (_req, res) => res.json(await fin.arAging(pool)));

  /* ---------- payables ---------- */
  r.get('/suppliers/:id', view, async (req, res) => res.json(await fin.supplierAccount(pool, id(req))));
  r.post('/bills', manage, inTx((db, req) => fin.createBill(db, req.user, req.body || {})));
  r.post('/bills/:id/void', manage, inTx(async (db, req) => { await fin.voidBill(db, req.user, id(req), req.body?.reason); return { ok: true }; }));
  r.post('/supplier-payments', manage, inTx((db, req) => fin.supplierPayment(db, req.user, req.body || {})));
  r.get('/ap-aging', view, async (_req, res) => res.json(await fin.apAging(pool)));

  /* ---------- money out & transfers ---------- */
  r.get('/expenses', view, async (req, res) => { const { from, to } = await range(req); res.json(await q(`SELECT e.*, to_char(e.expense_date,'YYYY-MM-DD') AS date, a.name AS account_name, f.name AS paid_from_name, u.full_name AS created_by_name FROM expenses e JOIN accounts a ON a.code=e.account_code JOIN accounts f ON f.code=e.paid_from LEFT JOIN users u ON u.id=e.created_by WHERE e.expense_date BETWEEN $1 AND $2 ORDER BY e.expense_date DESC, e.id DESC`, [from, to])); });
  r.post('/expenses', manage, inTx((db, req) => fin.recordExpense(db, req.user, req.body || {})));
  r.get('/transfers', view, async (_req, res) => res.json(await q(`SELECT t.*, to_char(t.transfer_date,'YYYY-MM-DD') AS date, fa.name AS from_name, ta.name AS to_name FROM transfers t JOIN accounts fa ON fa.code=t.from_account JOIN accounts ta ON ta.code=t.to_account ORDER BY t.id DESC LIMIT 100`)));
  r.post('/transfers', manage, inTx((db, req) => fin.recordTransfer(db, req.user, req.body || {})));

  /* ---------- books ---------- */
  r.post('/accounts', books, inTx((db, req) => fin.saveAccount(db, req.user, null, req.body || {})));
  r.put('/accounts/:code', books, inTx((db, req) => fin.saveAccount(db, req.user, String(req.params.code), req.body || {})));
  r.post('/journals', books, inTx((db, req) => fin.manualJournal(db, req.user, req.body || {})));
  r.put('/lock', books, inTx((db, req) => fin.setLock(db, req.user, req.body?.until || null)));

  /* ---------- statements ---------- */
  r.get('/pl', view, async (req, res) => { const { from, to } = await range(req); res.json(await fin.profitAndLoss(pool, from, to)); });
  r.get('/balance-sheet', view, async (req, res) => { const { to } = await range(req); res.json(await fin.balanceSheet(pool, to)); });
  r.get('/ledger/:code', view, async (req, res) => { const { from, to } = await range(req); res.json(await fin.generalLedger(pool, String(req.params.code), from, to)); });
  r.get('/vat', view, async (req, res) => { const { from, to } = await range(req); res.json(await fin.vatSummary(pool, from, to)); });

  /* ---------- bank reconciliation ---------- */
  r.get('/reconciliations', view, async (_req, res) => res.json(await q("SELECT r.*, to_char(r.statement_date,'YYYY-MM-DD') AS sdate, a.name AS account_name FROM bank_reconciliations r JOIN accounts a ON a.code=r.account_code ORDER BY r.id DESC LIMIT 50")));
  r.post('/reconciliations', books, inTx((db, req) => fin.startReconciliation(db, req.user, req.body || {})));
  r.get('/reconciliations/:id', view, async (req, res) => res.json(await fin.getReconciliation(pool, id(req))));
  r.put('/reconciliations/:id/lines', books, inTx((db, req) => fin.markCleared(db, req.user, id(req), req.body?.line_ids, !!req.body?.cleared)));
  r.post('/reconciliations/:id/finish', books, inTx((db, req) => fin.finishReconciliation(db, req.user, id(req))));

  /* ---------- online payment settings ---------- */
  r.get('/online-payments', view, async (_req, res) => { const s = await getSettings(pool); res.json({ enabled: s.online_payments, provider: s.payment_provider, providers: Object.entries(providers).map(([k, p]) => ({ id: k, label: p.label })) }); });
  r.put('/online-payments', requirePerm('settings.manage'), inTx(async (db, req) => {
    const p = String(req.body?.provider || 'simulator'); if (!providers[p]) throw new HttpError(400, 'Unknown provider.');
    await db.query('UPDATE settings SET online_payments=$1, payment_provider=$2 WHERE id=1', [!!req.body?.enabled, p]);
    await audit(db, req.user, 'finance.online_payments', 'settings', 1, { enabled: !!req.body?.enabled, provider: p });
    return { ok: true };
  }));
  return r;
}
