// Beta: the version running, what staff report from inside the app, errors seen by the app or the server,
// the system's health, and the checklist a hotel works through before it goes live.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HttpError, audit } from '../auth.js';
import { getSettings } from './frontoffice.js';
import { transportInfo } from '../email/index.js';
import { backupConfig, storageReady } from '../backup.js';
import { waConfig } from './whatsapp.js';
import { aiConfig } from './assistant.js';
import { channexConfigured } from '../channels/channex.js';
import { providers } from '../payments/index.js';

const env = process.env;
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const STARTED = new Date();
const commit = (env.RENDER_GIT_COMMIT || env.GIT_COMMIT || '').slice(0, 7);
export const version = () => ({ version: pkg.version, commit: commit || null, label: `${pkg.version}${commit ? '+' + commit : ''}`, beta: true, started_at: STARTED.toISOString() });

const str = (v, max) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);

/* ---------- errors ---------- */
/** Keep one row per distinct error and count repeats. Never throws: reporting must not break anything. */
export async function recordError(pool, { kind, message, source, stack, page, userId, userAgent }) {
  try {
    const msg = str(message, 500) || 'Unknown error';
    const src = str(source, 300);
    const firstFrame = str(stack, 4000).split('\n').find((l) => /\bat\b|@/.test(l)) || '';
    const fp = crypto.createHash('sha256').update(`${kind}|${msg}|${src}|${firstFrame.replace(/:\d+:\d+/g, '')}`).digest('hex').slice(0, 40);
    await pool.query(
      `INSERT INTO app_errors (kind, fingerprint, message, source, stack, page, version, user_id, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (fingerprint) DO UPDATE SET count=app_errors.count + 1, last_at=now(), page=EXCLUDED.page, version=EXCLUDED.version, user_id=COALESCE(EXCLUDED.user_id, app_errors.user_id)`,
      [kind, fp, msg, src || null, str(stack, 4000) || null, str(page, 300) || null, version().label, userId || null, str(userAgent, 300) || null]);
  } catch (e) { console.error('Could not record error:', e.message); }
}

/* ---------- feedback ---------- */
const KINDS = { problem: 'Problem', idea: 'Idea', question: 'Question' };
export async function submitFeedback(db, user, b, userAgent) {
  const kind = KINDS[b.kind] ? b.kind : 'problem';
  const message = str(b.message, 4000);
  if (message.length < 3) throw new HttpError(400, 'Tell us what happened (a sentence is enough).');
  const { rows: [f] } = await db.query('INSERT INTO feedback (user_id, kind, message, page, version, user_agent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [user.id, kind, message, str(b.page, 300) || null, version().label, str(userAgent, 300) || null]);
  // forward to Azeli support when an address is set (sent with the other emails)
  const to = env.SUPPORT_EMAIL;
  if (to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    const s = await getSettings(db);
    const subject = `[${s.property_name}] ${KINDS[kind]} from ${user.full_name}`.slice(0, 200);
    const text = `${KINDS[kind]} reported in Azeli PMS ${version().label}\nHotel: ${s.property_name}\nFrom: ${user.full_name} (${user.username}, ${user.role})\nPage: ${f.page || '-'}\n\n${message}`;
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    await db.query("INSERT INTO email_outbox (kind, to_address, subject, html, text_body) VALUES ('support',$1,$2,$3,$4)", [to, subject, `<pre style="font-family:inherit;white-space:pre-wrap">${esc(text)}</pre>`, text]);
  }
  await audit(db, user, 'beta.feedback', 'feedback', f.id, { kind });
  return { id: f.id, forwarded: !!to };
}
export async function listFeedback(db, { status = 'open' } = {}) {
  const where = status === 'all' ? 'true' : status === 'done' ? "f.status='done'" : "f.status <> 'done'";
  const { rows } = await db.query(`SELECT f.*, u.full_name, u.role FROM feedback f LEFT JOIN users u ON u.id=f.user_id WHERE ${where} ORDER BY f.id DESC LIMIT 200`);
  return rows;
}
export async function updateFeedback(db, user, id, b) {
  const status = ['new', 'seen', 'done'].includes(b.status) ? b.status : null;
  if (!status) throw new HttpError(400, 'Unknown status.');
  const { rows: [f] } = await db.query('UPDATE feedback SET status=$2, reply=COALESCE($3, reply), updated_at=now() WHERE id=$1 RETURNING *', [id, status, str(b.reply, 2000) || null]);
  if (!f) throw new HttpError(404, 'Not found.');
  await audit(db, user, 'beta.feedback_status', 'feedback', id, { status });
  return f;
}

/* ---------- integrations ---------- */
function integrations(s) {
  const pay = providers[s.payment_provider];
  const wa = waConfig(), ai = aiConfig(), mail = transportInfo(), bk = backupConfig();
  const pesapalLive = s.payment_provider === 'pesapal' && pay?.configured?.() && pay.mode() === 'live';
  return [
    { key: 'email', name: 'Email (reports, guest emails)', state: mail.live ? 'live' : 'test', note: mail.live ? mail.from : 'Kept in the outbox, not sent. Set EMAIL_TRANSPORT=smtp and SMTP_URL.', paid: true },
    { key: 'backups', name: 'Nightly off-site backups', state: storageReady(bk) && env.BACKUP_KEY ? 'live' : 'off', note: storageReady(bk) ? 'Cloudflare R2 / S3' : 'Set BACKUP_KEY and the BACKUP_S3_* keys.', paid: false },
    { key: 'payments', name: 'Online payments', state: !s.online_payments ? 'off' : s.payment_provider === 'simulator' ? 'test' : pesapalLive ? 'live' : pay?.configured?.() ? 'test' : 'off',
      note: !s.online_payments ? 'Switched off' : `${pay?.label || s.payment_provider}${pay?.mode ? ' · ' + pay.mode() : ''}`, paid: true },
    { key: 'whatsapp', name: 'WhatsApp Business', state: wa.token && wa.phoneNumberId ? 'live' : 'test', note: wa.token ? (wa.displayNumber || 'Connected') : 'Practice mode until the Meta keys are set.', paid: true },
    { key: 'channels', name: 'OTAs through Channex', state: channexConfigured() ? (String(env.CHANNEX_API_BASE || '').includes('staging') ? 'test' : 'live') : 'off', note: channexConfigured() ? (env.CHANNEX_API_BASE || 'app.channex.io') : 'Set CHANNEX_API_KEY.', paid: true },
    { key: 'ai', name: 'AI assistant (Claude)', state: ai.enabled ? 'live' : 'off', note: ai.enabled ? ai.model : 'The to-do lists work without it. Set ANTHROPIC_API_KEY.', paid: true },
    { key: 'support', name: 'Feedback forwarded to Azeli', state: env.SUPPORT_EMAIL ? 'live' : 'off', note: env.SUPPORT_EMAIL ? `To ${env.SUPPORT_EMAIL}` : 'Set SUPPORT_EMAIL (and email) to receive reports by email.', paid: false },
  ];
}

/* ---------- health ---------- */
export async function health(pool) {
  const s = await getSettings(pool);
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const db = await one('SELECT pg_database_size(current_database())::bigint AS bytes, now() AS now, version() AS pg');
  const backup = await one("SELECT status, finished_at, started_at, size_bytes, error FROM backup_runs ORDER BY id DESC LIMIT 1").catch(() => null);
  const audit = await one("SELECT to_char(MAX(business_date),'YYYY-MM-DD') AS last, MAX(run_at) AS at FROM night_audits");
  const mail = await one("SELECT count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='failed')::int AS failed FROM email_outbox");
  const ari = await one('SELECT count(*)::int AS pending, MIN(created_at) AS oldest FROM ari_outbox WHERE processed_at IS NULL');
  const ch = (await pool.query('SELECT code, name, last_error FROM channels WHERE active AND last_error IS NOT NULL')).rows;
  const errs = (await pool.query("SELECT id, kind, message, source, page, version, count, first_at, last_at FROM app_errors ORDER BY last_at DESC LIMIT 30")).rows;
  const err24 = await one("SELECT COALESCE(SUM(count) FILTER (WHERE last_at > now() - interval '24 hours'),0)::int AS n FROM app_errors");
  const fb = await one("SELECT count(*) FILTER (WHERE status='new')::int AS new, count(*) FILTER (WHERE status <> 'done')::int AS open FROM feedback");
  const users = await one("SELECT count(*) FILTER (WHERE active)::int AS active, (SELECT count(DISTINCT user_id) FROM sessions WHERE created_at > now() - interval '7 days')::int AS week FROM users");
  const behind = audit.last ? Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(audit.last)) / 864e5) : null;
  return {
    version: version(), uptime_s: Math.round((Date.now() - STARTED) / 1000), node: process.version, production: env.NODE_ENV === 'production',
    public_url: env.PUBLIC_URL || null, business_date: s.business_date, demo_data: s.demo_data,
    database: { bytes: Number(db.bytes), engine: String(db.pg).split(' on ')[0] },
    backup, night_audit: { last: audit.last, at: audit.at, days_behind: behind },
    email: mail, ari, channel_errors: ch, errors: errs, errors_24h: err24.n, feedback: fb, users,
    integrations: integrations(s),
  };
}

/* ---------- go-live checklist ---------- */
export async function goLive(pool) {
  const s = await getSettings(pool);
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const n = async (sql, p = []) => Number((await one(sql, p)).n);
  const rooms = await n('SELECT count(*) AS n FROM rooms WHERE active');
  const types = await n('SELECT count(*) AS n FROM room_types');
  const plans = await n('SELECT count(*) AS n FROM rate_plans WHERE active AND on_website');
  const staff = await n("SELECT count(*) AS n FROM users WHERE active AND username <> 'admin' AND username <> 'demo'");
  const mfaRoles = Array.isArray(s.mfa_required_roles) ? s.mfa_required_roles : [];
  const lastAudit = (await one("SELECT to_char(MAX(business_date),'YYYY-MM-DD') AS d FROM night_audits")).d;
  const backup = await one("SELECT finished_at FROM backup_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").catch(() => null);
  const mapped = await n("SELECT count(*) AS n FROM channel_mappings m JOIN channels c ON c.id=m.channel_id WHERE c.active AND c.adapter='channex'").catch(() => 0);
  const pay = providers[s.payment_provider];
  const i = Object.fromEntries(integrations(s).map((x) => [x.key, x]));
  const items = [
    { key: 'details', group: 'The hotel', title: 'Hotel details for invoices and receipts', done: !!(s.legal_name && s.address && s.contact_phone && s.contact_email), detail: 'Legal name, address, phone, email (and TIN if VAT-registered).', link: '#settings', required: true },
    { key: 'rooms', group: 'The hotel', title: 'Room types and rooms', done: rooms > 0 && types > 0, detail: `${types} room types, ${rooms} rooms.`, link: '#settings', required: true },
    { key: 'rates', group: 'The hotel', title: 'Rate plans for the website and OTAs', done: plans > 0, detail: `${plans} active on the website.`, link: '#plans', required: true },
    { key: 'sample', group: 'The hotel', title: 'Sample data removed', done: !s.demo_data, detail: s.demo_data ? 'The practice hotel is still loaded. Remove it before real guests are entered.' : 'Real data only.', link: '#settings', required: true },
    { key: 'staff', group: 'People', title: 'Staff have their own sign-ins', done: staff >= 2, detail: `${staff} staff accounts besides the administrator.`, link: '#users', required: true },
    { key: 'mfa', group: 'People', title: 'Two-step sign-in for managers', done: ['admin', 'general_manager'].every((r) => mfaRoles.includes(r)), detail: 'Required at least for the administrator and general manager.', link: '#users', required: true },
    { key: 'audit', group: 'Daily routine', title: 'Night audit is being run', done: !!lastAudit && (Date.parse(s.business_date) - Date.parse(lastAudit)) / 864e5 <= 2, detail: lastAudit ? `Last run for ${lastAudit}.` : 'Never run yet.', link: '#audit', required: true },
    { key: 'url', group: 'Hosting', title: 'Secure public address', done: /^https:\/\//.test(env.PUBLIC_URL || ''), detail: env.PUBLIC_URL || 'PUBLIC_URL is not set.', link: null, required: true },
    { key: 'backups', group: 'Hosting', title: 'Nightly backups stored off-site', done: i.backups.state === 'live' && !!backup && Date.now() - new Date(backup.finished_at) < 2 * 864e5, detail: i.backups.state === 'live' ? (backup ? `Last good backup ${new Date(backup.finished_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'Set up, no backup yet.') : i.backups.note, link: '#settings', required: true },
    { key: 'email', group: 'Paid services', title: 'Email sending', done: i.email.state === 'live', detail: i.email.note, link: null, required: false, paid: 'Brevo, about $9 a month (free tier to start)' },
    { key: 'booking', group: 'Selling', title: 'Booking engine switched on', done: !!s.booking_enabled, detail: s.booking_enabled ? 'Guests can book on the website.' : 'Online booking is off.', link: '#bookingengine', required: false },
    { key: 'payments', group: 'Paid services', title: 'Online payments (Pesapal, live)', done: i.payments.state === 'live', detail: i.payments.note, link: '#bookingengine', required: false, paid: 'Pesapal: a fee per payment, no monthly fee' },
    { key: 'whatsapp', group: 'Paid services', title: 'WhatsApp connected', done: i.whatsapp.state === 'live', detail: i.whatsapp.note, link: '#whatsapp', required: false, paid: 'Meta: per message; replies within 24 h free' },
    { key: 'channels', group: 'Paid services', title: 'OTAs connected through Channex', done: i.channels.state === 'live' && mapped > 0, detail: mapped ? `${mapped} room/rate mappings.` : i.channels.note, link: '#channels', required: false, paid: 'Channex: per property per month' },
    { key: 'ai', group: 'Paid services', title: 'AI assistant', done: i.ai.state === 'live', detail: i.ai.note, link: '#assistant', required: false, paid: 'Anthropic: pay as you use (set a monthly limit)' },
    { key: 'review', group: 'Selling', title: 'Review link for thank-you messages', done: !!s.review_url, detail: s.review_url || 'Add the Google or TripAdvisor review link.', link: '#settings', required: false },
  ];
  void pay;
  const req = items.filter((x) => x.required);
  return { items, required_done: req.filter((x) => x.done).length, required_total: req.length, done: items.filter((x) => x.done).length, total: items.length };
}
