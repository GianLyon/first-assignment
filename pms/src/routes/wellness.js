// Spa and health club routes (mounted at /api/wellness).
import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, can } from '../auth.js';
import * as w from '../services/wellness.js';

export function wellnessRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const use = (req, _res, next) => { if (!['amenities.sell', 'amenities.manage'].some((p) => can(req.user, p))) throw new HttpError(403, 'You do not have permission to do this.'); next(); };
  const manage = requirePerm('amenities.manage');
  const LISTS = { therapists: 'spa_therapists', 'spa-rooms': 'spa_rooms', plans: 'club_plans' };
  const list = (req) => { const t = LISTS[req.params.list]; if (!t) throw new HttpError(404, 'Not found.'); return t; };

  r.get('/spa', use, async (req, res) => res.json(await w.spaDay(pool, req.query.date)));
  r.post('/setup/:list', manage, inTx((db, req) => w.saveSimple(db, req.user, list(req), null, req.body || {})));
  r.put('/setup/:list/:id', manage, inTx((db, req) => w.saveSimple(db, req.user, list(req), id(req), req.body || {})));

  r.get('/club/members', use, async (req, res) => res.json(await w.listMembers(pool, { q: req.query.q || '', filter: String(req.query.filter || 'current') })));
  r.post('/club/members', use, inTx((db, req) => w.saveMember(db, req.user, null, req.body || {})));
  r.put('/club/members/:id', use, inTx((db, req) => w.saveMember(db, req.user, id(req), req.body || {})));
  r.post('/club/members/:id/renew', use, inTx((db, req) => w.renewMember(db, req.user, id(req), req.body || {})));
  r.post('/club/members/:id/status', manage, inTx((db, req) => w.setMemberStatus(db, req.user, id(req), req.body?.status)));
  r.post('/club/checkin', use, inTx((db, req) => w.checkIn(db, req.user, req.body || {})));
  r.get('/club/visits', use, async (_req, res) => res.json(await w.visitsToday(pool)));
  return r;
}
