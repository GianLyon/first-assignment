// Phase 8 routes: scheduled reports & email outbox (/api/reporting), group dashboard, and the
// token-protected summary other properties read (/api/group).
import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, can } from '../auth.js';
import * as rp from '../services/reports.js';
import { transportInfo } from '../email/index.js';
import { getSettings } from '../services/frontoffice.js';
import { queueGuestEmails } from '../services/crm.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// who may see each report: managers see all; others only the areas they already have access to
const SEE = { manager: ['reports.view'], front_office: ['reports.view'], fnb: ['reports.view', 'pos.manage'], stores: ['inventory.view'], finance: ['finance.view'],
  hr: ['hr.view'], events: ['events.view'], maintenance: ['maintenance.work'] };
const canSee = (user, report) => can(user, 'reports.schedule') || (SEE[report] || []).some((p) => can(user, p));

export function reportingRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const anyOf = (...p) => (req, _res, next) => { if (!p.some((x) => can(req.user, x))) throw new HttpError(403, 'You do not have permission to do this.'); next(); };
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const schedule = requirePerm('reports.schedule'), view = anyOf('reports.view', 'reports.schedule', 'inventory.view', 'finance.view', 'hr.view', 'events.view', 'maintenance.work');

  r.get('/setup', view, async (req, res) => {
    const [s] = await q('SELECT group_token_hint FROM settings WHERE id=1');
    res.json({ reports: Object.fromEntries(Object.entries(rp.REPORTS).filter(([k]) => canSee(req.user, k))), frequencies: rp.FREQUENCIES, email: transportInfo(), group_token_hint: can(req.user, 'settings.manage') ? s.group_token_hint : undefined,
      subscriptions: can(req.user, 'reports.schedule') ? await q('SELECT * FROM report_subscriptions ORDER BY report, frequency') : [] });
  });
  r.post('/subscriptions', schedule, inTx((db, req) => rp.saveSubscription(db, req.user, null, req.body || {})));
  r.put('/subscriptions/:id', schedule, inTx((db, req) => rp.saveSubscription(db, req.user, id(req), req.body || {})));

  r.get('/runs', view, async (req, res) => res.json((await q(`SELECT r.id, r.report, r.frequency, to_char(r.period_from,'YYYY-MM-DD') AS f, to_char(r.period_to,'YYYY-MM-DD') AS t, r.title, r.created_at, u.full_name AS by_name,
      (SELECT count(*) FROM email_outbox o WHERE o.run_id=r.id)::int AS emails FROM report_runs r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.id DESC LIMIT 300`)).filter((x) => canSee(req.user, x.report)).slice(0, 100)));
  r.get('/runs/:id', view, async (req, res) => {
    const [run] = await q("SELECT id, report, frequency, title, data, to_char(period_from,'YYYY-MM-DD') AS f, to_char(period_to,'YYYY-MM-DD') AS t FROM report_runs WHERE id=$1", [id(req)]);
    if (!run || !canSee(req.user, run.report)) throw new HttpError(404, 'Report not found.');
    res.json(run);
  });
  r.post('/run', view, inTx(async (db, req) => {
    const b = req.body || {};
    if (!canSee(req.user, b.report)) throw new HttpError(403, 'You do not have access to that report.');
    if (b.recipients && String(b.recipients).trim() && !can(req.user, 'reports.schedule')) throw new HttpError(403, 'Only managers can email reports.');
    return rp.runNow(db, req.user, b);
  }));

  r.get('/outbox', schedule, async (_req, res) => res.json(await q(`SELECT id, run_id, kind, to_address, subject, status, attempts, last_error, created_at, sent_at FROM email_outbox ORDER BY id DESC LIMIT 100`)));
  r.get('/outbox/:id', schedule, async (req, res) => {
    const [m] = await q('SELECT id, to_address, subject, text_body, status FROM email_outbox WHERE id=$1', [id(req)]);
    if (!m) throw new HttpError(404, 'Email not found.');
    res.json(m);
  });
  r.post('/outbox/:id/retry', schedule, inTx(async (db, req) => { await rp.retryEmail(db, req.user, id(req)); return { ok: true }; }));
  // send what is waiting now instead of within the minute
  r.post('/outbox/send', schedule, async (_req, res) => {
    await tx(pool, (db) => rp.generateDue(db));
    await tx(pool, (db) => queueGuestEmails(db));
    res.json(await rp.processOutbox(pool));
  });

  /* ---------- group dashboard ---------- */
  r.get('/group', requirePerm('group.view'), async (req, res) => {
    const s = await getSettings(pool);
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : (await q("SELECT to_char($1::date - 1,'YYYY-MM-DD') AS d", [s.business_date]))[0].d;
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : to.slice(0, 8) + '01';
    res.json(await rp.groupDashboard(pool, from, to));
  });
  const admin = requirePerm('settings.manage');
  r.get('/group/properties', admin, async (_req, res) => res.json(await q("SELECT id, name, base_url, active, last_status, last_checked_at, right(token, 4) AS hint FROM group_properties ORDER BY name")));
  r.post('/group/properties', admin, inTx((db, req) => rp.saveGroupProperty(db, req.user, null, req.body || {})));
  r.put('/group/properties/:id', admin, inTx((db, req) => rp.saveGroupProperty(db, req.user, id(req), req.body || {})));
  r.post('/group/token', admin, inTx(async (db, req) => ({ token: await rp.newGroupToken(db, req.user) })));
  r.post('/group/token/revoke', admin, inTx(async (db, req) => { await rp.revokeGroupToken(db, req.user); return { ok: true }; }));
  return r;
}

/** Read by a group office with this property's access key. Totals only, never guest details. */
export function groupPublicRouter(pool) {
  const r = express.Router();
  const hits = new Map();
  r.get('/summary', async (req, res) => {
    // a light per-address limit: a wrong key cannot be tried quickly
    const key = req.ip, now = Date.now(), h = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (h.length >= 60) throw new HttpError(429, 'Too many requests.');
    h.push(now); hits.set(key, h);
    if (!(await rp.checkGroupToken(pool, req.get('authorization')))) throw new HttpError(401, 'A valid group access key is required.');
    res.set('Cache-Control', 'no-store');
    res.json(await rp.propertySummary(pool, String(req.query.from || ''), String(req.query.to || '')));
  });
  return r;
}
