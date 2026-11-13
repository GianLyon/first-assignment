// Phase 9: guest CRM & marketing — profiles, segments, campaigns, automatic guest emails, consent.
import { HttpError, audit } from '../auth.js';
import { getSettings } from './frontoffice.js';
import { parseRecipients } from './reports.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
const dmy = (d) => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

/* ------------------------- profiles & statistics ------------------------- */
// One row per (unmerged) guest with stay history and spend. Spend = everything charged to their bills (VAT incl.).
export const GUEST_STATS = `
  WITH st AS (
    SELECT r.guest_id,
      count(*) FILTER (WHERE r.status IN ('in_house','checked_out'))::int AS stays,
      COALESCE(SUM(r.departure - r.arrival) FILTER (WHERE r.status IN ('in_house','checked_out')),0)::int AS nights,
      to_char(max(r.departure) FILTER (WHERE r.status='checked_out'),'YYYY-MM-DD') AS last_stay,
      to_char(min(r.arrival) FILTER (WHERE r.status='reserved'),'YYYY-MM-DD') AS next_arrival,
      bool_or(r.status='in_house') AS in_house,
      array_agg(DISTINCT r.source) AS sources
    FROM reservations r GROUP BY r.guest_id),
  sp AS (SELECT r.guest_id, SUM(c.amount)::bigint AS spend FROM folio_charges c JOIN reservations r ON r.id=c.reservation_id WHERE NOT c.voided GROUP BY r.guest_id)
  SELECT g.id, g.first_name, g.last_name, g.email, g.phone, g.nationality, to_char(g.birth_date,'YYYY-MM-DD') AS birth_date, g.vip, g.tags, g.preferences, g.notes,
    g.marketing_consent, g.consent_at, g.consent_source, g.whatsapp_opt_in, g.whatsapp_opt_in_at, g.whatsapp_opt_out_at, g.unsubscribed_at, g.erased_at, g.created_at,
    COALESCE(st.stays,0) AS stays, COALESCE(st.nights,0) AS nights, st.last_stay, st.next_arrival, COALESCE(st.in_house,FALSE) AS in_house,
    COALESCE(st.sources,'{}') AS sources, COALESCE(sp.spend,0) AS spend
  FROM guests g LEFT JOIN st ON st.guest_id=g.id LEFT JOIN sp ON sp.guest_id=g.id
  WHERE g.merged_into IS NULL`;

/** Turn a segment definition into SQL conditions over GUEST_STATS. Unknown keys are ignored. */
export function segmentWhere(seg = {}, params = []) {
  const w = [];
  const p = (v) => { params.push(v); return '$' + params.length; };
  const int = (v) => (v === '' || v == null ? null : Math.max(0, Math.floor(Number(v)) || 0));
  if (seg.q) { const t = p(`%${String(seg.q).toLowerCase().slice(0, 80)}%`); w.push(`(lower(x.first_name || ' ' || x.last_name) LIKE ${t} OR lower(coalesce(x.email,'')) LIKE ${t} OR lower(coalesce(x.phone,'')) LIKE ${t})`); }
  if (seg.vip === true || seg.vip === 'yes') w.push('x.vip');
  if (seg.tag) w.push(`${p(String(seg.tag).toLowerCase().slice(0, 40))} = ANY(x.tags)`);
  if (int(seg.min_stays) != null) w.push(`x.stays >= ${p(int(seg.min_stays))}`);
  if (int(seg.max_stays) != null) w.push(`x.stays <= ${p(int(seg.max_stays))}`);
  if (int(seg.min_spend) != null) w.push(`x.spend >= ${p(int(seg.min_spend))}`);
  if (DATE_RE.test(seg.stayed_since || '')) w.push(`x.last_stay >= ${p(seg.stayed_since)}`);
  if (DATE_RE.test(seg.not_since || '')) w.push(`x.last_stay < ${p(seg.not_since)}`); // lapsed guests
  if (seg.source) w.push(`${p(String(seg.source).slice(0, 40))} = ANY(x.sources)`);
  if (seg.nationality) w.push(`lower(coalesce(x.nationality,'')) = ${p(String(seg.nationality).toLowerCase().slice(0, 60))}`);
  if (int(seg.birth_month) >= 1 && int(seg.birth_month) <= 12) w.push(`extract(month from x.birth_date::date) = ${p(int(seg.birth_month))}`);
  if (seg.consent === 'yes') w.push('x.marketing_consent AND x.unsubscribed_at IS NULL');
  if (seg.consent === 'no') w.push('NOT (x.marketing_consent AND x.unsubscribed_at IS NULL)');
  w.push('x.erased_at IS NULL');
  return { where: w.join(' AND '), params };
}
export async function listGuests(db, seg, { limit = 100, offset = 0, sort = 'recent' } = {}) {
  const { where, params } = segmentWhere(seg);
  const order = { spend: 'x.spend DESC', stays: 'x.stays DESC, x.spend DESC', name: 'lower(x.last_name), lower(x.first_name)' }[sort] || 'x.last_stay DESC NULLS LAST, x.id DESC';
  const { rows } = await db.query(`SELECT x.*, count(*) OVER()::int AS total FROM (${GUEST_STATS}) x WHERE ${where} ORDER BY ${order} LIMIT ${Math.min(500, limit)} OFFSET ${Math.max(0, offset)}`, params);
  return { total: rows[0]?.total || 0, guests: rows.map(({ total, ...g }) => g) };
}
export async function guestProfile(db, id) {
  const { rows: [g] } = await db.query(`SELECT x.* FROM (${GUEST_STATS}) x WHERE x.id=$1`, [id]);
  if (!g) {
    const { rows: [m] } = await db.query('SELECT merged_into FROM guests WHERE id=$1', [id]);
    if (m?.merged_into) return { redirect: m.merged_into };
    throw new HttpError(404, 'Guest not found.');
  }
  const { rows: stays } = await db.query(`SELECT r.id, r.code, r.status, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, r.source, t.name AS room_type, rm.number AS room,
      COALESCE((SELECT SUM(amount) FROM folio_charges c WHERE c.reservation_id=r.id AND NOT c.voided),0)::bigint AS spend
    FROM reservations r JOIN room_types t ON t.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.guest_id=$1 ORDER BY r.arrival DESC`, [id]);
  const { rows: emails } = await db.query(`SELECT o.id, o.kind, o.subject, o.status, o.created_at FROM email_outbox o WHERE o.guest_id=$1 ORDER BY o.id DESC LIMIT 50`, [id]);
  const { rows: dupes } = await db.query(`SELECT id, first_name, last_name, email, phone FROM guests WHERE id<>$1 AND merged_into IS NULL AND erased_at IS NULL AND (
      (lower(first_name)=lower($2) AND lower(last_name)=lower($3)) OR ($4::text IS NOT NULL AND lower(email)=lower($4)) OR ($5::text IS NOT NULL AND regexp_replace(phone,'\\D','','g')=regexp_replace($5,'\\D','','g'))) LIMIT 10`,
  [id, g.first_name, g.last_name, g.email, g.phone]);
  return { guest: g, stays, emails, possible_duplicates: dupes };
}

export async function updateGuest(db, user, id, b) {
  const { rows: [cur] } = await db.query('SELECT * FROM guests WHERE id=$1 AND merged_into IS NULL FOR UPDATE', [id]);
  if (!cur) throw new HttpError(404, 'Guest not found.');
  if (cur.erased_at) throw new HttpError(409, 'This profile was erased.');
  const email = text(b.email, 'Email', { max: 120 })?.toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'That email address is not valid.');
  if (b.birth_date && !DATE_RE.test(b.birth_date)) throw new HttpError(400, 'Birthday must be a date.');
  const tags = [...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (tags.some((t) => t.length > 40)) throw new HttpError(400, 'Tags must be short.');
  await db.query(`UPDATE guests SET first_name=$2, last_name=$3, email=$4, phone=$5, nationality=$6, birth_date=$7, vip=$8, tags=$9, preferences=$10, notes=$11 WHERE id=$1`,
    [id, text(b.first_name, 'First name', { required: true, max: 80 }), text(b.last_name, 'Last name', { max: 80 }) || '', email, text(b.phone, 'Phone', { max: 40 }),
      text(b.nationality, 'Nationality', { max: 60 }), b.birth_date || null, !!b.vip, tags, text(b.preferences, 'Preferences', { max: 1000 }), text(b.notes, 'Notes', { max: 1000 })]);
  await audit(db, user, 'guest.update', 'guest', id, { vip: !!b.vip, tags });
  return { ok: true };
}

/** Record consent (with where it was given) or a withdrawal. */
export async function setConsent(db, user, id, consent) {
  const { rowCount } = await db.query(consent
    ? "UPDATE guests SET marketing_consent=TRUE, consent_at=now(), consent_source='front_desk', unsubscribed_at=NULL WHERE id=$1 AND merged_into IS NULL AND erased_at IS NULL"
    : 'UPDATE guests SET marketing_consent=FALSE, unsubscribed_at=now() WHERE id=$1 AND merged_into IS NULL AND erased_at IS NULL', [id]);
  if (!rowCount) throw new HttpError(404, 'Guest not found.');
  await audit(db, user, consent ? 'guest.consent_given' : 'guest.consent_withdrawn', 'guest', id);
}

/** Fold a duplicate profile into this one: stays, emails and missing details move across. */
export async function mergeGuests(db, user, keepId, dupId) {
  if (keepId === dupId) throw new HttpError(400, 'Choose a different profile.');
  const { rows } = await db.query('SELECT * FROM guests WHERE id = ANY($1) AND merged_into IS NULL AND erased_at IS NULL ORDER BY id FOR UPDATE', [[keepId, dupId]]);
  const keep = rows.find((g) => g.id === keepId), dup = rows.find((g) => g.id === dupId);
  if (!keep || !dup) throw new HttpError(404, 'Guest not found.');
  await db.query('UPDATE reservations SET guest_id=$1 WHERE guest_id=$2', [keepId, dupId]);
  await db.query('UPDATE email_outbox SET guest_id=$1 WHERE guest_id=$2 AND campaign_id IS NULL', [keepId, dupId]);
  // a withdrawal of consent on either profile wins
  const unsub = [keep.unsubscribed_at, dup.unsubscribed_at].filter(Boolean).sort((a, b) => b - a)[0] || null;
  const consent = !unsub && (keep.marketing_consent || dup.marketing_consent);
  await db.query(`UPDATE guests SET email=COALESCE(email,$2), phone=COALESCE(phone,$3), nationality=COALESCE(nationality,$4), id_type=COALESCE(id_type,$5), id_number=COALESCE(id_number,$6),
      birth_date=COALESCE(birth_date,$7), vip=vip OR $8, tags=ARRAY(SELECT DISTINCT unnest(tags || $9::text[])), preferences=concat_ws(E'\\n', preferences, $10::text), notes=concat_ws(E'\\n', notes, $11::text),
      marketing_consent=$12, unsubscribed_at=$13, consent_at=CASE WHEN $12 THEN COALESCE(consent_at,$14) ELSE consent_at END, consent_source=COALESCE(consent_source,$15) WHERE id=$1`,
  [keepId, dup.email, dup.phone, dup.nationality, dup.id_type, dup.id_number, dup.birth_date, dup.vip, dup.tags, dup.preferences, dup.notes, consent, unsub, dup.consent_at, dup.consent_source]);
  await db.query('UPDATE guests SET merged_into=$1 WHERE id=$2', [keepId, dupId]);
  await audit(db, user, 'guest.merge', 'guest', keepId, { merged: dupId });
  return { ok: true };
}

/** Right to erasure: remove personal details but keep the financial records the law requires. */
export async function eraseGuest(db, user, id) {
  const { rows: [active] } = await db.query("SELECT code FROM reservations WHERE guest_id=$1 AND status IN ('reserved','in_house') LIMIT 1", [id]);
  if (active) throw new HttpError(409, `This guest has an open booking (${active.code}). Erase after the stay.`);
  const { rowCount } = await db.query(`UPDATE guests SET first_name='Erased', last_name='guest', email=NULL, phone=NULL, nationality=NULL, id_type=NULL, id_number=NULL, notes=NULL,
      preferences=NULL, birth_date=NULL, tags='{}', vip=FALSE, marketing_consent=FALSE, unsubscribed_at=now(), erased_at=now() WHERE id=$1 AND merged_into IS NULL AND erased_at IS NULL`, [id]);
  if (!rowCount) throw new HttpError(404, 'Guest not found.');
  await db.query("UPDATE email_outbox SET to_address='erased', html='', text_body='' WHERE guest_id=$1", [id]);
  await audit(db, user, 'guest.erase', 'guest', id);
}
export async function exportGuest(db, id) {
  const p = await guestProfile(db, id);
  if (p.redirect) throw new HttpError(404, 'Guest not found.');
  const { rows: [raw] } = await db.query('SELECT id_type, id_number FROM guests WHERE id=$1', [id]);
  return { exported_at: new Date().toISOString(), profile: { ...p.guest, ...raw }, stays: p.stays, emails: p.emails };
}

/* ------------------------- templates & rendering ------------------------- */
const PLACEHOLDERS = ['first_name', 'last_name', 'property', 'arrival', 'departure', 'code', 'check_in_time', 'review_link', 'unsubscribe_link'];
export function checkPlaceholders(...texts) {
  for (const t of texts) {
    const bad = [...String(t).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).find((k) => !PLACEHOLDERS.includes(k));
    if (bad) throw new HttpError(400, `{${bad}} is not a known placeholder. Use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`);
  }
}
const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k] ?? '') : m));
const escH = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Plain text → simple branded HTML; web addresses become links. */
export function guestEmailHtml(property, body, footer) {
  const para = escH(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, '<br>').replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#a8853f">${u}</a>`)}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f6f3ee;font-family:Arial,Helvetica,sans-serif;color:#1d2a2c"><div style="max-width:600px;margin:0 auto;padding:24px">
    <div style="font-family:Georgia,serif;font-size:20px;color:#0f2a2e;margin-bottom:18px">${escH(property)}</div><div style="background:#fff;border:1px solid #e6dfd3;border-radius:10px;padding:22px;font-size:15px">${para}</div>
    ${footer ? `<p style="font-size:11px;color:#8a9496;margin-top:18px;line-height:1.5">${escH(footer.text)}${footer.link ? ` <a href="${escH(footer.link)}" style="color:#8a9496">Unsubscribe</a>` : ''}</p>` : ''}</div></body></html>`;
}
const unsubLink = (s, token) => `${String(s.public_url).replace(/\/+$/, '')}/unsubscribe/?t=${token}`;

export async function saveSettings(db, user, b) {
  const clean = (v, f) => {
    const s = text(v, f, { max: 300 });
    if (!s) return null;
    let u; try { u = new URL(s); } catch { throw new HttpError(400, `${f} must be a full web address (https://…).`); }
    if (!['https:', 'http:'].includes(u.protocol)) throw new HttpError(400, `${f} must start with https://`);
    return u.toString().replace(/\/$/, '');
  };
  await db.query('UPDATE settings SET public_url=$1, review_url=$2 WHERE id=1', [clean(b.public_url, 'Public web address'), clean(b.review_url, 'Review page')]);
  await audit(db, user, 'crm.settings', 'settings', 1);
}
export async function saveTemplate(db, user, key, b) {
  const subject = text(b.subject, 'Subject', { required: true, max: 200 }), body = text(b.body, 'Message', { required: true, max: 5000 });
  checkPlaceholders(subject, body);
  const days = Number(b.days);
  if (!Number.isInteger(days) || days < 0 || days > 30) throw new HttpError(400, 'Days must be between 0 and 30.');
  const s = await getSettings(db);
  if (b.enabled && key === 'post_stay' && !s.public_url) throw new HttpError(400, 'Set the public web address first: thank-you emails carry an unsubscribe link.');
  if (b.enabled && key === 'post_stay' && /\{review_link\}/.test(body) && !s.review_url) throw new HttpError(400, 'Set the review page address first, or remove {review_link}.');
  const { rowCount } = await db.query('UPDATE guest_email_templates SET enabled=$2, days=$3, subject=$4, body=$5 WHERE key=$1', [key, !!b.enabled, days, subject, body]);
  if (!rowCount) throw new HttpError(404, 'Unknown email.');
  await audit(db, user, 'crm.template', 'guest_email_template', key, { enabled: !!b.enabled, days });
}

/** Queue pre-arrival and post-stay emails that are due. Each stay gets each email at most once. */
export async function queueGuestEmails(db) {
  const s = await getSettings(db);
  const { rows: tpl } = await db.query('SELECT * FROM guest_email_templates WHERE enabled');
  let queued = 0;
  for (const t of tpl) {
    if (t.key === 'post_stay' && !s.public_url) continue;
    const { rows } = t.key === 'pre_arrival'
      ? await db.query(`SELECT r.id, r.code, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, g.id AS guest_id, g.first_name, g.last_name, g.email, g.unsubscribe_token
          FROM reservations r JOIN guests g ON g.id=r.guest_id WHERE r.status='reserved' AND r.arrival > $1::date AND r.arrival <= $1::date + $2::int
            AND g.email IS NOT NULL AND g.erased_at IS NULL`, [s.business_date, t.days])
      // a short window, so switching the email on never writes to guests who left long ago
      : await db.query(`SELECT r.id, r.code, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, g.id AS guest_id, g.first_name, g.last_name, g.email, g.unsubscribe_token
          FROM reservations r JOIN guests g ON g.id=r.guest_id WHERE r.status='checked_out' AND r.departure <= $1::date - $2::int AND r.departure > $1::date - $2::int - 3
            AND g.email IS NOT NULL AND g.erased_at IS NULL AND g.unsubscribed_at IS NULL`, [s.business_date, t.days]);
    for (const r of rows) {
      const v = { first_name: r.first_name, last_name: r.last_name, property: s.property_name, arrival: dmy(r.arrival), departure: dmy(r.departure), code: r.code,
        check_in_time: String(s.check_in_time || '').slice(0, 5), review_link: s.review_url || '', unsubscribe_link: s.public_url ? unsubLink(s, r.unsubscribe_token) : '' };
      const body = fill(t.body, v), subject = fill(t.subject, v);
      const footer = t.key === 'post_stay' ? { text: `You receive this because you stayed at ${s.property_name}.`, link: v.unsubscribe_link } : null;
      const { rowCount } = await db.query(`INSERT INTO email_outbox (kind, guest_id, reservation_id, to_address, subject, html, text_body) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (kind, reservation_id) WHERE reservation_id IS NOT NULL DO NOTHING`,
      [t.key, r.guest_id, r.id, r.email, subject, guestEmailHtml(s.property_name, body, footer), body + (footer ? `\n\n--\n${footer.text} Unsubscribe: ${footer.link}` : '')]);
      queued += rowCount;
    }
  }
  return { queued };
}

/* ------------------------- campaigns ------------------------- */
export async function saveCampaign(db, user, id, b) {
  const name = text(b.name, 'Name', { required: true, max: 120 }), subject = text(b.subject, 'Subject', { required: true, max: 200 }), body = text(b.body, 'Message', { required: true, max: 10000 });
  checkPlaceholders(subject, body);
  const seg = typeof b.segment === 'object' && b.segment ? b.segment : {};
  const keep = ['vip', 'tag', 'min_stays', 'max_stays', 'min_spend', 'stayed_since', 'not_since', 'source', 'nationality', 'birth_month'];
  const segment = Object.fromEntries(Object.entries(seg).filter(([k, v]) => keep.includes(k) && v !== '' && v != null && v !== false));
  let row;
  if (id) {
    ({ rows: [row] } = await db.query("UPDATE campaigns SET name=$2, subject=$3, body=$4, segment=$5 WHERE id=$1 AND status='draft' RETURNING *", [id, name, subject, body, segment]));
    if (!row) throw new HttpError(409, 'Only drafts can be changed.');
  } else ({ rows: [row] } = await db.query('INSERT INTO campaigns (name, subject, body, segment, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, subject, body, segment, user.id]));
  await audit(db, user, id ? 'campaign.update' : 'campaign.create', 'campaign', row.id, { name });
  return row;
}
/** Who a campaign reaches: the segment, limited to guests who agreed to marketing and have an email. */
async function audience(db, segment) {
  const { where, params } = segmentWhere({ ...segment, consent: 'yes' });
  const { rows } = await db.query(`SELECT x.id, x.first_name, x.last_name, x.email, g.unsubscribe_token FROM (${GUEST_STATS}) x JOIN guests g ON g.id=x.id WHERE ${where} AND x.email IS NOT NULL ORDER BY x.id`, params);
  return rows;
}
export async function previewAudience(db, segment) {
  const all = await audience(db, segment);
  const { where, params } = segmentWhere(segment);
  const { rows: [t] } = await db.query(`SELECT count(*)::int AS n FROM (${GUEST_STATS}) x WHERE ${where}`, params);
  return { recipients: all.length, matching: t.n, sample: all.slice(0, 8).map((g) => `${g.first_name} ${g.last_name}`) };
}
function campaignEmail(s, c, g) {
  const v = { first_name: g.first_name, last_name: g.last_name, property: s.property_name, review_link: s.review_url || '', unsubscribe_link: unsubLink(s, g.unsubscribe_token), arrival: '', departure: '', code: '', check_in_time: String(s.check_in_time || '').slice(0, 5) };
  const body = fill(c.body, v);
  const footer = { text: `You receive this because you agreed to hear from ${s.property_name}.`, link: v.unsubscribe_link };
  return { subject: fill(c.subject, v), html: guestEmailHtml(s.property_name, body, footer), text: `${body}\n\n--\n${footer.text} Unsubscribe: ${footer.link}` };
}
export async function testCampaign(db, user, id, to) {
  const [addr] = parseRecipients(to);
  const s = await getSettings(db);
  if (!s.public_url) throw new HttpError(400, 'Set the public web address under Automatic emails first: every campaign carries an unsubscribe link.');
  const { rows: [c] } = await db.query('SELECT * FROM campaigns WHERE id=$1', [id]);
  if (!c) throw new HttpError(404, 'Campaign not found.');
  const m = campaignEmail(s, c, { first_name: 'Sarah', last_name: 'Example', unsubscribe_token: 'test' });
  await db.query("INSERT INTO email_outbox (kind, to_address, subject, html, text_body) VALUES ('test',$1,$2,$3,$4)", [addr, '[TEST] ' + m.subject, m.html, m.text]);
  await audit(db, user, 'campaign.test', 'campaign', id, { to: addr });
  return { ok: true };
}
export async function sendCampaign(db, user, id) {
  const s = await getSettings(db);
  if (!s.public_url) throw new HttpError(400, 'Set the public web address under Automatic emails first: every campaign carries an unsubscribe link.');
  const { rows: [c] } = await db.query('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Campaign not found.');
  if (c.status !== 'draft') throw new HttpError(409, 'This campaign has already been sent.');
  const people = await audience(db, c.segment);
  if (!people.length) throw new HttpError(409, 'No guests in this audience have agreed to receive marketing emails.');
  for (const g of people) {
    const m = campaignEmail(s, c, g);
    await db.query("INSERT INTO email_outbox (kind, guest_id, campaign_id, to_address, subject, html, text_body) VALUES ('campaign',$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [g.id, c.id, g.email, m.subject, m.html, m.text]);
  }
  await db.query("UPDATE campaigns SET status='sent', recipients=$2, sent_by=$3, sent_at=now() WHERE id=$1", [c.id, people.length, user.id]);
  await audit(db, user, 'campaign.send', 'campaign', c.id, { recipients: people.length });
  return { recipients: people.length };
}

/* ------------------------- public unsubscribe ------------------------- */
async function byToken(db, token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  let { rows: [g] } = await db.query('SELECT id, merged_into, email, unsubscribed_at, marketing_consent FROM guests WHERE unsubscribe_token=$1', [token]);
  for (let i = 0; g?.merged_into && i < 10; i++) ({ rows: [g] } = await db.query('SELECT id, merged_into, email, unsubscribed_at, marketing_consent FROM guests WHERE id=$1', [g.merged_into]));
  return g || null;
}
const mask = (e) => (e ? e.replace(/^(.)[^@]*(@.*)$/, '$1•••$2') : '');
export async function unsubscribeInfo(db, token) {
  const g = await byToken(db, token);
  if (!g) throw new HttpError(404, 'This link is not valid.');
  const s = await getSettings(db);
  return { property: s.property_name, email: mask(g.email), subscribed: !g.unsubscribed_at };
}
export async function unsubscribe(db, token) {
  const g = await byToken(db, token);
  if (!g) throw new HttpError(404, 'This link is not valid.');
  await db.query('UPDATE guests SET marketing_consent=FALSE, unsubscribed_at=COALESCE(unsubscribed_at, now()) WHERE id=$1', [g.id]);
  await audit(db, null, 'guest.unsubscribe', 'guest', g.id);
  return { ok: true };
}
