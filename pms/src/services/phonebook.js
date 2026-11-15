// Phase 12: the phone book. Every guest with a number (from their profiles) plus other contacts (suppliers,
// drivers, partners, staff on call), searchable, one tap to call or WhatsApp, and exportable to phones.
import { HttpError, audit } from '../auth.js';
import { getSettings } from './frontoffice.js';
import { normalizePhone, formatPhone } from './whatsapp.js';

export const CATEGORIES = { supplier: 'Supplier', transport: 'Transport / driver', partner: 'Partner / tour operator', staff: 'Staff', emergency: 'Emergency', other: 'Other' };
const text = (v, field, max) => {
  const s = v == null ? '' : String(v).trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};

/** Phone book rows. kind: all | guests | in_house | contacts | <contact category>. */
export async function phoneBook(db, { q = '', kind = 'all', limit = 300 } = {}) {
  const s = await getSettings(db);
  const like = q ? `%${String(q).toLowerCase().slice(0, 60)}%` : null;
  const digits = String(q).replace(/\D/g, '').length >= 3 ? `%${String(q).replace(/\D/g, '').replace(/^0+/, '').slice(0, 15)}%` : null;
  const out = [];
  if (['all', 'guests', 'in_house'].includes(kind)) {
    const { rows } = await db.query(`SELECT g.id, g.first_name, g.last_name, g.phone, g.email, g.nationality, g.vip, g.whatsapp_opt_in, g.whatsapp_opt_out_at, g.marketing_consent,
        to_char(max(r.departure) FILTER (WHERE r.status='checked_out'),'YYYY-MM-DD') AS last_stay, bool_or(r.status='in_house') AS in_house,
        max(rm.number) FILTER (WHERE r.status='in_house') AS room, count(r.id) FILTER (WHERE r.status IN ('in_house','checked_out'))::int AS stays,
        (SELECT c.id FROM wa_conversations c WHERE c.guest_id=g.id ORDER BY c.last_message_at DESC LIMIT 1) AS conversation_id
      FROM guests g LEFT JOIN reservations r ON r.guest_id=g.id LEFT JOIN rooms rm ON rm.id=r.room_id
      WHERE g.merged_into IS NULL AND g.erased_at IS NULL AND (g.phone IS NOT NULL OR g.email IS NOT NULL)
        AND ($1::text IS NULL OR lower(g.first_name || ' ' || g.last_name) LIKE $1 OR lower(coalesce(g.email,'')) LIKE $1 OR regexp_replace(coalesce(g.phone,''),'\\D','','g') LIKE $3)
      GROUP BY g.id ${kind === 'in_house' ? "HAVING bool_or(r.status='in_house')" : ''}
      ORDER BY bool_or(r.status='in_house') DESC NULLS LAST, max(r.arrival) DESC NULLS LAST, lower(g.last_name) LIMIT $2`, [like, limit, digits]);
    for (const g of rows) {
      const wa = normalizePhone(g.phone, s.phone_country_code);
      out.push({ type: 'guest', id: g.id, name: `${g.first_name} ${g.last_name}`.trim(), first_name: g.first_name, last_name: g.last_name, company: null, category: 'guest',
        phone: g.phone, phone_intl: formatPhone(wa), wa_id: wa, email: g.email, vip: g.vip, in_house: !!g.in_house, room: g.room, stays: g.stays, last_stay: g.last_stay,
        whatsapp: g.whatsapp_opt_out_at ? 'stopped' : g.whatsapp_opt_in ? 'yes' : 'no', conversation_id: g.conversation_id, nationality: g.nationality });
    }
  }
  if (kind === 'all' || kind === 'contacts' || CATEGORIES[kind]) {
    const { rows } = await db.query(`SELECT k.*, (SELECT c.id FROM wa_conversations c WHERE c.contact_id=k.id ORDER BY c.last_message_at DESC LIMIT 1) AS conversation_id FROM contacts k
      WHERE ($1::text IS NULL OR lower(k.name || ' ' || coalesce(k.company,'')) LIKE $1 OR regexp_replace(coalesce(k.phone,'') || ' ' || coalesce(k.phone2,''),'\\D','','g') LIKE $4)
        AND ($2::text IS NULL OR k.category=$2) ORDER BY lower(k.name) LIMIT $3`, [like, CATEGORIES[kind] ? kind : null, limit, digits]);
    for (const k of rows) {
      const wa = normalizePhone(k.phone, s.phone_country_code);
      out.push({ type: 'contact', id: k.id, name: k.name, company: k.company, category: k.category, phone: k.phone, phone2: k.phone2, phone_intl: formatPhone(wa), wa_id: wa,
        email: k.email, notes: k.notes, whatsapp: 'n/a', conversation_id: k.conversation_id });
    }
  }
  return out;
}

export async function saveContact(db, user, id, b) {
  const name = text(b.name, 'Name', 120);
  if (!name) throw new HttpError(400, 'Name is required.');
  const category = CATEGORIES[b.category] ? b.category : 'other';
  const phone = text(b.phone, 'Phone', 40), phone2 = text(b.phone2, 'Second phone', 40), email = text(b.email, 'Email', 120)?.toLowerCase() || null;
  if (!phone && !phone2 && !email) throw new HttpError(400, 'Give at least a phone number or an email.');
  const s = await getSettings(db);
  for (const [v, l] of [[phone, 'Phone'], [phone2, 'Second phone']]) if (v && !normalizePhone(v, s.phone_country_code)) throw new HttpError(400, `${l} is not a valid number.`);
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new HttpError(400, 'That email address is not valid.');
  const vals = [name, text(b.company, 'Company', 120), category, phone, phone2, email, text(b.notes, 'Notes', 500)];
  const { rows: [k] } = id
    ? await db.query('UPDATE contacts SET name=$2, company=$3, category=$4, phone=$5, phone2=$6, email=$7, notes=$8 WHERE id=$1 RETURNING *', [id, ...vals])
    : await db.query('INSERT INTO contacts (name, company, category, phone, phone2, email, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [...vals, user.id]);
  if (!k) throw new HttpError(404, 'Contact not found.');
  await audit(db, user, id ? 'contact.update' : 'contact.create', 'contact', k.id, { category });
  return k;
}
export async function deleteContact(db, user, id) {
  await db.query('UPDATE wa_conversations SET contact_id=NULL WHERE contact_id=$1', [id]);
  const { rowCount } = await db.query('DELETE FROM contacts WHERE id=$1', [id]);
  if (!rowCount) throw new HttpError(404, 'Contact not found.');
  await audit(db, user, 'contact.delete', 'contact', id);
}

/* ------------------------- export to phones ------------------------- */
// vCard 3.0: imports into Android, iPhone, Google Contacts and Outlook. Guests get the hotel name as a label so they
// stand out in the phone's own contact list (and in WhatsApp, which reads it).
const vEsc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
// lines over 75 octets are folded (continuation lines start with a space)
const fold = (line) => { const out = []; let cur = ''; for (const ch of line) { if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch; } out.push(cur); return out.join('\r\n'); };
export function toVcard(rows, propertyName) {
  return rows.filter((r) => r.phone_intl || r.email).map((r) => {
    const isGuest = r.type === 'guest';
    const last = isGuest ? r.last_name || '' : '', first = isGuest ? r.first_name || r.name : r.name;
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vEsc(last)};${vEsc(first)};;;`, `FN:${vEsc(r.name)}${isGuest ? ` (${vEsc(propertyName)} guest)` : ''}`,
      `ORG:${vEsc(isGuest ? propertyName + ' guests' : r.company || propertyName)}`];
    if (r.phone_intl) lines.push(`TEL;TYPE=CELL:${r.phone_intl}`);
    if (r.phone2) lines.push(`TEL;TYPE=WORK:${vEsc(r.phone2)}`);
    if (r.email) lines.push(`EMAIL;TYPE=INTERNET:${vEsc(r.email)}`);
    const note = isGuest ? [r.vip ? 'VIP' : '', r.stays ? `${r.stays} stay${r.stays === 1 ? '' : 's'}` : '', r.last_stay ? `last ${r.last_stay}` : ''].filter(Boolean).join(', ') : [CATEGORIES[r.category], r.notes].filter(Boolean).join(' · ');
    if (note) lines.push(`NOTE:${vEsc(note)}`);
    lines.push(`CATEGORIES:${vEsc(isGuest ? 'Guests' : CATEGORIES[r.category] || 'Other')}`, 'END:VCARD');
    return lines.map(fold).join('\r\n');
  }).join('\r\n') + '\r\n';
}
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(rows) {
  const head = ['Type', 'Name', 'Company', 'Category', 'Phone', 'Phone (international)', 'Email', 'WhatsApp agreed', 'Stays', 'Last stay'];
  return [head, ...rows.map((r) => [r.type, r.name, r.company, r.type === 'guest' ? 'Guest' : CATEGORIES[r.category], r.phone, r.phone_intl, r.email, r.whatsapp, r.stays ?? '', r.last_stay ?? ''])]
    .map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
