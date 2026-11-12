// Phase 7: amenity sales, events & banqueting, assets & maintenance.
import { HttpError, audit } from '../auth.js';
import { postJournal, saleLines, vatPortion, REVENUE } from '../ledger.js';
import { getSettings, insertCharge, setHousekeeping } from './frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDate = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
const money0 = (v, field) => { const n = Number(v || 0); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a whole number of shillings.`); return n; };
const DIRECT = ['cash', 'card', 'mobile_money'];
async function cashAccount(db, code) {
  const { rows: [a] } = await db.query('SELECT * FROM accounts WHERE code=$1 AND is_cash AND active', [String(code || '')]);
  if (!a) throw new HttpError(400, 'Choose a cash, bank or mobile money account.');
  return a;
}

/* =============================== AMENITIES =============================== */
export async function saveAmenity(db, user, id, b) {
  const cats = ['spa', 'transport', 'tour', 'laundry', 'leisure', 'other'];
  const vals = [text(b.name, 'Name', { required: true, max: 120 }), cats.includes(b.category) ? b.category : 'other', money0(b.price, 'Price'),
    b.duration_min ? Math.max(5, Number(b.duration_min) || 0) : null, text(b.description, 'Description', { max: 300 })];
  let a;
  if (id) ({ rows: [a] } = await db.query('UPDATE amenities SET name=$2, category=$3, price=$4, duration_min=$5, description=$6, active=$7 WHERE id=$1 RETURNING *', [id, ...vals, b.active !== false]));
  else ({ rows: [a] } = await db.query('INSERT INTO amenities (name, category, price, duration_min, description) VALUES ($1,$2,$3,$4,$5) RETURNING *', vals));
  if (!a) throw new HttpError(404, 'Amenity not found.');
  await audit(db, user, id ? 'amenity.update' : 'amenity.create', 'amenity', a.id, { name: a.name, price: a.price });
  return a;
}

export async function bookAmenity(db, user, b) {
  const s = await getSettings(db);
  const { rows: [am] } = await db.query('SELECT * FROM amenities WHERE id=$1 AND active', [Number(b.amenity_id)]);
  if (!am) throw new HttpError(400, 'Choose a service.');
  const date = b.service_date || s.business_date;
  if (!isDate(date) || date < s.business_date) throw new HttpError(400, 'The date cannot be in the past.');
  if (b.start_time && !TIME_RE.test(b.start_time)) throw new HttpError(400, 'Time must be HH:MM.');
  const qty = Math.max(1, Math.min(50, Number(b.qty) || 1));
  let resId = null, guest = text(b.guest_name, 'Guest name', { max: 120 });
  if (b.reservation_id) {
    const { rows: [r] } = await db.query(
      `SELECT r.*, g.first_name, g.last_name, g.phone FROM reservations r JOIN guests g ON g.id=r.guest_id
       WHERE r.id=$1 AND r.status IN ('reserved','in_house') AND r.arrival <= $2 AND r.departure >= $2`, [Number(b.reservation_id), date]);
    if (!r) throw new HttpError(400, 'That guest is not staying on that date.');
    resId = r.id; guest = guest || `${r.first_name} ${r.last_name}`;
  }
  if (!guest) throw new HttpError(400, 'Enter the guest name.');
  // the same staff member cannot be booked twice at the same time
  if (b.staff && b.start_time && am.duration_min) {
    const { rows: [clash] } = await db.query(
      `SELECT ab.code FROM amenity_bookings ab JOIN amenities a ON a.id=ab.amenity_id
       WHERE ab.service_date=$1 AND lower(ab.staff)=lower($2) AND ab.status='booked' AND ab.start_time IS NOT NULL
         AND ab.start_time < ($3::time + make_interval(mins => $4)) AND ($3::time) < ab.start_time + make_interval(mins => COALESCE(a.duration_min, 60))`,
      [date, String(b.staff).trim(), b.start_time, am.duration_min]);
    if (clash) throw new HttpError(409, `${String(b.staff).trim()} is already booked at that time (${clash.code}).`);
  }
  const { rows: [bk] } = await db.query(
    `INSERT INTO amenity_bookings (amenity_id, service_date, start_time, qty, unit_price, reservation_id, guest_name, phone, staff, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [am.id, date, b.start_time || null, qty, am.price, resId, guest, text(b.phone, 'Phone', { max: 40 }), text(b.staff, 'Staff', { max: 80 }), text(b.notes, 'Notes', { max: 300 }), user.id]);
  await audit(db, user, 'amenity.book', 'amenity_booking', bk.id, { code: bk.code, amenity: am.name, date, qty });
  return bk;
}

/** Service delivered: charge the guest's room, or take payment. */
export async function completeAmenity(db, user, id, { settle_by }) {
  const { rows: [bk] } = await db.query('SELECT ab.*, a.name FROM amenity_bookings ab JOIN amenities a ON a.id=ab.amenity_id WHERE ab.id=$1 FOR UPDATE OF ab', [id]);
  if (!bk) throw new HttpError(404, 'Booking not found.');
  if (bk.status !== 'booked') throw new HttpError(409, 'This booking is already closed.');
  const s = await getSettings(db);
  if (String(bk.service_date).slice(0, 10) > s.business_date) throw new HttpError(409, 'The service date has not arrived yet.');
  const amount = bk.qty * bk.unit_price;
  const desc = `${bk.name}${bk.qty > 1 ? ` × ${bk.qty}` : ''} (${bk.code})`;
  let chargeId = null, entry = null;
  if (amount > 0) {
    if (settle_by === 'room') {
      const { rows: [r] } = await db.query("SELECT * FROM reservations WHERE id=$1 AND status='in_house' FOR UPDATE", [bk.reservation_id]);
      if (!r) throw new HttpError(409, 'Charge to room is only possible for an in-house guest.');
      const c = await insertCharge(db, user, r, s, { department: 'amenities', amount, description: desc });
      chargeId = c.id;
    } else if (DIRECT.includes(settle_by)) {
      entry = await postJournal(db, { date: s.business_date, description: desc, refType: 'amenity', refId: bk.id, userId: user.id, lines: saleLines('amenities', [{ method: settle_by, amount }], s.vat_rate) });
    } else throw new HttpError(400, 'Choose how it is paid.');
  }
  await db.query("UPDATE amenity_bookings SET status='completed', settled_by=$2, folio_charge_id=$3, journal_entry_id=$4, completed_at=now() WHERE id=$1", [bk.id, amount > 0 ? settle_by : null, chargeId, entry]);
  await audit(db, user, 'amenity.complete', 'amenity_booking', bk.id, { code: bk.code, amount, settle_by });
  return { amount };
}
export async function closeAmenity(db, user, id, status) {
  if (!['cancelled', 'no_show'].includes(status)) throw new HttpError(400, 'Unknown status.');
  const { rowCount } = await db.query("UPDATE amenity_bookings SET status=$2 WHERE id=$1 AND status='booked'", [id, status]);
  if (!rowCount) throw new HttpError(409, 'This booking is already closed.');
  await audit(db, user, `amenity.${status}`, 'amenity_booking', id);
}

/* =========================== EVENTS & BANQUETING =========================== */
const EV_BLOCKING = ['tentative', 'confirmed'];
async function eventForUpdate(db, id) {
  const { rows: [e] } = await db.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [id]);
  if (!e) throw new HttpError(404, 'Event not found.');
  return e;
}
async function checkRoom(db, e) {
  const { rows: [fr] } = await db.query('SELECT * FROM function_rooms WHERE id=$1 AND active', [e.function_room_id]);
  if (!fr) throw new HttpError(400, 'Choose a function room.');
  if (e.pax > fr.capacity) throw new HttpError(409, `${fr.name} holds up to ${fr.capacity} guests.`);
  if (EV_BLOCKING.includes(e.status)) {
    await db.query('SELECT id FROM function_rooms WHERE id=$1 FOR UPDATE', [fr.id]); // serialise bookings per room
    const { rows: [clash] } = await db.query(
      `SELECT code, title FROM events WHERE function_room_id=$1 AND event_date=$2 AND status IN ('tentative','confirmed') AND id IS DISTINCT FROM $5
       AND start_time < $4 AND $3 < end_time`, [fr.id, e.event_date, e.start_time, e.end_time, e.id ?? null]);
    if (clash) throw new HttpError(409, `${fr.name} is already booked then (${clash.code} ${clash.title}).`);
  }
  return fr;
}
export async function eventTotals(db, e) {
  const { rows: [x] } = await db.query('SELECT COALESCE(SUM(qty*unit_price),0) AS extras FROM event_extras WHERE event_id=$1', [e.id]);
  const { rows: [p] } = await db.query("SELECT COALESCE(SUM(CASE WHEN kind='deposit' THEN amount ELSE -amount END),0) AS held FROM event_payments WHERE event_id=$1", [e.id]);
  const food = e.pax * e.per_person, extras = Number(x.extras);
  const total = food + e.room_hire + extras;
  return { package: food, room_hire: e.room_hire, extras, total, deposits: Number(p.held), balance: total - Number(p.held) };
}

export async function saveEvent(db, user, id, b) {
  const s = await getSettings(db);
  const cur = id ? await eventForUpdate(db, id) : null;
  if (cur && ['completed', 'cancelled'].includes(cur.status)) throw new HttpError(409, 'This event is closed.');
  if (!isDate(b.event_date)) throw new HttpError(400, 'Choose the event date.');
  if (!cur && b.event_date < s.business_date) throw new HttpError(400, 'The event date cannot be in the past.');
  if (!TIME_RE.test(b.start_time || '') || !TIME_RE.test(b.end_time || '') || b.end_time <= b.start_time) throw new HttpError(400, 'Enter a start and end time (end after start).');
  const types = ['conference', 'meeting', 'wedding', 'party', 'workshop', 'other'];
  const status = cur ? (b.status && ['enquiry', 'tentative', 'confirmed'].includes(b.status) ? b.status : cur.status) : (['enquiry', 'tentative', 'confirmed'].includes(b.status) ? b.status : 'enquiry');
  let perPerson = money0(b.per_person, 'Price per person'), packageId = b.package_id ? Number(b.package_id) : null;
  if (packageId) {
    const { rows: [pk] } = await db.query('SELECT * FROM event_packages WHERE id=$1', [packageId]);
    if (!pk) throw new HttpError(400, 'Unknown package.');
    if (b.per_person === undefined || b.per_person === '' || b.per_person === null) perPerson = pk.per_person;
  }
  const { rows: [fr] } = await db.query('SELECT * FROM function_rooms WHERE id=$1', [Number(b.function_room_id)]);
  if (!fr) throw new HttpError(400, 'Choose a function room.');
  const hireType = ['none', 'half_day', 'full_day'].includes(b.hire_type) ? b.hire_type : 'none';
  const roomHire = b.room_hire !== undefined && b.room_hire !== '' && b.room_hire !== null ? money0(b.room_hire, 'Room hire') : hireType === 'full_day' ? fr.hire_full_day : hireType === 'half_day' ? fr.hire_half_day : 0;
  let companyId = b.company_id ? Number(b.company_id) : null;
  if (companyId) { const { rows } = await db.query('SELECT 1 FROM companies WHERE id=$1', [companyId]); if (!rows[0]) throw new HttpError(400, 'Unknown company.'); }
  const e = {
    id: cur?.id, title: text(b.title, 'Event name', { required: true, max: 150 }), event_type: types.includes(b.event_type) ? b.event_type : 'conference', status,
    event_date: b.event_date, start_time: b.start_time, end_time: b.end_time, function_room_id: fr.id, company_id: companyId,
    contact_name: text(b.contact_name, 'Contact name', { required: true, max: 120 }), contact_phone: text(b.contact_phone, 'Phone', { max: 40 }), contact_email: text(b.contact_email, 'Email', { max: 120 }),
    pax: Math.max(1, Number(b.pax) || 0), package_id: packageId, per_person: perPerson, hire_type: hireType, room_hire: roomHire,
    setup_style: text(b.setup_style, 'Set-up', { max: 60 }), notes: text(b.notes, 'Notes', { max: 1000 }),
    beo_notes: Object.fromEntries(['kitchen', 'service', 'bar', 'housekeeping', 'technical', 'front_office'].map((k) => [k, text(b.beo_notes?.[k], 'Instructions', { max: 1000 }) || ''])),
  };
  if (!(Number(b.pax) > 0)) throw new HttpError(400, 'Enter the number of guests.');
  await checkRoom(db, e);
  const cols = ['title', 'event_type', 'status', 'event_date', 'start_time', 'end_time', 'function_room_id', 'company_id', 'contact_name', 'contact_phone', 'contact_email', 'pax', 'package_id', 'per_person', 'hire_type', 'room_hire', 'setup_style', 'notes', 'beo_notes'];
  const vals = cols.map((c) => (c === 'beo_notes' ? JSON.stringify(e[c]) : e[c]));
  let row;
  if (cur) ({ rows: [row] } = await db.query(`UPDATE events SET (${cols.join(',')}) = (${cols.map((_, i) => '$' + (i + 2)).join(',')}) WHERE id=$1 RETURNING *`, [cur.id, ...vals]));
  else ({ rows: [row] } = await db.query(`INSERT INTO events (${cols.join(',')}, created_by) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}) RETURNING *`, [...vals, user.id]));
  if (Array.isArray(b.extras)) {
    await db.query('DELETE FROM event_extras WHERE event_id=$1', [row.id]);
    for (const x of b.extras.filter((x) => x && x.description && Number(x.unit_price) >= 0 && Number(x.qty) > 0)) {
      await db.query('INSERT INTO event_extras (event_id, description, qty, unit_price) VALUES ($1,$2,$3,$4)', [row.id, text(x.description, 'Extra', { required: true, max: 150 }), Math.max(1, Number(x.qty) || 1), money0(x.unit_price, 'Extra price')]);
    }
  }
  await audit(db, user, cur ? 'event.update' : 'event.create', 'event', row.id, { code: row.code, status: row.status, date: e.event_date, pax: e.pax });
  return row;
}

export async function eventPayment(db, user, id, b) {
  const e = await eventForUpdate(db, id);
  if (['completed', 'cancelled'].includes(e.status)) throw new HttpError(409, 'This event is closed.');
  const kind = b.kind === 'refund' ? 'refund' : 'deposit';
  const acct = await cashAccount(db, b.account_code);
  const amount = money0(b.amount, 'Amount'); if (!amount) throw new HttpError(400, 'Enter the amount.');
  const t = await eventTotals(db, e);
  if (kind === 'refund' && amount > t.deposits) throw new HttpError(400, 'You cannot refund more than the deposits held.');
  const s = await getSettings(db);
  const lines = kind === 'deposit' ? [{ account: acct.code, debit: amount }, { account: '2200', credit: amount }] : [{ account: '2200', debit: amount }, { account: acct.code, credit: amount }];
  const entry = await postJournal(db, { date: s.business_date, description: `${e.code} ${kind}: ${e.title}`, refType: 'event_payment', refId: e.id, userId: user.id, lines });
  await db.query('INSERT INTO event_payments (event_id, kind, account_code, amount, reference, business_date, created_by, journal_entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [e.id, kind, acct.code, amount, text(b.reference, 'Reference', { max: 80 }), s.business_date, user.id, entry]);
  // a paid deposit confirms a tentative booking
  if (kind === 'deposit' && e.status !== 'confirmed') { await db.query("UPDATE events SET status='confirmed' WHERE id=$1", [e.id]); await checkRoom(db, { ...e, status: 'confirmed' }); }
  await audit(db, user, `event.${kind}`, 'event', e.id, { code: e.code, amount });
  return eventTotals(db, { ...e });
}

/**
 * The event has happened: recognise the revenue. Deposits are applied; the balance is paid now
 * (cash/card/mobile money) or invoiced to the client's company account.
 */
export async function completeEvent(db, user, id, { settle_by, account_code } = {}) {
  const e = await eventForUpdate(db, id);
  if (e.status !== 'confirmed') throw new HttpError(409, 'Only confirmed events can be completed.');
  const s = await getSettings(db);
  if (String(e.event_date).slice(0, 10) > s.business_date) throw new HttpError(409, 'The event date has not arrived yet.');
  const t = await eventTotals(db, e);
  if (t.total <= 0) throw new HttpError(409, 'This event has nothing to bill.');
  if (t.balance < 0) throw new HttpError(409, `Deposits are UGX ${(-t.balance).toLocaleString('en-US')} more than the bill. Refund the difference first.`);
  const vat = vatPortion(t.total, s.vat_rate);
  const lines = [];
  if (t.deposits) lines.push({ account: '2200', debit: t.deposits });
  let invoiceId = null;
  if (t.balance > 0) {
    if (settle_by === 'invoice') {
      if (!e.company_id) throw new HttpError(400, 'Link the event to a company account to invoice it.');
      lines.push({ account: '1200', debit: t.balance });
    } else if (DIRECT.includes(settle_by)) {
      const acct = account_code ? await cashAccount(db, account_code) : { code: { cash: '1000', card: '1010', mobile_money: '1020' }[settle_by] };
      lines.push({ account: acct.code, debit: t.balance });
    } else throw new HttpError(400, 'Choose how the balance is settled.');
  }
  lines.push({ account: REVENUE.events, credit: t.total - vat }, { account: '2100', credit: vat });
  const entry = await postJournal(db, { date: s.business_date, description: `${e.code} ${e.title}`, refType: 'event', refId: e.id, userId: user.id, lines });
  if (t.balance > 0 && settle_by === 'invoice') {
    const { rows: [co] } = await db.query('SELECT * FROM companies WHERE id=$1', [e.company_id]);
    const { rows: [inv] } = await db.query('INSERT INTO invoices (company_id, invoice_date, due_date, total, notes, created_by, journal_entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [co.id, s.business_date, addDays(s.business_date, co.terms_days), t.balance, `${e.code}: total ${t.total.toLocaleString('en-US')} less deposits ${t.deposits.toLocaleString('en-US')}`, user.id, entry]);
    await db.query("INSERT INTO invoice_lines (invoice_id, department, description, amount) VALUES ($1,'events',$2,$3)", [inv.id, `${e.title}, ${String(e.event_date).slice(0, 10)} (${e.pax} guests)`, t.balance]);
    invoiceId = inv.id;
  }
  await db.query("UPDATE events SET status='completed', completed_at=now(), journal_entry_id=$2, invoice_id=$3 WHERE id=$1", [e.id, entry, invoiceId]);
  await audit(db, user, 'event.complete', 'event', e.id, { code: e.code, total: t.total, deposits: t.deposits, settle_by });
  return { ...t, invoice_id: invoiceId };
}

export async function cancelEvent(db, user, id, { reason, deposit }) {
  const e = await eventForUpdate(db, id);
  if (['completed', 'cancelled'].includes(e.status)) throw new HttpError(409, 'This event is already closed.');
  const why = text(reason, 'Reason', { required: true, max: 300 });
  const t = await eventTotals(db, e);
  if (t.deposits > 0) {
    if (deposit !== 'forfeit') throw new HttpError(409, `UGX ${t.deposits.toLocaleString('en-US')} in deposits is held. Refund it first, or choose to keep it under the cancellation terms.`);
    const s = await getSettings(db);
    await postJournal(db, { date: s.business_date, description: `${e.code} cancelled: deposit kept`, refType: 'event_forfeit', refId: e.id, userId: user.id, lines: [{ account: '2200', debit: t.deposits }, { account: '4920', credit: t.deposits }] });
  }
  await db.query("UPDATE events SET status='cancelled', cancel_reason=$2 WHERE id=$1", [e.id, why]);
  await audit(db, user, 'event.cancel', 'event', e.id, { code: e.code, reason: why, deposit_kept: t.deposits });
}

/* =========================== ASSETS & MAINTENANCE =========================== */
export async function createAsset(db, user, b) {
  const s = await getSettings(db);
  const cats = ['building', 'furniture', 'equipment', 'kitchen', 'vehicle', 'it', 'other'];
  if (!isDate(b.purchase_date) || b.purchase_date > s.business_date) throw new HttpError(400, 'Enter the purchase date (not in the future).');
  const cost = money0(b.cost, 'Cost'), residual = money0(b.residual_value, 'Residual value');
  if (residual > cost) throw new HttpError(400, 'Residual value cannot be more than the cost.');
  const life = Math.round(Number(b.useful_life_years) * 12);
  if (!(life >= 1 && life <= 600)) throw new HttpError(400, 'Useful life must be between 1 month and 50 years.');
  const funding = ['opening', 'paid', 'none'].includes(b.funding) ? b.funding : null;
  if (!funding) throw new HttpError(400, 'Say how the asset is recorded in the books.');
  const { rows: [a] } = await db.query(
    `INSERT INTO assets (name, category, location, serial_no, supplier, purchase_date, cost, residual_value, useful_life_months, service_interval_days, last_service_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [text(b.name, 'Name', { required: true, max: 120 }), cats.includes(b.category) ? b.category : 'equipment', text(b.location, 'Location', { max: 80 }), text(b.serial_no, 'Serial number', { max: 60 }),
      text(b.supplier, 'Supplier', { max: 120 }), b.purchase_date, cost, residual, life, b.service_interval_days ? Math.max(1, Number(b.service_interval_days)) : null,
      isDate(b.last_service_date) ? b.last_service_date : null, text(b.notes, 'Notes', { max: 500 }), user.id]);
  if (cost > 0 && funding !== 'none') {
    const credit = funding === 'opening' ? '3000' : (await cashAccount(db, b.paid_from)).code;
    const entry = await postJournal(db, { date: funding === 'opening' ? s.business_date : s.business_date, description: `${a.code} ${a.name}${funding === 'opening' ? ' (opening balance)' : ''}`, refType: 'asset', refId: a.id, userId: user.id,
      lines: [{ account: '1500', debit: cost }, { account: credit, credit: cost }] });
    await db.query('UPDATE assets SET journal_entry_id=$2 WHERE id=$1', [a.id, entry]);
  }
  await audit(db, user, 'asset.create', 'asset', a.id, { code: a.code, cost, funding });
  return a;
}
export async function updateAsset(db, user, id, b) {
  const { rows: [a] } = await db.query('UPDATE assets SET name=$2, location=$3, serial_no=$4, service_interval_days=$5, notes=$6, status=CASE WHEN status=\'disposed\' THEN status ELSE $7 END WHERE id=$1 RETURNING *',
    [id, text(b.name, 'Name', { required: true, max: 120 }), text(b.location, 'Location', { max: 80 }), text(b.serial_no, 'Serial number', { max: 60 }),
      b.service_interval_days ? Math.max(1, Number(b.service_interval_days)) : null, text(b.notes, 'Notes', { max: 500 }), b.status === 'under_repair' ? 'under_repair' : 'in_use']);
  if (!a) throw new HttpError(404, 'Asset not found.');
  await audit(db, user, 'asset.update', 'asset', id, { status: a.status });
  return a;
}
const monthEnd = (period) => addDays(addDays(period + '-01', 32).slice(0, 8) + '01', -1);
/** Straight-line depreciation for one month, posted once. */
export async function runDepreciation(db, user, period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) throw new HttpError(400, 'Choose a month.');
  const s = await getSettings(db);
  if (period > s.business_date.slice(0, 7)) throw new HttpError(400, 'You cannot depreciate a future month.');
  const { rows: [done] } = await db.query('SELECT 1 FROM depreciation_runs WHERE period=$1', [period]);
  if (done) throw new HttpError(409, 'Depreciation has already been posted for that month.');
  const end = monthEnd(period);
  const { rows: assets } = await db.query("SELECT * FROM assets WHERE status <> 'disposed' AND purchase_date <= $1 AND accumulated_dep < cost - residual_value FOR UPDATE", [end]);
  let total = 0, n = 0;
  for (const a of assets) {
    const monthly = Math.round((a.cost - a.residual_value) / a.useful_life_months);
    const amt = Math.min(monthly, a.cost - a.residual_value - a.accumulated_dep);
    if (amt <= 0) continue;
    await db.query('UPDATE assets SET accumulated_dep = accumulated_dep + $2 WHERE id=$1', [a.id, amt]);
    total += amt; n++;
  }
  let entry = null;
  const date = end < s.business_date ? end : s.business_date;
  if (total > 0) entry = await postJournal(db, { date, description: `Depreciation ${period}`, refType: 'depreciation', refId: period, userId: user.id, lines: [{ account: '6800', debit: total }, { account: '1590', credit: total }] });
  await db.query('INSERT INTO depreciation_runs (period, total, assets, run_by, journal_entry_id) VALUES ($1,$2,$3,$4,$5)', [period, total, n, user.id, entry]);
  await audit(db, user, 'asset.depreciation', 'depreciation', period, { total, assets: n });
  return { period, total, assets: n };
}
export async function disposeAsset(db, user, id, b) {
  const { rows: [a] } = await db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [id]);
  if (!a) throw new HttpError(404, 'Asset not found.');
  if (a.status === 'disposed') throw new HttpError(409, 'Already disposed.');
  const s = await getSettings(db);
  const proceeds = money0(b.proceeds, 'Sale proceeds');
  const nbv = a.cost - a.accumulated_dep;
  const lines = [];
  if (a.accumulated_dep) lines.push({ account: '1590', debit: a.accumulated_dep });
  if (proceeds) lines.push({ account: (await cashAccount(db, b.account_code)).code, debit: proceeds });
  if (proceeds < nbv) lines.push({ account: '6810', debit: nbv - proceeds });
  if (a.cost) lines.push({ account: '1500', credit: a.cost });
  if (proceeds > nbv) lines.push({ account: '4910', credit: proceeds - nbv });
  if (lines.length >= 2) await postJournal(db, { date: s.business_date, description: `Disposal ${a.code} ${a.name}`, refType: 'asset_disposal', refId: a.id, userId: user.id, lines });
  await db.query("UPDATE assets SET status='disposed', disposed_date=$2, disposal_proceeds=$3, notes=concat_ws(' · ', notes, $4::text) WHERE id=$1", [a.id, s.business_date, proceeds, text(b.reason, 'Reason', { max: 200 })]);
  await audit(db, user, 'asset.dispose', 'asset', a.id, { proceeds, book_value: nbv });
  return { book_value: nbv, gain: proceeds - nbv };
}

export async function reportIssue(db, user, b) {
  const s = await getSettings(db);
  const pr = ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal';
  let roomId = b.room_id ? Number(b.room_id) : null, assetId = b.asset_id ? Number(b.asset_id) : null;
  if (roomId) { const { rows } = await db.query('SELECT 1 FROM rooms WHERE id=$1', [roomId]); if (!rows[0]) throw new HttpError(400, 'Unknown room.'); }
  if (assetId) { const { rows } = await db.query("SELECT 1 FROM assets WHERE id=$1 AND status <> 'disposed'", [assetId]); if (!rows[0]) throw new HttpError(400, 'Unknown asset.'); }
  const ooo = !!b.room_out_of_order && !!roomId;
  if (ooo) await setHousekeeping(db, user, roomId, 'out_of_order'); // refuses if the room is occupied
  const { rows: [w] } = await db.query(
    `INSERT INTO work_orders (title, description, kind, priority, asset_id, room_id, location, room_out_of_order, assigned_to, due_date, reported_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [text(b.title, 'What is wrong', { required: true, max: 150 }), text(b.description, 'Details', { max: 1000 }), ['repair', 'preventive', 'inspection'].includes(b.kind) ? b.kind : 'repair',
      pr, assetId, roomId, text(b.location, 'Location', { max: 80 }), ooo, text(b.assigned_to, 'Assigned to', { max: 80 }),
      isDate(b.due_date) ? b.due_date : addDays(s.business_date, { urgent: 0, high: 1, normal: 3, low: 7 }[pr]), user.id]);
  if (assetId && pr !== 'low' && w.kind === 'repair') await db.query("UPDATE assets SET status='under_repair' WHERE id=$1 AND status='in_use'", [assetId]);
  await audit(db, user, 'maintenance.report', 'work_order', w.id, { code: w.code, priority: pr, room_out_of_order: ooo });
  return w;
}
export async function updateWorkOrder(db, user, id, b) {
  const { rows: [w] } = await db.query('SELECT * FROM work_orders WHERE id=$1 FOR UPDATE', [id]);
  if (!w) throw new HttpError(404, 'Work order not found.');
  if (['done', 'cancelled'].includes(w.status)) throw new HttpError(409, 'This job is closed.');
  const status = ['open', 'in_progress', 'on_hold', 'done', 'cancelled'].includes(b.status) ? b.status : w.status;
  if (status === 'done' && !text(b.completion_notes, 'Completion notes', { max: 1000 })) throw new HttpError(400, 'Say what was done.');
  await db.query(`UPDATE work_orders SET status=$2, assigned_to=$3, due_date=$4, cost=$5, completion_notes=$6, priority=$7,
      completed_by=CASE WHEN $2 IN ('done','cancelled') THEN $8::int ELSE NULL END, completed_at=CASE WHEN $2 IN ('done','cancelled') THEN now() ELSE NULL END WHERE id=$1`,
    [w.id, status, text(b.assigned_to, 'Assigned to', { max: 80 }) ?? w.assigned_to, isDate(b.due_date) ? b.due_date : w.due_date, b.cost !== undefined ? money0(b.cost, 'Cost') : w.cost,
      text(b.completion_notes, 'Completion notes', { max: 1000 }), ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : w.priority, user.id]);
  if (['done', 'cancelled'].includes(status)) {
    if (w.room_out_of_order) {
      const { rows: [room] } = await db.query('SELECT hk_status FROM rooms WHERE id=$1', [w.room_id]);
      if (room?.hk_status === 'out_of_order') await setHousekeeping(db, user, w.room_id, 'dirty'); // back to housekeeping for cleaning
    }
    if (w.asset_id) {
      const { rows: [open] } = await db.query("SELECT 1 FROM work_orders WHERE asset_id=$1 AND id<>$2 AND status IN ('open','in_progress','on_hold') AND kind='repair'", [w.asset_id, w.id]);
      if (!open) await db.query("UPDATE assets SET status='in_use' WHERE id=$1 AND status='under_repair'", [w.asset_id]);
      if (status === 'done' && w.kind !== 'repair') { const s = await getSettings(db); await db.query('UPDATE assets SET last_service_date=$2 WHERE id=$1', [w.asset_id, s.business_date]); }
    }
  }
  await audit(db, user, 'maintenance.update', 'work_order', w.id, { code: w.code, status, cost: b.cost });
  return { ok: true };
}
/** Create preventive work orders for assets whose service falls due within a week. */
export async function scheduleServices(db, user) {
  const s = await getSettings(db);
  const { rows } = await db.query(
    `SELECT a.* FROM assets a WHERE a.status <> 'disposed' AND a.service_interval_days IS NOT NULL
       AND COALESCE(a.last_service_date, a.purchase_date) + a.service_interval_days <= $1::date + 7
       AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.asset_id=a.id AND w.kind='preventive' AND w.status IN ('open','in_progress','on_hold'))`, [s.business_date]);
  for (const a of rows) {
    const due = addDays(String(a.last_service_date || a.purchase_date).slice(0, 10), a.service_interval_days);
    await db.query("INSERT INTO work_orders (title, kind, priority, asset_id, location, due_date, reported_by) VALUES ($1,'preventive','normal',$2,$3,$4,$5)",
      [`Scheduled service: ${a.name}`, a.id, a.location, due < s.business_date ? s.business_date : due, user.id]);
  }
  await audit(db, user, 'maintenance.schedule', 'work_order', null, { created: rows.length });
  return { created: rows.length };
}
