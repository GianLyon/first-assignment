// Phase 7 routes: amenities, events & banqueting, assets & maintenance (mounted at /api/ops).
import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, can } from '../auth.js';
import * as ops from '../services/operations.js';
import { getSettings } from '../services/frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const T = (c) => `to_char(${c},'HH24:MI')`;

export function operationsRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const anyOf = (...p) => (req, _res, next) => { if (!p.some((x) => can(req.user, x))) throw new HttpError(403, 'You do not have permission to do this.'); next(); };
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const date = async (v) => (DATE_RE.test(v || '') ? v : (await getSettings(pool)).business_date);

  /* ---------------- amenities ---------------- */
  const sell = anyOf('amenities.sell', 'amenities.manage');
  r.get('/amenities', sell, async (req, res) => res.json(await q(`SELECT * FROM amenities ${can(req.user, 'amenities.manage') && req.query.all ? '' : 'WHERE active'} ORDER BY category, name`)));
  r.post('/amenities', requirePerm('amenities.manage'), inTx((db, req) => ops.saveAmenity(db, req.user, null, req.body || {})));
  r.put('/amenities/:id', requirePerm('amenities.manage'), inTx((db, req) => ops.saveAmenity(db, req.user, id(req), req.body || {})));
  r.get('/amenity-guests', sell, async (req, res) => {
    const d = await date(req.query.date);
    res.json(await q(`SELECT r.id, r.code, r.status, g.first_name || ' ' || g.last_name AS guest, g.phone, rm.number AS room FROM reservations r JOIN guests g ON g.id=r.guest_id
      LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.status IN ('reserved','in_house') AND r.arrival <= $1 AND r.departure >= $1 ORDER BY rm.number NULLS LAST, g.last_name`, [d]));
  });
  r.get('/amenity-bookings', sell, async (req, res) => {
    const d = await date(req.query.date);
    const rows = await q(`SELECT ab.*, ${T('ab.start_time')} AS time, to_char(ab.service_date,'YYYY-MM-DD') AS d, a.name AS amenity, a.category, a.duration_min,
        rm.number AS room, r.code AS res_code, r.status AS res_status, ab.qty*ab.unit_price AS amount
      FROM amenity_bookings ab JOIN amenities a ON a.id=ab.amenity_id LEFT JOIN reservations r ON r.id=ab.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id
      WHERE ab.service_date=$1 ORDER BY ab.start_time NULLS LAST, ab.id`, [d]);
    const sum = (st) => rows.filter((x) => x.status === st).reduce((s, x) => s + Number(x.amount), 0);
    res.json({ date: d, bookings: rows, totals: { booked: sum('booked'), completed: sum('completed'), room: rows.filter((x) => x.settled_by === 'room').reduce((s, x) => s + Number(x.amount), 0) } });
  });
  r.post('/amenity-bookings', sell, inTx((db, req) => ops.bookAmenity(db, req.user, req.body || {})));
  r.post('/amenity-bookings/:id/complete', sell, inTx((db, req) => ops.completeAmenity(db, req.user, id(req), req.body || {})));
  r.post('/amenity-bookings/:id/close', sell, inTx(async (db, req) => { await ops.closeAmenity(db, req.user, id(req), req.body?.status); return { ok: true }; }));

  /* ---------------- events & banqueting ---------------- */
  const evView = requirePerm('events.view'), evManage = requirePerm('events.manage');
  r.get('/events/setup', evView, async (_req, res) => res.json({
    rooms: await q('SELECT * FROM function_rooms ORDER BY name'), packages: await q('SELECT * FROM event_packages ORDER BY per_person'),
    companies: await q('SELECT id, name FROM companies WHERE active ORDER BY name'), cash_accounts: await q('SELECT code, name FROM accounts WHERE is_cash AND active ORDER BY code'),
  }));
  r.post('/function-rooms', evManage, inTx(async (db, req) => saveSimple(db, 'function_rooms', null, req.body)));
  r.put('/function-rooms/:id', evManage, inTx(async (db, req) => saveSimple(db, 'function_rooms', id(req), req.body)));
  r.post('/event-packages', evManage, inTx(async (db, req) => saveSimple(db, 'event_packages', null, req.body)));
  r.put('/event-packages/:id', evManage, inTx(async (db, req) => saveSimple(db, 'event_packages', id(req), req.body)));
  const evSelect = `SELECT e.*, to_char(e.event_date,'YYYY-MM-DD') AS d, ${T('e.start_time')} AS start, ${T('e.end_time')} AS end, fr.name AS room_name, c.name AS company_name, p.name AS package_name,
      e.pax*e.per_person + e.room_hire + COALESCE((SELECT SUM(qty*unit_price) FROM event_extras x WHERE x.event_id=e.id),0) AS total,
      COALESCE((SELECT SUM(CASE WHEN kind='deposit' THEN amount ELSE -amount END) FROM event_payments ep WHERE ep.event_id=e.id),0) AS deposits
    FROM events e JOIN function_rooms fr ON fr.id=e.function_room_id LEFT JOIN companies c ON c.id=e.company_id LEFT JOIN event_packages p ON p.id=e.package_id`;
  r.get('/events', evView, async (req, res) => {
    const s = await getSettings(pool);
    const f = { upcoming: "e.status IN ('enquiry','tentative','confirmed') AND e.event_date >= $1", due: "e.status='confirmed' AND e.event_date <= $1",
      enquiries: "e.status IN ('enquiry','tentative')", past: "e.status IN ('completed','cancelled')" }[req.query.filter] || "e.status IN ('enquiry','tentative','confirmed') AND e.event_date >= $1";
    res.json({ business_date: s.business_date, events: await q(`${evSelect} WHERE ${f.includes('$1') ? f : `${f} AND $1::date IS NOT NULL`} ORDER BY e.event_date ${req.query.filter === 'past' ? 'DESC' : ''}, e.start_time LIMIT 200`, [s.business_date]) });
  });
  r.get('/events/:id', evView, async (req, res) => {
    const [e] = await q(`${evSelect} WHERE e.id=$1`, [id(req)]);
    if (!e) throw new HttpError(404, 'Event not found.');
    const [inv] = e.invoice_id ? await q('SELECT number FROM invoices WHERE id=$1', [e.invoice_id]) : [];
    res.json({ event: { ...e, invoice_number: inv?.number || null }, totals: await ops.eventTotals(pool, e), extras: await q('SELECT * FROM event_extras WHERE event_id=$1 ORDER BY id', [e.id]),
      payments: await q("SELECT ep.*, to_char(ep.business_date,'YYYY-MM-DD') AS d, a.name AS account_name, u.full_name AS by_name FROM event_payments ep JOIN accounts a ON a.code=ep.account_code LEFT JOIN users u ON u.id=ep.created_by WHERE event_id=$1 ORDER BY ep.id", [e.id]) });
  });
  r.post('/events', evManage, inTx((db, req) => ops.saveEvent(db, req.user, null, req.body || {})));
  r.put('/events/:id', evManage, inTx((db, req) => ops.saveEvent(db, req.user, id(req), req.body || {})));
  r.post('/events/:id/payments', evManage, inTx((db, req) => ops.eventPayment(db, req.user, id(req), req.body || {})));
  r.post('/events/:id/complete', evManage, inTx((db, req) => ops.completeEvent(db, req.user, id(req), req.body || {})));
  r.post('/events/:id/cancel', evManage, inTx(async (db, req) => { await ops.cancelEvent(db, req.user, id(req), req.body || {}); return { ok: true }; }));

  /* ---------------- assets ---------------- */
  const am = requirePerm('assets.manage');
  // anyone who reports faults can pick an asset (name and place only)
  r.get('/assets', anyOf('assets.manage', 'maintenance.work', 'maintenance.report'), async (req, res) => {
    const full = can(req.user, 'assets.manage') || can(req.user, 'maintenance.work');
    const rows = await q(`SELECT a.*, to_char(a.purchase_date,'YYYY-MM-DD') AS bought, to_char(a.last_service_date,'YYYY-MM-DD') AS serviced,
        to_char(COALESCE(a.last_service_date, a.purchase_date) + a.service_interval_days, 'YYYY-MM-DD') AS next_service, a.cost - a.accumulated_dep AS book_value
      FROM assets a WHERE ${req.query.status === 'disposed' ? "a.status='disposed'" : "a.status<>'disposed'"} ORDER BY a.category, a.name`);
    res.json(full ? (can(req.user, 'assets.manage') ? rows : rows.map(({ cost, residual_value, accumulated_dep, book_value, disposal_proceeds, ...x }) => x))
      : rows.map(({ id: i, code, name, location, category }) => ({ id: i, code, name, location, category })));
  });
  r.get('/assets/:id', anyOf('assets.manage', 'maintenance.work'), async (req, res) => {
    const [a] = await q("SELECT a.*, to_char(a.purchase_date,'YYYY-MM-DD') AS bought, to_char(a.last_service_date,'YYYY-MM-DD') AS serviced, to_char(a.disposed_date,'YYYY-MM-DD') AS disposed, a.cost - a.accumulated_dep AS book_value FROM assets a WHERE id=$1", [id(req)]);
    if (!a) throw new HttpError(404, 'Asset not found.');
    if (!can(req.user, 'assets.manage')) for (const k of ['cost', 'residual_value', 'accumulated_dep', 'book_value', 'disposal_proceeds']) delete a[k];
    res.json({ asset: a, work_orders: await q("SELECT w.*, to_char(w.reported_at,'YYYY-MM-DD') AS reported FROM work_orders w WHERE asset_id=$1 ORDER BY id DESC LIMIT 50", [a.id]) });
  });
  r.post('/assets', am, inTx((db, req) => ops.createAsset(db, req.user, req.body || {})));
  r.put('/assets/:id', anyOf('assets.manage', 'maintenance.work'), inTx((db, req) => ops.updateAsset(db, req.user, id(req), req.body || {})));
  r.post('/assets/:id/dispose', am, inTx((db, req) => ops.disposeAsset(db, req.user, id(req), req.body || {})));
  r.get('/depreciation', am, async (_req, res) => res.json({
    runs: await q('SELECT d.*, u.full_name AS by_name FROM depreciation_runs d LEFT JOIN users u ON u.id=d.run_by ORDER BY period DESC LIMIT 36'),
    cash_accounts: await q('SELECT code, name FROM accounts WHERE is_cash AND active ORDER BY code'),
    totals: (await q("SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(accumulated_dep),0) AS dep FROM assets WHERE status<>'disposed'"))[0],
  }));
  r.post('/depreciation', am, inTx((db, req) => ops.runDepreciation(db, req.user, req.body?.period)));

  /* ---------------- maintenance ---------------- */
  const report = anyOf('maintenance.report', 'maintenance.work'), work = requirePerm('maintenance.work');
  r.get('/work-orders', report, async (req, res) => {
    const all = can(req.user, 'maintenance.work');
    const st = { open: "w.status IN ('open','in_progress','on_hold')", closed: "w.status IN ('done','cancelled')" }[req.query.status] || "w.status IN ('open','in_progress','on_hold')";
    const s = await getSettings(pool);
    res.json({ business_date: s.business_date, rooms: await q('SELECT id, number, hk_status FROM rooms ORDER BY number'),
      work_orders: await q(`SELECT w.*, to_char(w.due_date,'YYYY-MM-DD') AS due, to_char(w.reported_at,'YYYY-MM-DD HH24:MI') AS reported, to_char(w.completed_at,'YYYY-MM-DD') AS completed,
          rm.number AS room, a.name AS asset_name, a.code AS asset_code, u.full_name AS reporter
        FROM work_orders w LEFT JOIN rooms rm ON rm.id=w.room_id LEFT JOIN assets a ON a.id=w.asset_id LEFT JOIN users u ON u.id=w.reported_by
        WHERE ${st} ${all ? '' : 'AND w.reported_by=$1'} ${all ? 'AND $1::int IS NOT NULL' : ''}
        ORDER BY ${req.query.status === 'closed' ? 'w.completed_at DESC' : "array_position(ARRAY['urgent','high','normal','low'], w.priority), w.due_date NULLS LAST"} LIMIT 300`, [req.user.id]) });
  });
  r.post('/work-orders', report, inTx((db, req) => ops.reportIssue(db, req.user, req.body || {})));
  r.put('/work-orders/:id', work, inTx((db, req) => ops.updateWorkOrder(db, req.user, id(req), req.body || {})));
  r.post('/work-orders/schedule', work, inTx((db, req) => ops.scheduleServices(db, req.user)));
  return r;
}

async function saveSimple(db, table, id, b = {}) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 100) throw new HttpError(400, 'Enter a name.');
  const int = (v, f, min = 0) => { const n = Number(v || 0); if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${f} is not valid.`); return n; };
  const active = b.active !== false;
  const [cols, vals] = table === 'function_rooms'
    ? [['name', 'capacity', 'hire_full_day', 'hire_half_day', 'active'], [name, int(b.capacity, 'Capacity', 1), int(b.hire_full_day, 'Full-day hire'), int(b.hire_half_day, 'Half-day hire'), active]]
    : [['name', 'per_person', 'includes', 'active'], [name, int(b.per_person, 'Price per person'), String(b.includes || '').trim().slice(0, 500) || null, active]];
  const sql = id
    ? `UPDATE ${table} SET (${cols.join(',')}) = (${cols.map((_, i) => '$' + (i + 2)).join(',')}) WHERE id=$1 RETURNING *`
    : `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`;
  const { rows: [row] } = await db.query(sql, id ? [id, ...vals] : vals);
  if (!row) throw new HttpError(404, 'Not found.');
  return row;
}
