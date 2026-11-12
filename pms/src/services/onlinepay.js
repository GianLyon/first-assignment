// Online deposits and prepayments from the website booking engine.
import crypto from 'node:crypto';
import { HttpError, audit } from '../auth.js';
import { getSettings, postPayment } from './frontoffice.js';
import { providers } from '../payments/index.js';

/** What the guest should pay now: in full for non-refundable rates, otherwise the first night as a deposit. */
async function amountDue(db, r) {
  const { rows: nights } = await db.query('SELECT rate FROM reservation_nights WHERE reservation_id=$1 ORDER BY night', [r.id]);
  const n = Math.round((Date.parse(r.departure + 'T00:00:00Z') - Date.parse(r.arrival + 'T00:00:00Z')) / 864e5);
  const total = nights.length ? nights.reduce((a, x) => a + Number(x.rate), 0) : r.rate * n;
  const first = nights.length ? Number(nights[0].rate) : r.rate;
  const { rows: [p] } = await db.query('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE reservation_id=$1 AND NOT voided', [r.id]);
  const wanted = r.refundable === false ? total : first;
  return { total, deposit: wanted, outstanding: Math.max(0, wanted - Number(p.paid)), full: r.refundable === false };
}

export async function startPayment(db, code, email) {
  const s = await getSettings(db);
  if (!s.online_payments) throw new HttpError(403, 'Online payment is not available. Please pay at the hotel.');
  const provider = providers[s.payment_provider];
  if (!provider) throw new HttpError(503, 'Online payment is not set up.');
  const { rows: [r] } = await db.query(
    `SELECT r.*, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, rp.refundable FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rate_plans rp ON rp.id=r.rate_plan_id
     WHERE r.code=$1 AND lower(g.email)=lower($2) AND r.channel_id IS NULL FOR UPDATE OF r`, [String(code || '').trim().toUpperCase(), String(email || '').trim()]);
  if (!r) throw new HttpError(404, 'We could not find a booking with that code and email.');
  if (r.status !== 'reserved') throw new HttpError(409, 'This booking cannot be paid online.');
  const due = await amountDue(db, r);
  if (due.outstanding <= 0) throw new HttpError(409, 'Nothing is due online for this booking.');
  await db.query("UPDATE payment_intents SET status='expired' WHERE reservation_id=$1 AND status='pending'", [r.id]);
  const token = crypto.randomBytes(18).toString('base64url');
  const { rows: [intent] } = await db.query('INSERT INTO payment_intents (token, reservation_id, amount, provider) VALUES ($1,$2,$3,$4) RETURNING *', [token, r.id, due.outstanding, s.payment_provider]);
  const { checkout_url } = await provider.createCheckout(intent, { code: r.code });
  return { checkout_url, amount: due.outstanding, full: due.full };
}

export async function intentInfo(db, token) {
  const { rows: [i] } = await db.query(
    `SELECT i.token, i.amount, i.status, r.code, s.property_name FROM payment_intents i JOIN reservations r ON r.id=i.reservation_id CROSS JOIN settings s WHERE i.token=$1`, [String(token || '')]);
  if (!i) throw new HttpError(404, 'Payment not found.');
  return i;
}

/** Provider confirmed the outcome. Idempotent: a repeated confirmation changes nothing. */
export async function completePayment(db, { token, status, provider_ref, method }) {
  const { rows: [i] } = await db.query('SELECT * FROM payment_intents WHERE token=$1 FOR UPDATE', [String(token || '')]);
  if (!i) throw new HttpError(404, 'Payment not found.');
  if (i.status !== 'pending') return { status: i.status, already: true };
  if (status !== 'paid') {
    await db.query("UPDATE payment_intents SET status='failed', provider_ref=$2 WHERE id=$1", [i.id, provider_ref || null]);
    return { status: 'failed' };
  }
  const m = method === 'mobile_money' ? 'mobile_money' : 'card';
  const p = await postPayment(db, null, i.reservation_id, { method: m, amount: i.amount, reference: `Online ${i.provider} ${provider_ref || i.token.slice(0, 8)}` });
  await db.query("UPDATE payment_intents SET status='paid', paid_at=now(), provider_ref=$2, method=$3, payment_id=$4 WHERE id=$1", [i.id, provider_ref || null, m, p.id]);
  await audit(db, null, 'booking_engine.online_payment', 'reservation', i.reservation_id, { amount: i.amount, provider: i.provider, method: m });
  return { status: 'paid', amount: i.amount };
}
