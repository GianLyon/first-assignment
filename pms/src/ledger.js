// Double-entry postings. Every operational event (charge, payment, void) creates a balanced journal entry
// in the same database transaction, so the books can never drift from the folios.
import { HttpError } from './auth.js';

export const ACCOUNTS = {
  cash: '1000', card: '1010', mobile_money: '1020', bank_transfer: '1030',
  guestLedger: '1100', company_account: '1200', vat: '2100',
};
export const REVENUE = { rooms: '4000', fnb: '4100', amenities: '4200', events: '4300', other: '4900' };
export const PAYMENT_METHODS = ['cash', 'card', 'mobile_money', 'bank_transfer', 'company_account'];
export const DEPARTMENTS = Object.keys(REVENUE);

/** VAT contained in a VAT-inclusive amount, rounded to the nearest shilling. */
export const vatPortion = (gross, rate) => Math.round((gross * rate) / (100 + rate));

export async function postJournal(db, { date, description, refType, refId, userId, lines }) {
  const clean = lines.filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  const dr = clean.reduce((a, l) => a + (l.debit || 0), 0), cr = clean.reduce((a, l) => a + (l.credit || 0), 0);
  if (!clean.length || dr !== cr) throw new HttpError(500, `Unbalanced journal entry (${dr} vs ${cr}).`);
  const { rows: [e] } = await db.query(
    'INSERT INTO journal_entries (business_date, description, ref_type, ref_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [date, description, refType, refId == null ? null : String(refId), userId ?? null]);
  for (const l of clean) {
    await db.query('INSERT INTO journal_lines (entry_id, account_code, debit, credit) VALUES ($1,$2,$3,$4)', [e.id, l.account, l.debit || 0, l.credit || 0]);
  }
  return e.id;
}

/** Guest charge: Dr guest ledger (gross); Cr revenue (net) and VAT payable. */
export function chargeLines(department, gross, vatRate) {
  const vat = vatPortion(gross, vatRate);
  return [
    { account: ACCOUNTS.guestLedger, debit: gross },
    { account: REVENUE[department], credit: gross - vat },
    { account: ACCOUNTS.vat, credit: vat },
  ];
}
/** Guest payment: Dr cash/card/mobile money/bank/company account; Cr guest ledger. */
export function paymentLines(method, amount) {
  return [{ account: ACCOUNTS[method], debit: amount }, { account: ACCOUNTS.guestLedger, credit: amount }];
}
export const reverse = (lines) => lines.map((l) => ({ account: l.account, debit: l.credit || 0, credit: l.debit || 0 }));
