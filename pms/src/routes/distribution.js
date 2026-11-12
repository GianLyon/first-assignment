import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, audit } from '../auth.js';
import * as dist from '../services/distribution.js';
import { getSettings } from '../services/frontoffice.js';
import { validateEndpoint, adapters } from '../channels/index.js';
import * as pay from '../services/onlinepay.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Small in-memory rate limiter: `max` requests per `windowMs` per key. */
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

/* ---------- public website booking engine (no sign-in) ---------- */
export function publicRouter(pool) {
  const r = express.Router();
  // limits per IP per minute; PUBLIC_WRITE_LIMIT / PUBLIC_READ_LIMIT can tune them
  const reads = limiter(Number(process.env.PUBLIC_READ_LIMIT || 60), 60e3), writes = limiter(Number(process.env.PUBLIC_WRITE_LIMIT || 10), 60e3);
  r.get('/info', reads, async (_req, res) => {
    const s = await getSettings(pool);
    res.json({ property_name: s.property_name, booking_enabled: s.booking_enabled, intro: s.booking_intro, cancellation_policy: s.cancellation_policy,
      check_in_time: String(s.check_in_time).slice(0, 5), check_out_time: String(s.check_out_time).slice(0, 5), today: s.business_date,
      horizon_days: s.booking_horizon_days, contact_phone: s.contact_phone, contact_email: s.contact_email, currency: s.currency, online_payments: s.online_payments });
  });
  r.get('/availability', reads, async (req, res) => res.json(await dist.quote(pool, { arrival: req.query.arrival, departure: req.query.departure, adults: req.query.adults })));
  r.post('/bookings', writes, async (req, res) => res.json(await tx(pool, (db) => dist.createPublicBooking(db, req.body || {}))));
  r.post('/bookings/lookup', writes, async (req, res) => res.json(await dist.lookupPublicBooking(pool, req.body?.code, req.body?.email)));
  r.post('/bookings/pay', writes, async (req, res) => res.json(await tx(pool, (db) => pay.startPayment(db, req.body?.code, req.body?.email))));
  r.get('/pay/:token', reads, async (req, res) => res.json(await pay.intentInfo(pool, req.params.token)));
  // Test checkout only: confirms a payment without a real provider. Refused unless the simulator is the active provider.
  r.post('/pay/test', writes, async (req, res) => {
    const s = await getSettings(pool);
    if (!s.online_payments || s.payment_provider !== 'simulator') throw new HttpError(403, 'Test payments are switched off.');
    res.json(await tx(pool, (db) => pay.completePayment(db, { token: req.body?.token, status: req.body?.outcome === 'paid' ? 'paid' : 'failed', provider_ref: 'TEST-' + Date.now(), method: req.body?.method })));
  });
  r.post('/bookings/cancel', writes, async (req, res) => res.json(await tx(pool, (db) => dist.cancelPublicBooking(db, req.body?.code, req.body?.email))));
  return r;
}

/* ---------- signed messages from channels (no sign-in; HMAC instead) ---------- */
export function inboundRouter(pool) {
  const r = express.Router();
  r.post('/:code/inbound', limiter(120, 60e3), async (req, res) => res.json(await dist.receiveInbound(pool, req.params.code, req.rawBody, req.headers['x-azeli-signature'])));
  return r;
}

/* ---------- staff: rates, plans, channels, booking engine settings ---------- */
export function distributionRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const manage = requirePerm('distribution.manage'), view = requirePerm('reservations.view');
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

  r.get('/rate-plans', view, async (_req, res) => res.json(await q('SELECT * FROM rate_plans ORDER BY sort, id')));
  r.post('/rate-plans', manage, inTx((db, req) => dist.savePlan(db, req.user, null, req.body || {})));
  r.put('/rate-plans/:id', manage, inTx((db, req) => dist.savePlan(db, req.user, id(req), req.body || {})));

  r.get('/calendar', view, async (req, res) => {
    const s = await getSettings(pool);
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : s.business_date;
    res.json(await dist.calendarView(pool, from, Math.min(31, Math.max(1, Number(req.query.days) || 14))));
  });
  r.put('/calendar', manage, inTx((db, req) => dist.updateCalendar(db, req.user, req.body || {})));
  r.get('/quote', view, async (req, res) => res.json(await dist.quote(pool, { arrival: req.query.arrival, departure: req.query.departure, adults: req.query.adults })));

  r.get('/channels', manage, async (_req, res) => res.json({
    adapters: Object.entries(adapters).map(([k, a]) => ({ id: k, label: a.label })),
    channels: await q(`SELECT c.id, c.code, c.name, c.adapter, c.endpoint_url, c.commission_pct, c.active, c.last_push_at, c.last_error,
        (SELECT count(*) FROM channel_mappings m WHERE m.channel_id=c.id)::int AS mappings,
        (SELECT count(*) FROM reservations r WHERE r.channel_id=c.id AND r.status IN ('reserved','in_house'))::int AS active_bookings
      FROM channels c ORDER BY c.id`),
    pending_changes: (await q('SELECT count(*)::int AS n FROM ari_outbox WHERE processed_at IS NULL'))[0].n,
  }));
  const channelBody = (b, isNew) => {
    const out = { name: String(b.name || '').trim(), adapter: b.adapter, commission_pct: Number(b.commission_pct || 0), active: b.active !== false };
    if (!out.name) throw new HttpError(400, 'Name is required.');
    if (!adapters[out.adapter]) throw new HttpError(400, 'Choose a connector.');
    if (!(out.commission_pct >= 0 && out.commission_pct < 100)) throw new HttpError(400, 'Commission must be 0–99%.');
    out.endpoint_url = b.endpoint_url ? (() => { try { return validateEndpoint(String(b.endpoint_url).trim()); } catch (e) { throw new HttpError(400, e.message); } })() : null;
    if (out.adapter === 'webhook' && !out.endpoint_url) throw new HttpError(400, 'The webhook connector needs an endpoint URL.');
    if (isNew) { out.code = String(b.code || '').trim().toLowerCase(); if (!/^[a-z0-9-]{2,30}$/.test(out.code)) throw new HttpError(400, 'Code: 2–30 lowercase letters, numbers or dashes.'); }
    return out;
  };
  r.post('/channels', manage, inTx(async (db, req) => {
    const b = channelBody(req.body || {}, true), secret = dist.newSecret();
    const { rows: [c] } = await db.query('INSERT INTO channels (code, name, adapter, endpoint_url, commission_pct, active, secret) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code, name',
      [b.code, b.name, b.adapter, b.endpoint_url, b.commission_pct, b.active, secret]);
    await audit(db, req.user, 'distribution.channel_create', 'channel', c.id, { code: c.code, adapter: b.adapter });
    return { ...c, secret }; // shown once
  }));
  r.put('/channels/:id', manage, inTx(async (db, req) => {
    const b = channelBody(req.body || {}, false);
    const { rows: [c] } = await db.query('UPDATE channels SET name=$2, adapter=$3, endpoint_url=$4, commission_pct=$5, active=$6 WHERE id=$1 RETURNING id, code, name, active',
      [id(req), b.name, b.adapter, b.endpoint_url, b.commission_pct, b.active]);
    if (!c) throw new HttpError(404, 'Channel not found.');
    await audit(db, req.user, 'distribution.channel_update', 'channel', c.id, { active: c.active, adapter: b.adapter });
    return c;
  }));
  r.post('/channels/:id/secret', manage, inTx(async (db, req) => {
    const secret = dist.newSecret();
    const { rowCount } = await db.query('UPDATE channels SET secret=$2 WHERE id=$1', [id(req), secret]);
    if (!rowCount) throw new HttpError(404, 'Channel not found.');
    await audit(db, req.user, 'distribution.channel_secret_rotated', 'channel', id(req));
    return { secret };
  }));
  r.get('/channels/:id/mappings', manage, async (req, res) => res.json(await q('SELECT * FROM channel_mappings WHERE channel_id=$1', [id(req)])));
  r.put('/channels/:id/mappings', manage, inTx(async (db, req) => {
    const cid = id(req); const list = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
    await db.query('DELETE FROM channel_mappings WHERE channel_id=$1', [cid]);
    for (const m of list) {
      const room = String(m.external_room_code || '').trim(), rate = String(m.external_rate_code || '').trim();
      if (!room || !rate) continue;
      await db.query('INSERT INTO channel_mappings (channel_id, room_type_id, rate_plan_id, external_room_code, external_rate_code) VALUES ($1,$2,$3,$4,$5)', [cid, Number(m.room_type_id), Number(m.rate_plan_id), room.slice(0, 40), rate.slice(0, 40)]);
    }
    await audit(db, req.user, 'distribution.channel_mappings', 'channel', cid, { count: list.length });
    return { ok: true };
  }));
  r.get('/channels/:id/log', manage, async (req, res) => res.json(await q('SELECT id, direction, kind, status, summary, created_at FROM channel_log WHERE channel_id=$1 ORDER BY id DESC LIMIT 100', [id(req)])));
  r.post('/channels/:id/full-sync', manage, async (req, res) => res.json(await dist.fullSync(pool, id(req), Number(req.body?.days) || null)));
  r.post('/sync', manage, async (_req, res) => res.json(await dist.processOutbox(pool)));
  /** Send a test booking through the full inbound path (signature check included) — for the simulator. */
  r.post('/channels/:id/test-booking', manage, async (req, res) => {
    const [c] = await q('SELECT * FROM channels WHERE id=$1', [id(req)]);
    if (!c) throw new HttpError(404, 'Channel not found.');
    if (c.adapter !== 'simulator') throw new HttpError(400, 'Test bookings are only for the simulator channel.');
    const [m] = await q('SELECT * FROM channel_mappings WHERE channel_id=$1 ORDER BY room_type_id, rate_plan_id LIMIT 1', [c.id]);
    if (!m) throw new HttpError(400, 'Map at least one room type and rate plan first.');
    const s = await getSettings(pool);
    const b = req.body || {};
    const arrival = DATE_RE.test(b.arrival || '') ? b.arrival : s.business_date;
    const departure = DATE_RE.test(b.departure || '') ? b.departure : new Date(Date.parse(arrival + 'T00:00:00Z') + 2 * 864e5).toISOString().slice(0, 10);
    const body = Buffer.from(JSON.stringify({ event: 'booking.created', booking: { id: 'SIM-' + Date.now(), room_code: b.room_code || m.external_room_code, rate_code: b.rate_code || m.external_rate_code, arrival, departure, adults: 2, guest: { first_name: b.first_name || 'Test', last_name: b.last_name || 'Guest', email: 'test.guest@example.com' } } }));
    res.json(await dist.receiveInbound(pool, c.code, body, dist.sign(c.secret, body)));
  });

  r.put('/booking-settings', requirePerm('settings.manage'), inTx(async (db, req) => {
    const b = req.body || {};
    const horizon = Number(b.booking_horizon_days); if (!(Number.isInteger(horizon) && horizon >= 7 && horizon <= 730)) throw new HttpError(400, 'Booking window must be 7–730 days.');
    if (!/^\d{2}:\d{2}$/.test(b.check_in_time || '') || !/^\d{2}:\d{2}$/.test(b.check_out_time || '')) throw new HttpError(400, 'Times must be HH:MM.');
    const str = (v, max) => String(v ?? '').trim().slice(0, max);
    const { rows: [s] } = await db.query(
      `UPDATE settings SET booking_enabled=$1, booking_intro=$2, cancellation_policy=$3, check_in_time=$4, check_out_time=$5, booking_horizon_days=$6, contact_phone=$7, contact_email=$8 WHERE id=1 RETURNING *`,
      [b.booking_enabled !== false, str(b.booking_intro, 500), str(b.cancellation_policy, 1000), b.check_in_time, b.check_out_time, horizon, str(b.contact_phone, 40) || null, str(b.contact_email, 120) || null]);
    await audit(db, req.user, 'distribution.booking_settings', 'settings', 1, { booking_enabled: s.booking_enabled });
    return s;
  }));
  return r;
}
