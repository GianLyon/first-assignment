// Online deposits and prepayments from the website booking engine.
import crypto from 'node:crypto';
import { tx } from '../db.js';
import { HttpError, audit } from '../auth.js';
import { getSettings, postPayment, cancelReservation } from './frontoffice.js';
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

/** The provider set up for this hotel, if it can take payments. */
export function activeProvider(s) {
  const p = providers[s.payment_provider];
  return s.online_payments && p && (!p.configured || p.configured()) ? p : null;
}

export async function startPayment(db, code, email) {
  const s = await getSettings(db);
  if (!s.online_payments) throw new HttpError(403, 'Online payment is not available. Please pay at the hotel.');
  const provider = activeProvider(s);
  if (!provider) throw new HttpError(503, 'Online payment is not set up.');
  const { rows: [r] } = await db.query(
    `SELECT r.*, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, rp.refundable,
            g.first_name, g.last_name, g.email, g.phone
     FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rate_plans rp ON rp.id=r.rate_plan_id
     WHERE r.code=$1 AND lower(g.email)=lower($2) AND r.channel_id IS NULL FOR UPDATE OF r`, [String(code || '').trim().toUpperCase(), String(email || '').trim()]);
  if (!r) throw new HttpError(404, 'We could not find a booking with that code and email.');
  if (r.status !== 'reserved') throw new HttpError(409, 'This booking cannot be paid online.');
  const due = await amountDue(db, r);
  if (due.outstanding <= 0) throw new HttpError(409, 'Nothing is due online for this booking.');
  await db.query("UPDATE payment_intents SET status='expired' WHERE reservation_id=$1 AND status='pending' AND provider_ref IS NULL", [r.id]);
  const token = crypto.randomBytes(18).toString('base64url');
  const { rows: [intent] } = await db.query('INSERT INTO payment_intents (token, reservation_id, amount, provider, currency) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [token, r.id, due.outstanding, s.payment_provider, s.currency || 'UGX']);
  let out;
  try {
    out = await provider.createCheckout(intent, { db, code: r.code, property: s.property_name, currency: s.currency || 'UGX', guest: { first_name: r.first_name, last_name: r.last_name, email: r.email, phone: r.phone } });
  } catch (e) {
    console.error('Payment start failed:', e.message);
    throw new HttpError(502, 'The payment page could not be opened. Please try again in a minute, or pay at the hotel.');
  }
  if (out.provider_ref) await db.query('UPDATE payment_intents SET provider_ref=$2 WHERE id=$1', [intent.id, String(out.provider_ref).slice(0, 120)]);
  return { checkout_url: out.checkout_url, amount: due.outstanding, full: due.full };
}

export async function intentInfo(db, token) {
  const { rows: [i] } = await db.query(
    `SELECT i.token, i.amount, i.status, r.code, s.property_name FROM payment_intents i JOIN reservations r ON r.id=i.reservation_id CROSS JOIN settings s WHERE i.token=$1`, [String(token || '')]);
  if (!i) throw new HttpError(404, 'Payment not found.');
  return i;
}

/** Provider confirmed the outcome. Idempotent: a repeated confirmation changes nothing. */
export async function completePayment(db, { token, status, provider_ref, method, note }) {
  const { rows: [i] } = await db.query('SELECT * FROM payment_intents WHERE token=$1 FOR UPDATE', [String(token || '')]);
  if (!i) throw new HttpError(404, 'Payment not found.');
  if (i.status !== 'pending') return { status: i.status, already: true };
  if (status !== 'paid') {
    await db.query("UPDATE payment_intents SET status='failed', provider_ref=COALESCE($2, provider_ref), note=$3, checked_at=now() WHERE id=$1", [i.id, provider_ref || null, note || null]);
    return { status: 'failed' };
  }
  const m = method === 'mobile_money' ? 'mobile_money' : 'card';
  const { rows: [r] } = await db.query('SELECT id, code, status FROM reservations WHERE id=$1 FOR UPDATE', [i.reservation_id]);
  if (!['reserved', 'in_house', 'checked_out'].includes(r.status)) {
    // money arrived for a booking that was released or cancelled meanwhile: keep the record for staff to refund or rebook
    await db.query("UPDATE payment_intents SET status='paid', paid_at=now(), provider_ref=COALESCE($2, provider_ref), method=$3, checked_at=now(), note=$4 WHERE id=$1",
      [i.id, provider_ref || null, m, `Paid after the booking was ${r.status}: refund or re-book the guest.`]);
    await audit(db, null, 'booking_engine.payment_after_cancel', 'reservation', r.id, { amount: i.amount, provider: i.provider });
    return { status: 'paid', amount: i.amount, needs_attention: true };
  }
  const p = await postPayment(db, null, i.reservation_id, { method: m, amount: i.amount, reference: `Online ${i.provider} ${provider_ref || i.token.slice(0, 8)}`.slice(0, 80) });
  await db.query("UPDATE payment_intents SET status='paid', paid_at=now(), provider_ref=COALESCE($2, provider_ref), method=$3, payment_id=$4, checked_at=now(), note=$5 WHERE id=$1", [i.id, provider_ref || null, m, p.id, note || null]);
  await db.query('UPDATE reservations SET pay_by=NULL WHERE id=$1', [i.reservation_id]);
  await audit(db, null, 'booking_engine.online_payment', 'reservation', i.reservation_id, { amount: i.amount, provider: i.provider, method: m });
  return { status: 'paid', amount: i.amount };
}

/**
 * Ask the provider what happened to one payment and record it. Used for the provider's notification, the guest's
 * return, and the regular check of payments still pending. The amount and currency must match what we asked for.
 */
export async function refreshIntent(pool, intent) {
  const provider = providers[intent.provider];
  if (!provider?.checkStatus || intent.status !== 'pending') return { status: intent.status };
  const st = await provider.checkStatus(intent);
  await pool.query('UPDATE payment_intents SET checked_at=now() WHERE id=$1', [intent.id]);
  if (st.status === 'pending') return { status: 'pending' };
  if (st.status === 'paid' && (!(st.amount >= Number(intent.amount)) || (intent.currency && st.currency && st.currency !== intent.currency))) {
    await tx(pool, async (db) => {
      await completePayment(db, { token: intent.token, status: 'failed', note: `Provider reported ${st.amount} ${st.currency}; expected ${intent.amount} ${intent.currency}. Check with the provider.` });
      await audit(db, null, 'booking_engine.payment_mismatch', 'reservation', intent.reservation_id, { expected: Number(intent.amount), got: st.amount, currency: st.currency });
    });
    return { status: 'failed', mismatch: true };
  }
  const ref = st.confirmation ? `${st.provider_ref || ''} ${st.confirmation}`.trim() : st.provider_ref;
  return tx(pool, (db) => completePayment(db, { token: intent.token, status: st.status === 'paid' ? 'paid' : 'failed', provider_ref: intent.provider_ref || ref, method: st.method,
    note: st.status === 'reversed' ? 'Reversed by the provider' : st.payment_method ? `${st.payment_method}${st.confirmation ? ' · ' + st.confirmation : ''}` : null }));
}

/** Pesapal's notification (or the guest coming back): look the payment up by our reference or the provider's id. */
export async function refreshByReference(pool, { token, providerRef, provider }) {
  const { rows: [i] } = await pool.query('SELECT * FROM payment_intents WHERE (token=$1 OR (provider=$3 AND provider_ref=$2)) ORDER BY id DESC LIMIT 1',
    [String(token || ''), String(providerRef || ''), provider || '']);
  if (!i) throw new HttpError(404, 'Payment not found.');
  const r = await refreshIntent(pool, i);
  return { ...r, code: (await pool.query('SELECT code FROM reservations WHERE id=$1', [i.reservation_id])).rows[0]?.code };
}

/**
 * Every minute: check payments still open with the provider (in case a notification was missed), then release
 * website bookings that had to be paid online and were not paid in time.
 */
export async function paymentHousekeeping(pool) {
  const { rows: open } = await pool.query(`SELECT * FROM payment_intents WHERE status='pending' AND provider <> 'simulator' AND provider_ref IS NOT NULL
      AND created_at > now() - interval '3 days' AND created_at < now() - interval '2 minutes' AND (checked_at IS NULL OR checked_at < now() - interval '4 minutes') ORDER BY id LIMIT 30`);
  for (const i of open) { try { await refreshIntent(pool, i); } catch (e) { console.error('Payment check failed:', e.message); } }
  const { rows: late } = await pool.query(`SELECT r.id, r.code FROM reservations r WHERE r.pay_by < now() AND r.status='reserved'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id=r.id AND NOT p.voided)
      AND NOT EXISTS (SELECT 1 FROM payment_intents i WHERE i.reservation_id=r.id AND i.status='pending' AND i.provider_ref IS NOT NULL AND i.created_at > now() - interval '2 hours') LIMIT 20`);
  let released = 0;
  for (const r of late) {
    await tx(pool, async (db) => {
      const { rows: [x] } = await db.query("SELECT status, pay_by FROM reservations WHERE id=$1 FOR UPDATE", [r.id]);
      if (x.status !== 'reserved' || !x.pay_by || x.pay_by > new Date()) return;
      await cancelReservation(db, null, r.id, 'Not paid online in time: room released');
      await db.query('UPDATE reservations SET pay_by=NULL WHERE id=$1', [r.id]);
      released++;
    });
  }
  return { checked: open.length, released };
}
