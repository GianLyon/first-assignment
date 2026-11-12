// Phase 9 routes: guest profiles & marketing (/api/crm) and the public unsubscribe endpoints (/api/marketing).
import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm } from '../auth.js';
import * as crm from '../services/crm.js';

export function crmRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const view = requirePerm('reservations.view'), manage = requirePerm('guests.manage'), mkt = requirePerm('marketing.manage');
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

  /* guests */
  r.get('/guests', view, async (req, res) => {
    const seg = { ...req.query };
    res.json(await crm.listGuests(pool, seg, { limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0, sort: req.query.sort }));
  });
  r.get('/guests/:id', view, async (req, res) => res.json(await crm.guestProfile(pool, id(req))));
  r.put('/guests/:id', manage, inTx((db, req) => crm.updateGuest(db, req.user, id(req), req.body || {})));
  r.post('/guests/:id/consent', manage, inTx(async (db, req) => { await crm.setConsent(db, req.user, id(req), req.body?.consent === true); return { ok: true }; }));
  r.post('/guests/:id/merge', manage, inTx((db, req) => crm.mergeGuests(db, req.user, id(req), Number(req.body?.duplicate_id))));
  r.get('/guests/:id/export', mkt, async (req, res) => { res.set('Content-Disposition', `attachment; filename="guest-${id(req)}.json"`); res.json(await crm.exportGuest(pool, id(req))); });
  r.post('/guests/:id/erase', mkt, inTx(async (db, req) => { await crm.eraseGuest(db, req.user, id(req)); return { ok: true }; }));

  /* automatic emails & settings */
  r.get('/settings', mkt, async (_req, res) => res.json({ settings: (await q('SELECT public_url, review_url FROM settings WHERE id=1'))[0], templates: await q('SELECT * FROM guest_email_templates ORDER BY key DESC') }));
  r.put('/settings', mkt, inTx(async (db, req) => { await crm.saveSettings(db, req.user, req.body || {}); return { ok: true }; }));
  r.put('/templates/:key', mkt, inTx(async (db, req) => { await crm.saveTemplate(db, req.user, req.params.key, req.body || {}); return { ok: true }; }));

  /* campaigns */
  r.get('/campaigns', mkt, async (_req, res) => res.json(await q(`SELECT c.*, u.full_name AS sent_by_name,
      (SELECT count(*) FROM email_outbox o WHERE o.campaign_id=c.id AND o.status IN ('sent','test'))::int AS delivered,
      (SELECT count(*) FROM email_outbox o WHERE o.campaign_id=c.id AND o.status='failed')::int AS failed,
      (SELECT count(*) FROM email_outbox o JOIN guests g ON g.id=o.guest_id WHERE o.campaign_id=c.id AND g.unsubscribed_at > c.sent_at)::int AS unsubscribed
    FROM campaigns c LEFT JOIN users u ON u.id=c.sent_by ORDER BY c.id DESC`)));
  r.get('/campaigns/:id', mkt, async (req, res) => {
    const [c] = await q('SELECT * FROM campaigns WHERE id=$1', [id(req)]);
    if (!c) throw new HttpError(404, 'Campaign not found.');
    res.json({ campaign: c, audience: await crm.previewAudience(pool, c.segment) });
  });
  r.post('/audience', mkt, async (req, res) => res.json(await crm.previewAudience(pool, req.body?.segment || {})));
  r.post('/campaigns', mkt, inTx((db, req) => crm.saveCampaign(db, req.user, null, req.body || {})));
  r.put('/campaigns/:id', mkt, inTx((db, req) => crm.saveCampaign(db, req.user, id(req), req.body || {})));
  r.post('/campaigns/:id/test', mkt, inTx((db, req) => crm.testCampaign(db, req.user, id(req), req.body?.to)));
  r.post('/campaigns/:id/send', mkt, inTx((db, req) => crm.sendCampaign(db, req.user, id(req))));
  return r;
}

export function marketingPublicRouter(pool) {
  const r = express.Router();
  r.get('/unsubscribe/:token', async (req, res) => res.json(await crm.unsubscribeInfo(pool, req.params.token)));
  r.post('/unsubscribe', async (req, res) => res.json(await tx(pool, (db) => crm.unsubscribe(db, req.body?.token))));
  return r;
}
