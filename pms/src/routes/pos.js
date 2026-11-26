import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, audit, can } from '../auth.js';
import * as pos from '../services/pos.js';
import { getSettings } from '../services/frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function posRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const use = requirePerm('pos.use'), manage = requirePerm('pos.manage');
  const str = (v, field, max = 80) => { const s = String(v ?? '').trim(); if (!s) throw new HttpError(400, `${field} is required.`); if (s.length > max) throw new HttpError(400, `${field} is too long.`); return s; };

  const OUTLET_KINDS = ['restaurant', 'bar', 'room_service', 'spa', 'health_club', 'pool_bar', 'other'], STATIONS = ['kitchen', 'bar', 'none'];
  const time = (v) => (v && /^\d{2}:\d{2}$/.test(String(v).slice(0, 5)) ? String(v).slice(0, 5) : null);
  const outletExtras = (b) => {
    const lim = b.discount_limit_pct === undefined || b.discount_limit_pct === '' ? 10 : Number(b.discount_limit_pct);
    if (!(Number.isInteger(lim) && lim >= 0 && lim <= 100)) throw new HttpError(400, 'Discount limit must be 0–100%.');
    const hf = time(b.happy_from), ht = time(b.happy_to);
    if (!!hf !== !!ht) throw new HttpError(400, 'Set both the start and end of happy hour, or neither.');
    return [hf, ht, String(b.receipt_footer || '').trim().slice(0, 300) || null, lim];
  };
  const outletList = async (db, v) => {
    const ids = [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length && (await db.query('SELECT count(*)::int AS n FROM outlets WHERE id = ANY($1)', [ids])).rows[0].n !== ids.length) throw new HttpError(400, 'Unknown outlet.');
    return ids;
  };
  const itemExtras = (b) => {
    const hp = b.happy_price === undefined || b.happy_price === null || b.happy_price === '' ? null : price(b.happy_price);
    const options = [...new Set((Array.isArray(b.options) ? b.options : String(b.options || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean))].slice(0, 12).map((x) => x.slice(0, 40));
    const dur = b.duration_min === undefined || b.duration_min === null || b.duration_min === '' ? null : Number(b.duration_min);
    if (dur !== null && !(Number.isInteger(dur) && dur > 0 && dur <= 600)) throw new HttpError(400, 'Duration must be 1–600 minutes.');
    const course = Math.min(4, Math.max(1, Number(b.course) || 1));
    return [hp, options, dur, course];
  };

  /* ---------- menu & floor setup ---------- */
  r.get('/setup', async (req, res) => {
    if (!['pos.use', 'pos.manage', 'pos.kitchen', 'reports.view'].some((p) => can(req.user, p))) throw new HttpError(403, 'You do not have permission to do this.');
    const q = async (sql) => (await pool.query(sql)).rows;
    res.json({
      outlets: await q('SELECT * FROM outlets ORDER BY id'),
      categories: await q('SELECT * FROM menu_categories ORDER BY sort, name'),
      items: await q('SELECT * FROM menu_items ORDER BY category_id, name'),
      tables: await q('SELECT * FROM dining_tables ORDER BY outlet_id, name'),
    });
  });
  r.post('/outlets', manage, inTx(async (db, req) => {
    const b = req.body || {}; const kind = OUTLET_KINDS.includes(b.kind) ? b.kind : 'restaurant';
    const { rows: [o] } = await db.query('INSERT INTO outlets (name, kind, happy_from, happy_to, receipt_footer, discount_limit_pct) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [str(b.name, 'Name'), kind, ...outletExtras(b)]);
    await audit(db, req.user, 'pos.outlet_create', 'outlet', o.id, o); return o;
  }));
  r.put('/outlets/:id', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [o] } = await db.query('UPDATE outlets SET name=$2, active=$3, kind=COALESCE($4, kind), happy_from=$5, happy_to=$6, receipt_footer=$7, discount_limit_pct=$8 WHERE id=$1 RETURNING *',
      [id(req), str(b.name, 'Name'), b.active !== false, OUTLET_KINDS.includes(b.kind) ? b.kind : null, ...outletExtras(b)]);
    if (!o) throw new HttpError(404, 'Outlet not found.'); await audit(db, req.user, 'pos.outlet_update', 'outlet', o.id, o); return o;
  }));
  r.post('/categories', manage, inTx(async (db, req) => {
    const b = req.body || {}; const station = STATIONS.includes(b.station) ? b.station : 'kitchen';
    const { rows: [c] } = await db.query('INSERT INTO menu_categories (name, station, sort, outlet_ids) VALUES ($1,$2,$3,$4) RETURNING *', [str(b.name, 'Name'), station, Number(b.sort) || 0, await outletList(db, b.outlet_ids)]);
    await audit(db, req.user, 'pos.category_create', 'menu_category', c.id, c); return c;
  }));
  r.put('/categories/:id', manage, inTx(async (db, req) => {
    const b = req.body || {}; const station = STATIONS.includes(b.station) ? b.station : 'kitchen';
    const { rows: [c] } = await db.query('UPDATE menu_categories SET name=$2, station=$3, sort=$4, active=$5, outlet_ids=$6 WHERE id=$1 RETURNING *', [id(req), str(b.name, 'Name'), station, Number(b.sort) || 0, b.active !== false, await outletList(db, b.outlet_ids)]);
    if (!c) throw new HttpError(404, 'Category not found.'); await audit(db, req.user, 'pos.category_update', 'menu_category', c.id, c); return c;
  }));
  const price = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'Price must be a whole number of shillings.'); return n; };
  r.post('/items', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [i] } = await db.query('INSERT INTO menu_items (category_id, name, price, happy_price, options, duration_min, course) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [Number(b.category_id), str(b.name, 'Name', 120), price(b.price), ...itemExtras(b)]);
    await audit(db, req.user, 'pos.item_create', 'menu_item', i.id, i); return i;
  }));
  r.put('/items/:id', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [old] } = await db.query('SELECT * FROM menu_items WHERE id=$1', [id(req)]);
    if (!old) throw new HttpError(404, 'Item not found.');
    const { rows: [i] } = await db.query('UPDATE menu_items SET category_id=$2, name=$3, price=$4, active=$5, happy_price=$6, options=$7, duration_min=$8, course=$9 WHERE id=$1 RETURNING *', [old.id, Number(b.category_id), str(b.name, 'Name', 120), price(b.price), b.active !== false, ...itemExtras(b)]);
    await audit(db, req.user, 'pos.item_update', 'menu_item', i.id, { from_price: old.price, to_price: i.price, name: i.name, active: i.active }); return i;
  }));
  r.post('/tables', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [t] } = await db.query('INSERT INTO dining_tables (outlet_id, name, seats) VALUES ($1,$2,$3) RETURNING *', [Number(b.outlet_id), str(b.name, 'Table name', 20), Math.max(1, Number(b.seats) || 4)]);
    await audit(db, req.user, 'pos.table_create', 'dining_table', t.id, t); return t;
  }));
  r.put('/tables/:id', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [t] } = await db.query('UPDATE dining_tables SET name=$2, seats=$3, active=$4 WHERE id=$1 RETURNING *', [id(req), str(b.name, 'Table name', 20), Math.max(1, Number(b.seats) || 4), b.active !== false]);
    if (!t) throw new HttpError(404, 'Table not found.'); return t;
  }));

  /* ---------- shifts ---------- */
  r.get('/shift', use, async (req, res) => { const s = await pos.myShift(pool, req.user.id); res.json(s ? await pos.shiftSummary(pool, s.id) : null); });
  r.post('/shift/open', use, inTx((db, req) => pos.openShift(db, req.user, req.body || {})));
  r.post('/shift/close', use, inTx((db, req) => pos.closeShift(db, req.user, req.body || {})));

  /* ---------- floor & bills ---------- */
  r.get('/floor', use, async (req, res) => {
    const outletId = Number(req.query.outlet_id);
    const { rows: tables } = await pool.query(
      `SELECT t.*, c.id AS check_id, c.code, c.covers, c.opened_at, COALESCE(w.full_name, u.full_name) AS opened_by_name,
              (SELECT COALESCE(SUM(unit_price*qty),0) FROM pos_check_lines l WHERE l.check_id=c.id AND l.status <> 'voided') - COALESCE(c.discount_amount,0) AS total,
              (SELECT count(*)::int FROM pos_checks s WHERE s.parent_id=c.id AND s.status='open') AS splits,
              (SELECT count(*)::int FROM pos_check_lines l WHERE l.check_id=c.id AND l.held AND l.status='pending') AS held
       FROM dining_tables t LEFT JOIN pos_checks c ON c.table_id=t.id AND c.status='open' AND c.parent_id IS NULL LEFT JOIN users u ON u.id=c.opened_by LEFT JOIN users w ON w.id=c.waiter_id
       WHERE t.outlet_id=$1 AND t.active ORDER BY t.name`, [outletId]);
    const { rows: other } = await pool.query(
      `SELECT c.id AS check_id, c.code, c.covers, c.opened_at, rm.number AS room_number, g.last_name, c.guest_name, dt.name AS table_name, pc.code AS parent_code, w.full_name AS waiter_name,
              (SELECT COALESCE(SUM(unit_price*qty),0) FROM pos_check_lines l WHERE l.check_id=c.id AND l.status <> 'voided') - c.discount_amount AS total
       FROM pos_checks c LEFT JOIN reservations r ON r.id=c.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN guests g ON g.id=r.guest_id
       LEFT JOIN dining_tables dt ON dt.id=c.table_id LEFT JOIN pos_checks pc ON pc.id=c.parent_id LEFT JOIN users w ON w.id=c.waiter_id
       WHERE c.outlet_id=$1 AND c.status='open' AND (c.table_id IS NULL OR c.parent_id IS NOT NULL) ORDER BY c.id`, [outletId]);
    res.json({ tables: tables.map((t) => ({ ...t, total: Number(t.total) })), other: other.map((t) => ({ ...t, total: Number(t.total) })) });
  });
  r.get('/rooms', use, async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id AS reservation_id, rm.number AS room_number, g.first_name, g.last_name FROM reservations r JOIN rooms rm ON rm.id=r.room_id JOIN guests g ON g.id=r.guest_id
       WHERE r.status='in_house' ORDER BY rm.number`);
    res.json(rows);
  });
  r.post('/checks', use, inTx((db, req) => pos.openCheck(db, req.user, req.body || {})));
  r.get('/checks/:id', use, async (req, res) => res.json(await pos.getCheck(pool, id(req))));
  r.post('/checks/:id/lines', use, inTx((db, req) => pos.addLine(db, req.user, id(req), req.body || {})));
  r.patch('/lines/:id', use, inTx((db, req) => pos.changeLine(db, req.user, id(req), req.body || {})));
  r.post('/checks/:id/send', use, inTx((db, req) => pos.sendCheck(db, req.user, id(req))));
  r.post('/checks/:id/settle', use, inTx((db, req) => pos.settleCheck(db, req.user, id(req), req.body || {})));
  r.post('/checks/:id/void', use, inTx(async (db, req) => { await pos.voidCheck(db, req.user, id(req), req.body?.reason); return { ok: true }; }));
  r.post('/checks/:id/move', use, inTx(async (db, req) => { await pos.moveCheck(db, req.user, id(req), req.body || {}); return { ok: true }; }));
  r.post('/checks/:id/discount', use, inTx((db, req) => pos.discountCheck(db, req.user, id(req), req.body || {})));
  r.post('/checks/:id/fire', use, inTx((db, req) => pos.fireCourse(db, req.user, id(req), req.body?.course)));
  r.post('/checks/:id/split', use, inTx((db, req) => pos.splitCheck(db, req.user, id(req), req.body || {})));
  r.post('/checks/:id/merge', use, inTx((db, req) => pos.mergeCheck(db, req.user, id(req), req.body || {})));
  r.post('/checks/:id/waiter', use, inTx((db, req) => pos.setWaiter(db, req.user, id(req), req.body?.waiter_id)));
  r.post('/lines/:id/hold', use, inTx((db, req) => pos.holdLine(db, req.user, id(req), req.body?.hold)));
  r.post('/prints', (req, _res, next) => { if (!['pos.use', 'pos.kitchen'].some((p) => can(req.user, p))) throw new HttpError(403, 'You do not have permission to do this.'); next(); },
    inTx((db, req) => pos.recordPrint(db, req.user, req.body || {})));
  r.get('/staff', use, async (_req, res) => res.json((await pool.query("SELECT id, full_name, role FROM users WHERE active AND username <> 'demo' ORDER BY full_name")).rows));

  /* ---------- kitchen & bar display ---------- */
  r.get('/tickets', requirePerm('pos.kitchen'), async (req, res) => res.json(await pos.tickets(pool, req.query.station === 'bar' ? 'bar' : 'kitchen')));
  r.post('/tickets/:id/status', requirePerm('pos.kitchen'), inTx(async (db, req) => { await pos.setTicketStatus(db, req.user, id(req), req.body?.status); return { ok: true }; }));

  /* ---------- reports ---------- */
  r.get('/reports/sales', requirePerm('reports.view'), async (req, res) => {
    const s = await getSettings(pool);
    res.json(await pos.salesReport(pool, DATE_RE.test(req.query.date || '') ? req.query.date : s.business_date));
  });
  r.get('/shifts/:id', requirePerm('reports.view'), async (req, res) => res.json(await pos.shiftSummary(pool, id(req))));

  return r;
}
