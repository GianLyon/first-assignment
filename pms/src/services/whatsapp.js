// Phase 12: WhatsApp for the front desk. One conversation per guest number, an inbox in the PMS, approved
// templates, and automations that follow guests through their stay. Talks to the WhatsApp Business Platform
// (Cloud API). Without its keys it runs in practice mode (messages are kept here and not sent) on test systems
// and on systems holding sample data; on a live system it stays off until connected.
import crypto from 'node:crypto';
import { HttpError, audit } from '../auth.js';
import { getSettings } from './frontoffice.js';

const env = process.env;
export function waConfig() {
  return {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    apiVersion: /^v\d+\.\d+$/.test(env.WHATSAPP_API_VERSION || '') ? env.WHATSAPP_API_VERSION : 'v25.0',
    apiBase: (env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, ''),
    displayNumber: env.WHATSAPP_DISPLAY_NUMBER || '',
  };
}
/** live: connected to WhatsApp · practice: kept in the system, not sent · off: not set up on a live system */
export function waMode(settings) {
  const c = waConfig();
  if (c.token && c.phoneNumberId) return 'live';
  if (env.WHATSAPP_MODE === 'simulator' || env.NODE_ENV !== 'production' || settings?.demo_data) return 'practice';
  return 'off';
}

/* ------------------------- phone numbers ------------------------- */
/**
 * Any way a number is written ("0772 123 456", "+256 772-123456", "00256…") → international digits ("256772123456").
 * Local numbers (leading 0) take the hotel's country code. Returns null when it cannot be a phone number.
 */
export function normalizePhone(raw, countryCode = '256') {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (!plus && d.startsWith('00')) d = d.slice(2);
  else if (!plus && d.startsWith('0')) d = countryCode + d.slice(1);
  else if (!plus && d.length <= 9) d = countryCode + d;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}
export const formatPhone = (d) => (d ? '+' + d : '');

/* ------------------------- templates ------------------------- */
export const PARAM_KEYS = {
  first_name: 'First name', last_name: 'Last name', property: 'Hotel name', code: 'Booking number', arrival: 'Arrival date', departure: 'Departure date',
  nights: 'Number of nights', room: 'Room number', room_type: 'Room type', check_in_time: 'Check-in time', check_out_time: 'Check-out time', review_link: 'Review page',
};
const placeholderCount = (body) => Math.max(0, ...[...String(body).matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
const longDate = (d) => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '');
/** The values a template can use, for a guest and (optionally) one of their bookings. */
export function templateValues(s, g = {}, r = null) {
  const n = r ? Math.round((new Date(r.departure + 'T00:00:00Z') - new Date(r.arrival + 'T00:00:00Z')) / 864e5) : '';
  return {
    first_name: g.first_name || 'Guest', last_name: g.last_name || '', property: s.property_name, code: r?.code || '', arrival: longDate(r?.arrival), departure: longDate(r?.departure),
    nights: String(n), room: r?.room || '', room_type: r?.room_type || '', check_in_time: String(s.check_in_time || '').slice(0, 5), check_out_time: String(s.check_out_time || '').slice(0, 5),
    review_link: s.review_url || '',
  };
}
export const fillTemplate = (body, params) => String(body).replace(/\{\{(\d+)\}\}/g, (m, i) => params[Number(i) - 1] ?? m);
// WhatsApp refuses template values that are empty, multi-line or very long
function cleanParams(tpl, params) {
  const need = placeholderCount(tpl.body);
  if (!Array.isArray(params) || params.length !== need) throw new HttpError(400, `This template needs ${need} value${need === 1 ? '' : 's'}.`);
  return params.map((p, i) => {
    const v = String(p ?? '').replace(/\s+/g, ' ').trim();
    if (!v) throw new HttpError(400, `Fill in value {{${i + 1}}}${tpl.params[i] ? ` (${PARAM_KEYS[tpl.params[i]] || tpl.params[i]})` : ''}.`);
    if (v.length > 300) throw new HttpError(400, `Value {{${i + 1}}} is too long.`);
    return v;
  });
}

export async function saveTemplate(db, user, id, b) {
  const name = String(b.name || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,100}$/.test(name)) throw new HttpError(400, 'The template name must match WhatsApp Manager: small letters, numbers and underscores only.');
  const language = String(b.language || 'en').trim();
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw new HttpError(400, 'Language is a code such as en, en_GB or fr.');
  const category = b.category === 'marketing' ? 'marketing' : 'utility';
  const body = String(b.body || '').trim();
  if (!body || body.length > 1024) throw new HttpError(400, 'Enter the template wording (up to 1,024 characters).');
  const need = placeholderCount(body);
  const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  if (nums.some((n) => n < 1) || new Set(nums).size !== need) throw new HttpError(400, 'Number the placeholders {{1}}, {{2}}, {{3}} … in order, as in WhatsApp Manager.');
  const params = (Array.isArray(b.params) ? b.params : []).slice(0, need).map(String);
  while (params.length < need) params.push('');
  if (params.some((p) => p && !PARAM_KEYS[p])) throw new HttpError(400, 'Unknown value for a placeholder.');
  const vals = [name, language, category, body, params, !!b.approved];
  const { rows: [t] } = id
    ? await db.query('UPDATE wa_templates SET name=$2, language=$3, category=$4, body=$5, params=$6, approved=$7 WHERE id=$1 RETURNING *', [id, ...vals])
    : await db.query('INSERT INTO wa_templates (name, language, category, body, params, approved) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', vals);
  if (!t) throw new HttpError(404, 'Template not found.');
  if (!t.approved) await db.query('UPDATE wa_automations SET enabled=FALSE WHERE template_id=$1', [t.id]);
  await audit(db, user, id ? 'whatsapp.template.update' : 'whatsapp.template.create', 'wa_template', t.id, { name, approved: t.approved });
  return t;
}

export const TRIGGERS = {
  booking_confirmed: 'When a booking is made', pre_arrival: 'Days before arrival', arrival_day: 'After check-in (arrival day)', mid_stay: 'Days after arrival, while in-house',
  pre_departure: 'Days before departure, while in-house', post_stay: 'Days after check-out', birthday: 'On the guest\'s birthday (past guests)',
};
export async function saveAutomation(db, user, id, b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 80) throw new HttpError(400, 'Give the automation a short name.');
  if (!TRIGGERS[b.trigger]) throw new HttpError(400, 'Choose when it sends.');
  const days = Number(b.days ?? 0);
  if (!Number.isInteger(days) || days < 0 || days > 60) throw new HttpError(400, 'Days must be between 0 and 60.');
  const { rows: [t] } = await db.query('SELECT * FROM wa_templates WHERE id=$1', [Number(b.template_id)]);
  if (!t) throw new HttpError(400, 'Choose a template.');
  if (b.enabled && !t.approved) throw new HttpError(400, `Mark the template "${t.name}" as approved first (once WhatsApp Manager shows it as Active).`);
  if (b.enabled && t.params.some((p) => !p)) throw new HttpError(400, `Say what fills each placeholder of "${t.name}" first.`);
  if (b.enabled && t.params.includes('review_link') && !(await getSettings(db)).review_url) throw new HttpError(400, 'Set the review page address (Automatic emails page) first: the template uses it.');
  const vals = [b.trigger, days, t.id, name, !!b.enabled];
  const { rows: [a] } = id
    ? await db.query(`UPDATE wa_automations SET trigger=$2, days=$3, template_id=$4, name=$5, enabled=$6,
        enabled_at = CASE WHEN $6 AND NOT enabled THEN now() WHEN $6 THEN enabled_at ELSE NULL END WHERE id=$1 RETURNING *`, [id, ...vals])
    : await db.query('INSERT INTO wa_automations (trigger, days, template_id, name, enabled, enabled_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 THEN now() END) RETURNING *', vals);
  if (!a) throw new HttpError(404, 'Automation not found.');
  await audit(db, user, 'whatsapp.automation', 'wa_automation', a.id, { trigger: a.trigger, days, enabled: a.enabled });
  return a;
}

export async function saveSettings(db, user, b) {
  const cc = String(b.phone_country_code || '').replace(/\D/g, '');
  if (!/^[1-9]\d{0,3}$/.test(cc)) throw new HttpError(400, 'Country code is digits only, for example 256 for Uganda.');
  const from = Number(b.wa_quiet_from), to = Number(b.wa_quiet_to);
  if (![from, to].every((h) => Number.isInteger(h) && h >= 0 && h <= 23)) throw new HttpError(400, 'Quiet hours are whole hours from 0 to 23.');
  await db.query('UPDATE settings SET phone_country_code=$1, wa_quiet_from=$2, wa_quiet_to=$3 WHERE id=1', [cc, from, to]);
  await audit(db, user, 'whatsapp.settings', 'settings', 1, { phone_country_code: cc, quiet: [from, to] });
}

/* ------------------------- conversations ------------------------- */
const WINDOW_MS = 24 * 3600e3;
export const windowOpen = (c, now = Date.now()) => !!c.last_inbound_at && now - new Date(c.last_inbound_at).getTime() < WINDOW_MS;

/** The guest a number belongs to: the one in-house, else the most recent stay. */
async function findGuestByNumber(db, waId, cc) {
  const tail = waId.slice(-9);
  const { rows } = await db.query(`SELECT g.id, g.phone, (SELECT max(r.arrival) FROM reservations r WHERE r.guest_id=g.id) AS last_arrival,
      EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id=g.id AND r.status='in_house') AS in_house
    FROM guests g WHERE g.merged_into IS NULL AND g.erased_at IS NULL AND g.phone IS NOT NULL AND regexp_replace(g.phone,'\\D','','g') LIKE '%' || $1
    ORDER BY in_house DESC, last_arrival DESC NULLS LAST, g.id DESC`, [tail]);
  return rows.find((g) => normalizePhone(g.phone, cc) === waId)?.id || null;
}
async function upsertConversation(db, waId, { guestId = null, contactId = null, name = null } = {}) {
  const { rows: [c] } = await db.query(`INSERT INTO wa_conversations (wa_id, guest_id, contact_id, profile_name) VALUES ($1,$2,$3,$4)
    ON CONFLICT (wa_id) DO UPDATE SET guest_id=COALESCE(EXCLUDED.guest_id, wa_conversations.guest_id), contact_id=COALESCE(EXCLUDED.contact_id, wa_conversations.contact_id),
      profile_name=COALESCE(EXCLUDED.profile_name, wa_conversations.profile_name) RETURNING *`, [waId, guestId, contactId, name]);
  return c;
}

/** Open (or find) the conversation with a guest, a phone-book contact or any number. */
export async function startConversation(db, user, b) {
  const s = await getSettings(db);
  let waId, guestId = null, contactId = null;
  if (b.guest_id) {
    const { rows: [g] } = await db.query('SELECT id, phone FROM guests WHERE id=$1 AND merged_into IS NULL AND erased_at IS NULL', [Number(b.guest_id)]);
    if (!g) throw new HttpError(404, 'Guest not found.');
    waId = normalizePhone(g.phone, s.phone_country_code); guestId = g.id;
    if (!waId) throw new HttpError(400, 'This guest has no usable phone number. Add one to their profile first.');
  } else if (b.contact_id) {
    const { rows: [k] } = await db.query('SELECT id, phone FROM contacts WHERE id=$1', [Number(b.contact_id)]);
    if (!k) throw new HttpError(404, 'Contact not found.');
    waId = normalizePhone(k.phone, s.phone_country_code); contactId = k.id;
    if (!waId) throw new HttpError(400, 'This contact has no usable phone number.');
  } else {
    waId = normalizePhone(b.phone, s.phone_country_code);
    if (!waId) throw new HttpError(400, 'Enter a phone number, with the country code for foreign numbers (for example +254 712 345678).');
    guestId = await findGuestByNumber(db, waId, s.phone_country_code);
  }
  const c = await upsertConversation(db, waId, { guestId, contactId });
  await audit(db, user, 'whatsapp.conversation', 'wa_conversation', c.id, {});
  return { id: c.id };
}

const CONV_SELECT = `SELECT c.*, g.first_name, g.last_name, g.vip, g.whatsapp_opt_in, k.name AS contact_name, k.company AS contact_company, u.full_name AS assigned_name,
    (SELECT row_to_json(x) FROM (SELECT m.body, m.direction, m.kind, m.status, m.created_at FROM wa_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) x) AS last,
    (SELECT rm.number FROM reservations r JOIN rooms rm ON rm.id=r.room_id WHERE r.guest_id=c.guest_id AND r.status='in_house' ORDER BY r.arrival DESC LIMIT 1) AS room
  FROM wa_conversations c LEFT JOIN guests g ON g.id=c.guest_id LEFT JOIN contacts k ON k.id=c.contact_id LEFT JOIN users u ON u.id=c.assigned_to`;
const decorate = (c) => ({ ...c, phone: formatPhone(c.wa_id), window_open: windowOpen(c), window_ends: c.last_inbound_at ? new Date(new Date(c.last_inbound_at).getTime() + WINDOW_MS).toISOString() : null,
  display_name: c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : c.contact_name || c.profile_name || formatPhone(c.wa_id) });

export async function listConversations(db, { filter = 'open', q = '' } = {}) {
  const w = [], p = [];
  if (filter === 'open') w.push("c.status='open'");
  if (filter === 'unread') w.push('c.unread > 0');
  if (filter === 'in_house') w.push("EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id=c.guest_id AND r.status='in_house')");
  if (filter === 'done') w.push("c.status='done'");
  if (q) { p.push(`%${String(q).toLowerCase().slice(0, 60)}%`); w.push(`(lower(coalesce(g.first_name,'') || ' ' || coalesce(g.last_name,'')) LIKE $1 OR lower(coalesce(c.profile_name,'')) LIKE $1 OR lower(coalesce(k.name,'')) LIKE $1 OR c.wa_id LIKE $1)`); }
  const { rows } = await db.query(`${CONV_SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY c.last_message_at DESC LIMIT 200`, p);
  return rows.map(decorate);
}
export const unreadCount = async (db) => (await db.query("SELECT COALESCE(SUM(unread),0)::int AS n FROM wa_conversations WHERE status='open'")).rows[0].n;

/** One conversation, its messages, the guest's bookings and ready-to-send templates. Opening it marks it read. */
export async function getConversation(db, id, { markRead = true } = {}) {
  const { rows: [c] } = await db.query(`${CONV_SELECT} WHERE c.id=$1`, [id]);
  if (!c) throw new HttpError(404, 'Conversation not found.');
  if (markRead && c.unread) await db.query('UPDATE wa_conversations SET unread=0 WHERE id=$1', [id]);
  const { rows: msgs } = await db.query(`SELECT m.id, m.direction, m.kind, m.body, m.status, m.error, m.created_at, m.status_at, u.full_name AS sent_by_name, a.name AS automation_name, t.name AS template_name
    FROM wa_messages m LEFT JOIN users u ON u.id=m.sent_by LEFT JOIN wa_automations a ON a.id=m.automation_id LEFT JOIN wa_templates t ON t.id=m.template_id
    WHERE m.conversation_id=$1 ORDER BY m.id DESC LIMIT 300`, [id]);
  const s = await getSettings(db);
  let guest = null, stays = [];
  if (c.guest_id) {
    guest = (await db.query('SELECT id, first_name, last_name, email, phone, vip, preferences, notes, whatsapp_opt_in, whatsapp_opt_out_at, marketing_consent, unsubscribed_at FROM guests WHERE id=$1', [c.guest_id])).rows[0];
    stays = (await db.query(`SELECT r.id, r.code, r.status, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, rm.number AS room, t.name AS room_type
      FROM reservations r JOIN room_types t ON t.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.guest_id=$1 AND r.status IN ('reserved','in_house','checked_out')
      ORDER BY (r.status='in_house') DESC, (r.status='reserved') DESC, r.arrival DESC LIMIT 5`, [c.guest_id])).rows;
  }
  const current = stays.find((r) => r.status !== 'checked_out') || stays[0] || null;
  const vals = templateValues(s, guest || { first_name: c.profile_name?.split(' ')[0] || c.contact_name || '' }, current);
  const { rows: tpls } = await db.query('SELECT * FROM wa_templates WHERE approved ORDER BY category, name');
  return {
    conversation: decorate({ ...c, unread: 0 }), messages: msgs.reverse(), guest, stays, mode: waMode(s),
    templates: tpls.map((t) => ({ id: t.id, name: t.name, language: t.language, category: t.category, body: t.body, params: t.params, values: t.params.map((k) => vals[k] ?? '') })),
  };
}

export async function updateConversation(db, user, id, b) {
  const sets = [], vals = [id];
  if (b.status !== undefined) { if (!['open', 'done'].includes(b.status)) throw new HttpError(400, 'Unknown status.'); vals.push(b.status); sets.push(`status=$${vals.length}`); }
  if (b.assigned_to !== undefined) { vals.push(b.assigned_to ? Number(b.assigned_to) : null); sets.push(`assigned_to=$${vals.length}`); }
  if (b.guest_id !== undefined) { vals.push(b.guest_id ? Number(b.guest_id) : null); sets.push(`guest_id=$${vals.length}`); }
  if (!sets.length) return { ok: true };
  const { rowCount } = await db.query(`UPDATE wa_conversations SET ${sets.join(', ')} WHERE id=$1`, vals);
  if (!rowCount) throw new HttpError(404, 'Conversation not found.');
  await audit(db, user, 'whatsapp.conversation.update', 'wa_conversation', id, b);
  return { ok: true };
}

/**
 * Queue a message. Free text only inside the 24 hours after the guest's last message (WhatsApp's rule);
 * outside it, an approved template, and only to a guest who agreed to WhatsApp messages.
 */
export async function queueMessage(db, user, convId, b, { automationId = null, reservationId = null } = {}) {
  const s = await getSettings(db);
  if (waMode(s) === 'off') throw new HttpError(409, 'WhatsApp is not connected yet. An administrator sets it up under Settings (see the go-live guide).');
  const { rows: [c] } = await db.query(`SELECT c.*, g.whatsapp_opt_in, g.marketing_consent, g.unsubscribed_at FROM wa_conversations c LEFT JOIN guests g ON g.id=c.guest_id WHERE c.id=$1 FOR UPDATE OF c`, [convId]);
  if (!c) throw new HttpError(404, 'Conversation not found.');
  if (c.opted_out_at) throw new HttpError(409, 'This person replied STOP and does not want WhatsApp messages. They can send START to allow them again.');
  let row;
  if (b.template_id) {
    const { rows: [t] } = await db.query('SELECT * FROM wa_templates WHERE id=$1', [Number(b.template_id)]);
    if (!t) throw new HttpError(404, 'Template not found.');
    if (!t.approved) throw new HttpError(409, 'This template is not approved yet.');
    if (!windowOpen(c) && c.guest_id && !c.whatsapp_opt_in) throw new HttpError(409, 'The guest has not agreed to WhatsApp messages. Ask them to message you first, or record their agreement on the registration card.');
    if (t.category === 'marketing' && !(c.marketing_consent && !c.unsubscribed_at) && !windowOpen(c)) throw new HttpError(409, 'Promotional templates need the guest\'s marketing consent.');
    const params = cleanParams(t, b.params);
    row = { kind: 'template', body: fillTemplate(t.body, params), template_id: t.id, params };
  } else {
    const text = String(b.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Type a message.');
    if (text.length > 4096) throw new HttpError(400, 'Messages can be up to 4,096 characters.');
    if (!windowOpen(c)) throw new HttpError(409, 'More than 24 hours have passed since the guest last wrote, so WhatsApp only allows an approved template. Choose one below.');
    row = { kind: 'text', body: text, template_id: null, params: null };
  }
  const { rows: [m] } = await db.query(`INSERT INTO wa_messages (conversation_id, direction, kind, body, template_id, params, status, sent_by, automation_id, reservation_id)
    VALUES ($1,'out',$2,$3,$4,$5,'queued',$6,$7,$8) RETURNING id`, [c.id, row.kind, row.body, row.template_id, row.params, user?.id ?? null, automationId, reservationId]);
  await db.query("UPDATE wa_conversations SET last_message_at=now(), status=CASE WHEN $2 THEN status ELSE 'open' END WHERE id=$1", [c.id, !!automationId]);
  return { id: m.id };
}

/* ------------------------- sending ------------------------- */
async function callApi(cfg, payload) {
  const res = await fetch(`${cfg.apiBase}/${cfg.apiVersion}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.messages?.[0]?.id) {
    const e = data.error || {};
    throw new Error(e.error_data?.details || e.message || `WhatsApp answered ${res.status}`);
  }
  return data.messages[0].id;
}
let sending = Promise.resolve();
/** Send queued messages (one at a time, in order). Safe to call from requests and the timer at once. */
export function deliverQueued(pool, { limit = 50 } = {}) {
  const run = sending.then(() => deliverNow(pool, limit));
  sending = run.catch(() => {});
  return run;
}
async function deliverNow(pool, limit) {
  const s = (await pool.query('SELECT * FROM settings WHERE id=1')).rows[0];
  const mode = waMode(s), cfg = waConfig();
  if (mode === 'off') return { sent: 0, failed: 0 };
  const { rows } = await pool.query(`SELECT m.*, c.wa_id, t.name AS template_name, t.language FROM wa_messages m JOIN wa_conversations c ON c.id=m.conversation_id
    LEFT JOIN wa_templates t ON t.id=m.template_id WHERE m.status='queued' ORDER BY m.id LIMIT $1`, [limit]);
  let sent = 0, failed = 0;
  for (const m of rows) {
    try {
      let waMessageId;
      if (mode === 'practice') waMessageId = 'practice.' + crypto.randomBytes(9).toString('hex');
      else {
        const payload = m.kind === 'template'
          ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: m.wa_id, type: 'template',
            template: { name: m.template_name, language: { code: m.language }, components: m.params?.length ? [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }] : [] } }
          : { messaging_product: 'whatsapp', recipient_type: 'individual', to: m.wa_id, type: 'text', text: { preview_url: true, body: m.body } };
        waMessageId = await callApi(cfg, payload);
      }
      await pool.query("UPDATE wa_messages SET status=$2, wa_message_id=$3, status_at=now() WHERE id=$1 AND status='queued'", [m.id, mode === 'practice' ? 'delivered' : 'sent', waMessageId]);
      sent++;
    } catch (e) {
      await pool.query("UPDATE wa_messages SET status='failed', error=$2, status_at=now() WHERE id=$1 AND status='queued'", [m.id, String(e.message).slice(0, 300)]);
      failed++;
    }
  }
  return { sent, failed };
}

/* ------------------------- receiving (webhook) ------------------------- */
/** Meta signs each delivery with the app secret: X-Hub-Signature-256: sha256=<hex HMAC of the raw body>. */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !rawBody || !/^sha256=[0-9a-f]{64}$/.test(String(header || ''))) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(String(header).slice(7), 'hex'));
}
const STOP = /^\s*(stop|unsubscribe|stop all|opt out|cancel messages)\s*[.!]*\s*$/i;
const START = /^\s*(start|subscribe|unstop)\s*[.!]*\s*$/i;
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
const MEDIA_LABEL = { image: 'Photo', video: 'Video', audio: 'Voice note', document: 'Document', sticker: 'Sticker', location: 'Location', contacts: 'Contact card' };

/** Store incoming messages and delivery receipts. Repeated deliveries of the same event are ignored. */
export async function handleWebhook(db, payload) {
  const s = await getSettings(db);
  let received = 0, statuses = 0;
  for (const entry of payload?.entry || []) {
    for (const ch of entry?.changes || []) {
      const v = ch?.value || {};
      const names = Object.fromEntries((v.contacts || []).map((k) => [String(k.wa_id), k.profile?.name || null]));
      for (const msg of v.messages || []) {
        const waId = String(msg.from || '').replace(/\D/g, '');
        if (!/^[1-9]\d{6,14}$/.test(waId) || !msg.id) continue;
        let c = (await db.query('SELECT * FROM wa_conversations WHERE wa_id=$1 FOR UPDATE', [waId])).rows[0];
        if (!c) c = await upsertConversation(db, waId, { guestId: await findGuestByNumber(db, waId, s.phone_country_code), name: names[waId] });
        else if (names[waId] && names[waId] !== c.profile_name) await db.query('UPDATE wa_conversations SET profile_name=$2 WHERE id=$1', [c.id, names[waId]]);
        let kind = 'text', body = '';
        if (msg.type === 'text') body = String(msg.text?.body || '');
        else if (msg.type === 'button') body = String(msg.button?.text || '');
        else if (msg.type === 'interactive') body = String(msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '');
        else if (msg.type === 'location') { kind = 'media'; const l = msg.location || {}; body = `[Location] ${l.name || ''} https://maps.google.com/?q=${Number(l.latitude)},${Number(l.longitude)}`.replace(/\s+/g, ' '); }
        else if (MEDIA_LABEL[msg.type]) { kind = 'media'; body = `[${MEDIA_LABEL[msg.type]}]${msg[msg.type]?.caption ? ' ' + msg[msg.type].caption : ''}`; }
        else { kind = 'other'; body = '[A message type the system cannot show yet]'; }
        const at = Number(msg.timestamp) ? new Date(Number(msg.timestamp) * 1000) : new Date();
        const { rowCount } = await db.query(`INSERT INTO wa_messages (conversation_id, direction, kind, body, wa_message_id, status, created_at) VALUES ($1,'in',$2,$3,$4,'received',$5)
          ON CONFLICT (wa_message_id) DO NOTHING`, [c.id, kind, body.slice(0, 4096), String(msg.id).slice(0, 200), at]);
        if (!rowCount) continue;
        received++;
        await db.query(`UPDATE wa_conversations SET last_inbound_at=GREATEST(COALESCE(last_inbound_at, $2), $2), last_message_at=now(), unread=unread+1, status='open' WHERE id=$1`, [c.id, at]);
        if (kind === 'text' && STOP.test(body) && !c.opted_out_at) {
          await db.query('UPDATE wa_conversations SET opted_out_at=now() WHERE id=$1', [c.id]);
          if (c.guest_id) await db.query('UPDATE guests SET whatsapp_opt_in=FALSE, whatsapp_opt_out_at=now() WHERE id=$1', [c.guest_id]);
          await db.query(`INSERT INTO wa_messages (conversation_id, direction, kind, body, status) VALUES ($1,'out','text',$2,'queued')`,
            [c.id, `You will not receive any more WhatsApp messages from ${s.property_name}. Reply START at any time to allow them again.`]);
        } else if (kind === 'text' && START.test(body) && c.opted_out_at) {
          await db.query('UPDATE wa_conversations SET opted_out_at=NULL WHERE id=$1', [c.id]);
          if (c.guest_id) await db.query('UPDATE guests SET whatsapp_opt_in=TRUE, whatsapp_opt_in_at=now(), whatsapp_opt_out_at=NULL WHERE id=$1', [c.guest_id]);
          await db.query(`INSERT INTO wa_messages (conversation_id, direction, kind, body, status) VALUES ($1,'out','text',$2,'queued')`,
            [c.id, `Thank you. ${s.property_name} can message you on WhatsApp again. Reply STOP at any time to stop.`]);
        }
      }
      for (const st of v.statuses || []) {
        if (!st?.id || !(st.status in RANK)) continue;
        const err = st.errors?.[0] ? String(st.errors[0].error_data?.details || st.errors[0].title || st.errors[0].message || 'Not delivered').slice(0, 300) : null;
        const { rowCount } = await db.query(`UPDATE wa_messages SET status=$2, error=COALESCE($3, error), status_at=now() WHERE wa_message_id=$1 AND direction='out'
          AND (CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END) < $4`, [String(st.id), st.status, err, RANK[st.status]]);
        statuses += rowCount;
      }
    }
  }
  return { received, statuses };
}

/** Practice mode: make a guest "reply", exactly as the webhook would deliver it. */
export async function practiceReply(db, convId, text) {
  const s = await getSettings(db);
  if (waMode(s) !== 'practice') throw new HttpError(409, 'Practice replies only work while WhatsApp is in practice mode.');
  const { rows: [c] } = await db.query('SELECT * FROM wa_conversations WHERE id=$1', [convId]);
  if (!c) throw new HttpError(404, 'Conversation not found.');
  const body = String(text || '').trim();
  if (!body) throw new HttpError(400, 'Type the guest\'s reply.');
  return handleWebhook(db, { entry: [{ changes: [{ value: { contacts: [{ wa_id: c.wa_id, profile: { name: c.profile_name } }],
    messages: [{ from: c.wa_id, id: 'practice.in.' + crypto.randomBytes(9).toString('hex'), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: body.slice(0, 4096) } }] } }] }] });
}

/* ------------------------- automations ------------------------- */
const hourIn = (tz, now) => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || 'Africa/Kampala' }).format(now));
export function isQuiet(s, now = new Date()) {
  const h = hourIn(s.timezone, now), from = s.wa_quiet_from, to = s.wa_quiet_to;
  if (from === to) return false;
  return from > to ? h >= from || h < to : h >= from && h < to;
}
const STAY_COLS = `r.id, r.code, r.guest_id, to_char(r.arrival,'YYYY-MM-DD') AS arrival, to_char(r.departure,'YYYY-MM-DD') AS departure, rm.number AS room, t.name AS room_type`;
const STAY_FROM = 'FROM reservations r JOIN room_types t ON t.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id';
function candidates(db, a, bd) {
  switch (a.trigger) {
    case 'booking_confirmed': return db.query(`SELECT ${STAY_COLS} ${STAY_FROM} WHERE r.status IN ('reserved','in_house') AND r.created_at >= $1 AND r.departure > $2::date`, [a.enabled_at, bd]);
    case 'pre_arrival': return db.query(`SELECT ${STAY_COLS} ${STAY_FROM} WHERE r.status='reserved' AND r.arrival > $1::date AND r.arrival <= $1::date + $2::int`, [bd, a.days]);
    case 'arrival_day': return db.query(`SELECT ${STAY_COLS} ${STAY_FROM} WHERE r.status='in_house' AND r.arrival >= $1::date - 1 AND r.checked_in_at >= $2`, [bd, a.enabled_at]);
    case 'mid_stay': return db.query(`SELECT ${STAY_COLS} ${STAY_FROM} WHERE r.status='in_house' AND r.arrival + $2::int <= $1::date AND r.departure > $1::date`, [bd, Math.max(1, a.days)]);
    case 'pre_departure': return db.query(`SELECT ${STAY_COLS} ${STAY_FROM} WHERE r.status='in_house' AND r.departure - $2::int <= $1::date AND r.departure >= $1::date`, [bd, a.days]);
    // a short window, so switching it on never writes to guests who left long ago
    case 'post_stay': return db.query(`SELECT ${STAY_COLS} ${STAY_FROM} WHERE r.status='checked_out' AND r.departure <= $1::date - $2::int AND r.departure > $1::date - $2::int - 3`, [bd, a.days]);
    case 'birthday': return db.query(`SELECT NULL::int AS id, NULL AS code, g.id AS guest_id, NULL AS arrival, NULL AS departure, NULL AS room, NULL AS room_type FROM guests g
      WHERE g.birth_date IS NOT NULL AND to_char(g.birth_date,'MM-DD') = to_char($1::date,'MM-DD') AND g.merged_into IS NULL AND g.erased_at IS NULL
        AND EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id=g.id AND r.status IN ('in_house','checked_out'))`, [bd]);
    default: return { rows: [] };
  }
}

/** Queue every automation message that is due. Each stay (or birthday) gets each automation once. */
export async function runAutomations(db, { now = new Date() } = {}) {
  const s = await getSettings(db);
  if (waMode(s) === 'off' || isQuiet(s, now)) return { queued: 0, skipped: 0 };
  const bd = String(s.business_date instanceof Date ? s.business_date.toISOString() : s.business_date).slice(0, 10);
  const { rows: autos } = await db.query(`SELECT a.*, t.body, t.params, t.category, t.approved FROM wa_automations a JOIN wa_templates t ON t.id=a.template_id WHERE a.enabled AND t.approved ORDER BY a.id`);
  let queued = 0, skipped = 0;
  for (const a of autos) {
    for (const r of (await candidates(db, a, bd)).rows) {
      const key = a.trigger === 'birthday' ? `g:${r.guest_id}:${bd.slice(0, 4)}` : `r:${r.id}`;
      const { rowCount } = await db.query('INSERT INTO wa_automation_runs (automation_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.id, key]);
      if (!rowCount) continue;
      const { rows: [g] } = await db.query('SELECT * FROM guests WHERE id=$1', [r.guest_id]);
      const waId = normalizePhone(g?.phone, s.phone_country_code);
      let why = null;
      if (!g || g.erased_at || g.merged_into) why = 'Guest profile removed';
      else if (!waId) why = 'No usable phone number';
      else if (!g.whatsapp_opt_in) why = 'Guest has not agreed to WhatsApp messages';
      else if (a.category === 'marketing' && !(g.marketing_consent && !g.unsubscribed_at)) why = 'No marketing consent';
      let messageId = null;
      if (!why) {
        const c = await upsertConversation(db, waId, { guestId: g.id });
        if (c.opted_out_at) why = 'Replied STOP';
        else {
          const vals = templateValues(s, g, r);
          try { messageId = (await queueMessage(db, null, c.id, { template_id: a.template_id, params: a.params.map((k) => vals[k] ?? '') }, { automationId: a.id, reservationId: r.id })).id; }
          catch (e) { why = e.message.slice(0, 200); }
        }
      }
      await db.query('UPDATE wa_automation_runs SET message_id=$3, skipped=$4 WHERE automation_id=$1 AND key=$2', [a.id, key, messageId, why]);
      if (messageId) queued++; else skipped++;
    }
  }
  return { queued, skipped };
}

export async function automationStats(db) {
  const { rows } = await db.query(`SELECT a.id, count(r.*) FILTER (WHERE r.message_id IS NOT NULL)::int AS sent, count(r.*) FILTER (WHERE r.skipped IS NOT NULL)::int AS skipped,
      (SELECT json_agg(x) FROM (SELECT r2.skipped AS reason, count(*)::int AS n FROM wa_automation_runs r2 WHERE r2.automation_id=a.id AND r2.skipped IS NOT NULL GROUP BY r2.skipped ORDER BY n DESC LIMIT 3) x) AS reasons
    FROM wa_automations a LEFT JOIN wa_automation_runs r ON r.automation_id=a.id GROUP BY a.id`);
  return Object.fromEntries(rows.map((x) => [x.id, x]));
}
