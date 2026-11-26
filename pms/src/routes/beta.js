// Beta routes: version (public), error reports from the app, feedback, system health and the go-live checklist.
import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, requireUser } from '../auth.js';
import * as beta from '../services/beta.js';

function limiter(max, windowMs) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now(), key = req.ip, h = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) throw new HttpError(429, 'Too many requests. Please wait a minute and try again.');
    h.push(now); hits.set(key, h);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

export function betaRouter(pool) {
  const r = express.Router();
  const admin = requirePerm('settings.manage');
  r.get('/version', (_req, res) => res.json(beta.version()));
  // errors seen in someone's browser; a few per minute per device at most
  r.post('/client-errors', limiter(20, 60e3), async (req, res) => {
    const b = req.body || {};
    await beta.recordError(pool, { kind: 'client', message: b.message, source: b.source, stack: b.stack, page: b.page, userId: req.user?.id, userAgent: req.headers['user-agent'] });
    res.json({ ok: true });
  });
  r.post('/feedback', requireUser, limiter(10, 60e3), async (req, res) => res.json(await tx(pool, (db) => beta.submitFeedback(db, req.user, req.body || {}, req.headers['user-agent']))));
  r.get('/feedback', admin, async (req, res) => res.json(await beta.listFeedback(pool, { status: String(req.query.status || 'open') })));
  r.put('/feedback/:id', admin, async (req, res) => {
    const id = Number(req.params.id); if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id.');
    res.json(await tx(pool, (db) => beta.updateFeedback(db, req.user, id, req.body || {})));
  });
  r.get('/system/health', admin, async (_req, res) => res.json(await beta.health(pool)));
  r.get('/system/golive', admin, async (_req, res) => res.json(await beta.goLive(pool)));
  r.post('/system/errors/clear', admin, async (_req, res) => { await pool.query('DELETE FROM app_errors'); res.json({ ok: true }); });
  return r;
}
