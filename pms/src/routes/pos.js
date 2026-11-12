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
    const b = req.body || {}; const kind = ['restaurant', 'bar', 'room_service', 'other'].includes(b.kind) ? b.kind : 'restaurant';
    const { rows: [o] } = await db.query('INSERT INTO outlets (name, kind) VALUES ($1,$2) RETURNING *', [str(b.name, 'Name'), kind]);
    await audit(db, req.user, 'pos.outlet_create', 'outlet', o.id, o); return o;
  }));
  r.put('/outlets/:id', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [o] } = await db.query('UPDATE outlets SET name=$2, active=$3 WHERE id=$1 RETURNING *', [id(req), str(b.name, 'Name'), b.active !== false]);
    if (!o) throw new HttpError(404, 'Outlet not found.'); await audit(db, req.user, 'pos.outlet_update', 'outlet', o.id, o); return o;
  }));
  r.post('/categories', manage, inTx(async (db, req) => {
    const b = req.body || {}; const station = b.station === 'bar' ? 'bar' : 'kitchen';
    const { rows: [c] } = await db.query('INSERT INTO menu_categories (name, station, sort) VALUES ($1,$2,$3) RETURNING *', [str(b.name, 'Name'), station, Number(b.sort) || 0]);
    await audit(db, req.user, 'pos.category_create', 'menu_category', c.id, c); return c;
  }));
  r.put('/categories/:id', manage, inTx(async (db, req) => {
    const b = req.body || {}; const station = b.station === 'bar' ? 'bar' : 'kitchen';
    const { rows: [c] } = await db.query('UPDATE menu_categories SET name=$2, station=$3, sort=$4, active=$5 WHERE id=$1 RETURNING *', [id(req), str(b.name, 'Name'), station, Number(b.sort) || 0, b.active !== false]);
    if (!c) throw new HttpError(404, 'Category not found.'); await audit(db, req.user, 'pos.category_update', 'menu_category', c.id, c); return c;
  }));
  const price = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'Price must be a whole number of shillings.'); return n; };
  r.post('/items', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [i] } = await db.query('INSERT INTO menu_items (category_id, name, price) VALUES ($1,$2,$3) RETURNING *', [Number(b.category_id), str(b.name, 'Name', 120), price(b.price)]);
    await audit(db, req.user, 'pos.item_create', 'menu_item', i.id, i); return i;
  }));
  r.put('/items/:id', manage, inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [old] } = await db.query('SELECT * FROM menu_items WHERE id=$1', [id(req)]);
    if (!old) throw new HttpError(404, 'Item not found.');
    const { rows: [i] } = await db.query('UPDATE menu_items SET category_id=$2, name=$3, price=$4, active=$5 WHERE id=$1 RETURNING *', [old.id, Number(b.category_id), str(b.name, 'Name', 120), price(b.price), b.active !== false]);
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
      `SELECT t.*, c.id AS check_id, c.code, c.covers, c.opened_at, u.full_name AS opened_by_name,
              (SELECT COALESCE(SUM(unit_price*qty),0) FROM pos_check_lines l WHERE l.check_id=c.id AND l.status <> 'voided') AS total
       FROM dining_tables t LEFT JOIN pos_checks c ON c.table_id=t.id AND c.status='open' LEFT JOIN users u ON u.id=c.opened_by
       WHERE t.outlet_id=$1 AND t.active ORDER BY t.name`, [outletId]);
    const { rows: other } = await pool.query(
      `SELECT c.id AS check_id, c.code, c.covers, c.opened_at, rm.number AS room_number, g.last_name,
              (SELECT COALESCE(SUM(unit_price*qty),0) FROM pos_check_lines l WHERE l.check_id=c.id AND l.status <> 'voided') AS total
       FROM pos_checks c LEFT JOIN reservations r ON r.id=c.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN guests g ON g.id=r.guest_id
       WHERE c.outlet_id=$1 AND c.status='open' AND c.table_id IS NULL ORDER BY c.id`, [outletId]);
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
