// Phase 13 routes: the front-desk assistant (/api/assistant).
import express from 'express';
import { HttpError, requirePerm, can } from '../auth.js';
import * as ai from '../services/assistant.js';
import { insights, DEPT_PERMS } from '../services/insights.js';

export function assistantRouter(pool) {
  const r = express.Router();
  const use = requirePerm('assistant.use');
  r.get('/tasks', use, async (_req, res) => res.json(await ai.frontDeskTasks(pool)));
  // every department the user may see
  r.get('/insights', use, async (req, res) => {
    const only = Object.entries(DEPT_PERMS).filter(([, perms]) => perms.some((p) => can(req.user, p))).map(([d]) => d);
    res.json(await insights(pool, { only }));
  });
  r.get('/status', use, async (req, res) => {
    const c = ai.aiConfig();
    res.json({ ai_enabled: c.enabled, model: c.model, hourly_limit: c.hourlyLimit, usage: can(req.user, 'settings.manage') ? await ai.usageSummary(pool) : undefined });
  });
  r.post('/chat', use, async (req, res) => res.json(await ai.chat(pool, req.user, req.body?.messages)));
  r.post('/whatsapp-draft/:id', requirePerm('messages.use'), async (req, res) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.');
    res.json(await ai.suggestWhatsAppReply(pool, req.user, n));
  });
  return r;
}
