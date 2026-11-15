// Phase 12 routes: the phone book and WhatsApp inbox (/api/messages) and WhatsApp's webhook (/api/whatsapp).
import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, audit } from '../auth.js';
import { getSettings } from '../services/frontoffice.js';
import * as wa from '../services/whatsapp.js';
import * as pb from '../services/phonebook.js';

export function messagingRouter(pool) {
  const r = express.Router();
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const use = requirePerm('messages.use'), manage = requirePerm('messages.manage');
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

  /* phone book */
  r.get('/phonebook', use, async (req, res) => res.json(await pb.phoneBook(pool, { q: req.query.q || '', kind: req.query.kind || 'all' })));
  r.get('/phonebook/export', use, async (req, res) => {
    const rows = await pb.phoneBook(pool, { q: req.query.q || '', kind: req.query.kind || 'all', limit: 20000 });
    const s = await getSettings(pool);
    await audit(pool, req.user, 'phonebook.export', 'contacts', null, { format: req.query.format, kind: req.query.kind || 'all', rows: rows.length });
    if (req.query.format === 'csv') { res.type('text/csv').set('Content-Disposition', 'attachment; filename="phone-book.csv"').send('﻿' + pb.toCsv(rows)); return; }
    res.type('text/vcard').set('Content-Disposition', 'attachment; filename="phone-book.vcf"').send(pb.toVcard(rows, s.property_name));
  });
  r.post('/contacts', use, inTx((db, req) => pb.saveContact(db, req.user, null, req.body || {})));
  r.put('/contacts/:id', use, inTx((db, req) => pb.saveContact(db, req.user, id(req), req.body || {})));
  r.post('/contacts/:id/delete', use, inTx(async (db, req) => { await pb.deleteContact(db, req.user, id(req)); return { ok: true }; }));

  /* inbox */
  r.get('/unread', use, async (_req, res) => res.json({ unread: await wa.unreadCount(pool) }));
  r.get('/conversations', use, async (req, res) => {
    const s = await getSettings(pool);
    res.json({ mode: wa.waMode(s), conversations: await wa.listConversations(pool, { filter: req.query.filter || 'open', q: req.query.q || '' }) });
  });
  r.post('/conversations', use, inTx((db, req) => wa.startConversation(db, req.user, req.body || {})));
  r.get('/conversations/:id', use, inTx((db, req) => wa.getConversation(db, id(req), { markRead: req.query.peek !== '1' })));
  r.put('/conversations/:id', use, inTx((db, req) => wa.updateConversation(db, req.user, id(req), req.body || {})));
  r.post('/conversations/:id/messages', use, async (req, res) => {
    const m = await tx(pool, (db) => wa.queueMessage(db, req.user, id(req), req.body || {}));
    await wa.deliverQueued(pool);
    const [row] = await q('SELECT id, status, error FROM wa_messages WHERE id=$1', [m.id]);
    if (row.status === 'failed') throw new HttpError(502, `WhatsApp did not accept the message: ${row.error}`);
    res.json(row);
  });
  r.post('/conversations/:id/practice-reply', use, async (req, res) => {
    const out = await tx(pool, (db) => wa.practiceReply(db, id(req), req.body?.text));
    await wa.deliverQueued(pool);
    res.json(out);
  });
  r.put('/guests/:id/whatsapp', requirePerm('guests.manage'), inTx(async (db, req) => {
    const yes = req.body?.opt_in === true;
    const { rowCount } = await db.query(yes
      ? 'UPDATE guests SET whatsapp_opt_in=TRUE, whatsapp_opt_in_at=now(), whatsapp_opt_out_at=NULL WHERE id=$1 AND merged_into IS NULL AND erased_at IS NULL'
      : 'UPDATE guests SET whatsapp_opt_in=FALSE WHERE id=$1 AND merged_into IS NULL AND erased_at IS NULL', [id(req)]);
    if (!rowCount) throw new HttpError(404, 'Guest not found.');
    await audit(db, req.user, yes ? 'guest.whatsapp_opt_in' : 'guest.whatsapp_opt_out', 'guest', id(req));
    return { ok: true };
  }));

  /* set-up: templates, automations, settings */
  r.get('/setup', manage, async (req, res) => {
    const s = await getSettings(pool), c = wa.waConfig();
    const base = (s.public_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    res.json({
      mode: wa.waMode(s), connected: !!(c.token && c.phoneNumberId), display_number: c.displayNumber, api_version: c.apiVersion,
      has_app_secret: !!c.appSecret, has_verify_token: !!c.verifyToken, webhook_url: `${base}/api/whatsapp/webhook`,
      settings: { phone_country_code: s.phone_country_code, wa_quiet_from: s.wa_quiet_from, wa_quiet_to: s.wa_quiet_to, timezone: s.timezone, review_url: s.review_url },
      templates: await q('SELECT * FROM wa_templates ORDER BY id'),
      automations: await q('SELECT a.*, t.name AS template_name, t.approved FROM wa_automations a JOIN wa_templates t ON t.id=a.template_id ORDER BY a.id'),
      stats: await wa.automationStats(pool), param_keys: wa.PARAM_KEYS, triggers: wa.TRIGGERS,
    });
  });
  r.put('/settings', manage, inTx(async (db, req) => { await wa.saveSettings(db, req.user, req.body || {}); return { ok: true }; }));
  r.post('/templates', manage, inTx((db, req) => wa.saveTemplate(db, req.user, null, req.body || {})));
  r.put('/templates/:id', manage, inTx((db, req) => wa.saveTemplate(db, req.user, id(req), req.body || {})));
  r.post('/automations', manage, inTx((db, req) => wa.saveAutomation(db, req.user, null, req.body || {})));
  r.put('/automations/:id', manage, inTx((db, req) => wa.saveAutomation(db, req.user, id(req), req.body || {})));
  r.post('/automations/run', manage, async (_req, res) => {
    const out = await tx(pool, (db) => wa.runAutomations(db));
    const sent = await wa.deliverQueued(pool);
    res.json({ ...out, ...sent });
  });
  return r;
}

/** WhatsApp's webhook: the one-time check when it is connected, then incoming messages and delivery receipts. */
export function whatsappWebhookRouter(pool) {
  const r = express.Router();
  r.get('/webhook', (req, res) => {
    const c = wa.waConfig();
    if (req.query['hub.mode'] === 'subscribe' && c.verifyToken && req.query['hub.verify_token'] === c.verifyToken) { res.type('text/plain').send(String(req.query['hub.challenge'] ?? '')); return; }
    res.status(403).json({ error: 'Verification failed.' });
  });
  r.post('/webhook', async (req, res) => {
    if (!wa.verifySignature(req.rawBody, req.get('x-hub-signature-256'), wa.waConfig().appSecret)) throw new HttpError(401, 'Bad signature.');
    const out = await tx(pool, (db) => wa.handleWebhook(db, req.body));
    res.json({ ok: true, ...out });
    wa.deliverQueued(pool).catch((e) => console.error('WhatsApp send failed:', e.message));
  });
  return r;
}
