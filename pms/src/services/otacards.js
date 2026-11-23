// OTA payment cards: when Expedia, Agoda or Booking.com collect from the guest, they pay the hotel with a virtual
// card (VCC) that can be charged from a set date. Other bookings may carry the guest's own card as a guarantee.
//
// The PMS NEVER keeps card numbers or security codes (that would put the hotel under PCI DSS). It keeps only what
// staff need to find the card in the secure card store (the channel manager's PCI service) and charge it there:
// the last 4 digits, type, holder, dates, amount and the store's token. Staff then record the charge here, which
// posts the payment to the guest bill and the accounts.
import { HttpError, audit } from '../auth.js';
import { postPayment, getSettings } from './frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const str = (v, max) => (v === undefined || v === null || v === '' ? null : String(v).trim().slice(0, max) || null);
const date = (v) => (DATE_RE.test(String(v || '')) ? String(v).slice(0, 10) : null);

/** Every key/value in an object, nested keys joined with '.', keys lower-cased. */
function flat(o, pre = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = (pre + k).toLowerCase();
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key + '.', out); else out[key] = v;
  }
  return out;
}
const pick = (f, re) => { for (const [k, v] of Object.entries(f)) if (re.test(k) && v !== null && v !== '' && v !== undefined) return v; return null; };

/**
 * Safe facts about the payment card on a channel booking (a Channex booking revision's attributes). Field names
 * differ between OTAs and channel managers, so they are read defensively. Returns null when there is nothing.
 */
export function cardFacts(a = {}) {
  const pc = String(a.payment_collect || a.payment_collect_type || '').toLowerCase();
  const collect = /ota|channel|agent/.test(pc) ? 'ota' : /property|hotel|hotel_collect/.test(pc) ? 'property' : 'unknown';
  const g = a.guarantee || a.payment_card || a.card || null;
  if (!g && collect === 'unknown') return null;
  const f = flat(g || {});
  const digits = String(pick(f, /(^|\.)(card_number|number|masked_card_number|card_last4|last4|last_four)$/) || '').replace(/\D/g, '');
  const typeText = `${a.payment_type || ''} ${pick(f, /virtual|card_kind|card_category/) ?? ''}`;
  const isVirtual = f.is_virtual === true || f.is_virtual === 'true' || f.virtual === true || /virtual|vcc/i.test(typeText);
  const mm = pick(f, /expiration_month|exp_month/), yy = pick(f, /expiration_year|exp_year/);
  return {
    collect, is_virtual: !!isVirtual,
    card_type: str(pick(f, /(^|\.)(card_type|brand|card_brand|type)$/), 30),
    last4: digits.length >= 4 ? digits.slice(-4) : null,
    expiry: str(pick(f, /(^|\.)(expiration_date|expiry|expiry_date|exp_date)$/) || (mm && yy ? `${String(mm).padStart(2, '0')}/${yy}` : null), 10),
    holder: str(pick(f, /cardholder|holder_name|name_on_card/), 80),
    token: str(pick(f, /(^|\.)(token|card_token|pci_token)$/), 200),
    charge_from: date(pick(f, /activation|effective|valid_from|charge_from|available_from/)),
    charge_until: date(pick(f, /deactivation|valid_to|valid_until|virtual_card_expir|charge_until/)),
    amount: Number(pick(f, /balance|virtual_card_amount|(^|\.)amount$/)) || null,
    currency: str(pick(f, /currency/), 3)?.toUpperCase() || null,
  };
}

/** A copy of a booking with every card detail removed, for logs. */
export function withoutCard(a = {}) {
  const { guarantee, payment_card, card, ...rest } = a || {};
  return { ...rest, ...(guarantee || payment_card || card ? { card: '(removed)' } : {}) };
}

/** Save (or update) the card facts for a channel booking. A card already charged keeps its status. */
export async function saveCard(db, { reservationId, channelId, ota, otaRef, facts }) {
  if (!facts) return null;
  const status = facts.is_virtual && facts.collect !== 'property' ? 'to_charge' : 'not_needed';
  const note = status === 'not_needed' ? (facts.collect === 'ota' ? 'The OTA collects from the guest and pays the hotel directly.' : 'Guarantee card: the guest pays at the hotel.') : null;
  const { rows: [c] } = await db.query(
    `INSERT INTO ota_cards (reservation_id, channel_id, ota, ota_ref, collect, is_virtual, card_type, last4, expiry, holder, charge_from, charge_until, amount, currency, token, status, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (reservation_id) DO UPDATE SET collect=EXCLUDED.collect, is_virtual=EXCLUDED.is_virtual, card_type=EXCLUDED.card_type, last4=EXCLUDED.last4,
       expiry=EXCLUDED.expiry, holder=EXCLUDED.holder, charge_from=EXCLUDED.charge_from, charge_until=EXCLUDED.charge_until, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       token=EXCLUDED.token, updated_at=now(),
       status=CASE WHEN ota_cards.status IN ('charged','failed') THEN ota_cards.status ELSE EXCLUDED.status END,
       note=CASE WHEN ota_cards.status IN ('charged','failed') THEN ota_cards.note ELSE EXCLUDED.note END
     RETURNING *`,
    [reservationId, channelId, str(ota, 40), str(otaRef, 60), facts.collect, facts.is_virtual, facts.card_type, facts.last4, facts.expiry, facts.holder, facts.charge_from, facts.charge_until,
      facts.amount, facts.currency, facts.token, status, note]);
  return c;
}

/** Booking cancelled: a card still waiting to be charged is no longer needed. */
export async function cardBookingCancelled(db, reservationId) {
  await db.query("UPDATE ota_cards SET status='not_needed', note='Booking cancelled', updated_at=now() WHERE reservation_id=$1 AND status='to_charge'", [reservationId]);
}

const BAL = `COALESCE((SELECT SUM(amount) FROM folio_charges c WHERE c.reservation_id=r.id AND NOT c.voided),0) - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.reservation_id=r.id AND NOT p.voided),0)`;

export async function listCards(db, { status = 'to_charge' } = {}) {
  const s = await getSettings(db);
  const where = status === 'all' ? 'true' : status === 'done' ? "oc.status IN ('charged','not_needed','failed')" : "oc.status = 'to_charge'";
  const { rows } = await db.query(
    `SELECT oc.*, to_char(oc.charge_from,'YYYY-MM-DD') AS charge_from, to_char(oc.charge_until,'YYYY-MM-DD') AS charge_until, r.code, r.status AS booking_status,
            to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, r.commission_pct, trim(g.first_name || ' ' || g.last_name) AS guest,
            (${BAL})::bigint AS balance, COALESCE((SELECT SUM(amount) FROM folio_charges c WHERE c.reservation_id=r.id AND NOT c.voided),0)::bigint AS charges, u.full_name AS updated_by_name
     FROM ota_cards oc JOIN reservations r ON r.id=oc.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN users u ON u.id=oc.updated_by
     WHERE ${where} ORDER BY COALESCE(oc.charge_from, r.departure), r.arrival LIMIT 300`);
  const today = s.business_date;
  return { today, cards: rows.map((c) => ({ ...c, ready: c.status === 'to_charge' && (c.charge_from ? c.charge_from <= today : c.departure <= today) })) };
}

/**
 * Staff charged the card in the secure card store: record it on the bill. When the OTA pays the net amount (after
 * its commission), the rest of the bill can be settled against the commission already accrued (account 2300).
 */
export async function recordCharge(db, user, reservationId, b = {}) {
  const { rows: [c] } = await db.query('SELECT * FROM ota_cards WHERE reservation_id=$1 FOR UPDATE', [reservationId]);
  if (!c) throw new HttpError(404, 'No card on this booking.');
  if (c.status === 'charged') throw new HttpError(409, 'This card is already recorded as charged.');
  const amount = Math.round(Number(b.amount));
  if (!(amount > 0)) throw new HttpError(400, 'Enter the amount charged (UGX).');
  const brand = ['Visa', 'Mastercard', 'Amex', 'UnionPay', 'Other'].find((x) => x.toLowerCase() === String(b.card_brand || c.card_type || '').toLowerCase()) || null;
  const p = await postPayment(db, user, reservationId, {
    method: 'card', amount, reference: `${c.ota || 'OTA'} virtual card${c.ota_ref ? ' ' + c.ota_ref : ''}`.slice(0, 80),
    details: { card_brand: brand === 'Other' ? null : brand, card_last4: c.last4, auth_code: b.auth_code }, payer_name: c.ota || 'OTA',
  });
  let settled = 0;
  if (b.settle_commission) {
    const { rows: [x] } = await db.query(`SELECT (${BAL})::bigint AS balance, COALESCE((SELECT SUM(amount) FROM folio_charges c WHERE c.reservation_id=r.id AND NOT c.voided),0)::bigint AS charges FROM reservations r WHERE r.id=$1`, [reservationId]);
    const left = Number(x.balance);
    // the OTA's share is never more than 35% of the bill; anything larger is a mistake, not commission
    if (left > 0) {
      if (left > Number(x.charges) * 0.35) throw new HttpError(400, `What is left (UGX ${left.toLocaleString('en-US')}) is more than an OTA commission would be. Check the amount charged.`);
      await postPayment(db, user, reservationId, { method: 'ota_commission', amount: left, reference: `${c.ota || 'OTA'} commission kept` }, { internal: true });
      settled = left;
    }
  }
  await db.query("UPDATE ota_cards SET status='charged', charged_amount=$2, payment_id=$3, note=$4, updated_by=$5, updated_at=now() WHERE reservation_id=$1",
    [reservationId, amount, p.id, str(b.note, 300), user.id]);
  await audit(db, user, 'cards.charged', 'reservation', reservationId, { amount, settled_commission: settled, last4: c.last4 });
  return { ok: true, payment_id: p.id, settled_commission: settled };
}

export async function setCardStatus(db, user, reservationId, b = {}) {
  const status = ['failed', 'not_needed', 'to_charge'].includes(b.status) ? b.status : null;
  if (!status) throw new HttpError(400, 'Unknown status.');
  const note = str(b.note, 300);
  if (status === 'failed' && !note) throw new HttpError(400, 'Say why the charge failed (e.g. declined, not yet active, wrong amount).');
  const { rows: [c] } = await db.query("UPDATE ota_cards SET status=$2, note=$3, updated_by=$4, updated_at=now() WHERE reservation_id=$1 AND status <> 'charged' RETURNING *", [reservationId, status, note, user.id]);
  if (!c) throw new HttpError(409, 'No card waiting on this booking (a charged card cannot be changed; void the payment instead).');
  await audit(db, user, 'cards.status', 'reservation', reservationId, { status, note });
  return c;
}
