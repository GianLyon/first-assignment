import express from 'express';
import { tx } from '../db.js';
import { HttpError, requirePerm, audit, can } from '../auth.js';
import * as inv from '../services/inventory.js';
import { getSettings } from '../services/frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function inventoryRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req, k = 'id') => { const n = Number(req.params[k]); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const anyOf = (...perms) => (req, _res, next) => { if (!perms.some((p) => can(req.user, p))) throw new HttpError(403, 'You do not have permission to do this.'); next(); };
  const view = anyOf('inventory.view', 'requisition.create', 'inventory.receive', 'pos.manage');
  const manage = requirePerm('inventory.manage');
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

  /* ---------- master data ---------- */
  r.get('/setup', view, async (_req, res) => res.json({
    stores: await q('SELECT * FROM stores ORDER BY id'),
    items: await q('SELECT * FROM stock_items ORDER BY category, name'),
    suppliers: await q('SELECT * FROM suppliers ORDER BY name'),
    outlets: await q('SELECT id, name, stock_store_id FROM outlets ORDER BY id'),
    departments: inv.DEPARTMENTS,
  }));
  r.post('/stores', manage, inTx(async (db, req) => {
    const b = req.body || {}; const name = String(b.name || '').trim(); if (!name) throw new HttpError(400, 'Name is required.');
    const kind = ['main', 'kitchen', 'bar', 'housekeeping', 'maintenance', 'other'].includes(b.kind) ? b.kind : 'other';
    const { rows: [s] } = await db.query('INSERT INTO stores (name, kind) VALUES ($1,$2) RETURNING *', [name, kind]);
    await audit(db, req.user, 'inventory.store_create', 'store', s.id, s); return s;
  }));
  r.put('/stores/:id', manage, inTx(async (db, req) => {
    const b = req.body || {}; const name = String(b.name || '').trim(); if (!name) throw new HttpError(400, 'Name is required.');
    const { rows: [s] } = await db.query('UPDATE stores SET name=$2, active=$3 WHERE id=$1 RETURNING *', [id(req), name, b.active !== false]);
    if (!s) throw new HttpError(404, 'Store not found.'); return s;
  }));
  r.put('/outlets/:id/store', anyOf('inventory.manage', 'pos.manage'), inTx(async (db, req) => {
    const storeId = req.body?.store_id ? Number(req.body.store_id) : null;
    const { rows: [o] } = await db.query('UPDATE outlets SET stock_store_id=$2 WHERE id=$1 RETURNING *', [id(req), storeId]);
    if (!o) throw new HttpError(404, 'Outlet not found.');
    await audit(db, req.user, 'inventory.outlet_store', 'outlet', o.id, { store_id: storeId }); return o;
  }));
  r.post('/items', manage, inTx((db, req) => inv.saveItem(db, req.user, null, req.body || {})));
  r.put('/items/:id', manage, inTx((db, req) => inv.saveItem(db, req.user, id(req), req.body || {})));
  r.post('/suppliers', manage, inTx((db, req) => inv.saveSupplier(db, req.user, null, req.body || {})));
  r.put('/suppliers/:id', manage, inTx((db, req) => inv.saveSupplier(db, req.user, id(req), req.body || {})));

  /* ---------- stock ---------- */
  r.get('/stock', requirePerm('inventory.view'), async (req, res) => res.json(await inv.stockOnHand(pool, req.query.store_id ? Number(req.query.store_id) : null)));
  r.get('/items/:id/movements', requirePerm('inventory.view'), async (req, res) => res.json(await q(
    `SELECT m.*, s.name AS store_name, u.full_name AS user_name FROM stock_movements m JOIN stores s ON s.id=m.store_id LEFT JOIN users u ON u.id=m.user_id
     WHERE m.item_id=$1 ORDER BY m.id DESC LIMIT 100`, [id(req)])));
  r.get('/items/:id/balances', view, async (req, res) => res.json(await q('SELECT b.store_id, s.name, b.qty FROM stock_balances b JOIN stores s ON s.id=b.store_id WHERE b.item_id=$1 ORDER BY s.id', [id(req)])));
  r.post('/write-offs', requirePerm('inventory.receive'), inTx((db, req) => inv.writeOff(db, req.user, req.body || {})));

  /* ---------- purchasing ---------- */
  const buy = anyOf('inventory.receive', 'purchase.approve');
  r.get('/purchase-orders', buy, async (req, res) => res.json(await q(
    `SELECT p.id, p.code, p.status, p.created_at, p.expected_date, s.name AS supplier_name, st.name AS store_name,
            (SELECT COALESCE(SUM(qty*unit_cost),0) FROM purchase_order_lines WHERE po_id=p.id)::bigint AS total
     FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id JOIN stores st ON st.id=p.store_id
     WHERE ($1 = 'all' OR ($1 = 'open' AND p.status IN ('draft','approved','partly_received')) OR ($1 = 'closed' AND p.status IN ('received','cancelled')))
     ORDER BY p.id DESC LIMIT 200`, [['open', 'closed', 'all'].includes(req.query.view) ? req.query.view : 'open'])));
  r.post('/purchase-orders', requirePerm('inventory.receive'), inTx((db, req) => inv.createPO(db, req.user, req.body || {})));
  r.get('/purchase-orders/:id', buy, async (req, res) => res.json(await inv.getPO(pool, id(req))));
  r.post('/purchase-orders/:id/approve', requirePerm('purchase.approve'), inTx(async (db, req) => { await inv.approvePO(db, req.user, id(req)); return { ok: true }; }));
  r.post('/purchase-orders/:id/cancel', buy, inTx(async (db, req) => { await inv.cancelPO(db, req.user, id(req)); return { ok: true }; }));
  r.get('/receipts', buy, async (_req, res) => res.json(await q(
    `SELECT g.id, g.code, g.business_date, g.total, g.invoice_ref, g.is_opening, s.name AS supplier_name, st.name AS store_name, p.code AS po_code, u.full_name AS received_by_name
     FROM goods_received g LEFT JOIN suppliers s ON s.id=g.supplier_id JOIN stores st ON st.id=g.store_id LEFT JOIN purchase_orders p ON p.id=g.po_id LEFT JOIN users u ON u.id=g.received_by
     ORDER BY g.id DESC LIMIT 100`)));
  r.post('/receipts', requirePerm('inventory.receive'), inTx((db, req) => inv.receive(db, req.user, req.body || {})));

  /* ---------- requisitions ---------- */
  const reqView = anyOf('requisition.create', 'requisition.approve', 'requisition.issue');
  r.get('/requisitions', reqView, async (req, res) => {
    const v = ['pending', 'approved', 'done', 'mine'].includes(req.query.view) ? req.query.view : 'pending';
    res.json(await q(
      `SELECT r.id, r.code, r.department, r.status, r.requested_at, r.total_cost, fs.name AS from_store, ts.name AS to_store, u.full_name AS requested_by_name,
              (SELECT count(*) FROM requisition_lines WHERE req_id=r.id)::int AS lines
       FROM requisitions r JOIN stores fs ON fs.id=r.from_store_id LEFT JOIN stores ts ON ts.id=r.to_store_id LEFT JOIN users u ON u.id=r.requested_by
       WHERE ($1 = 'pending' AND r.status='pending') OR ($1 = 'approved' AND r.status='approved')
          OR ($1 = 'done' AND r.status IN ('issued','rejected','cancelled')) OR ($1 = 'mine' AND r.requested_by=$2)
       ORDER BY r.id DESC LIMIT 200`, [v, req.user.id]));
  });
  r.post('/requisitions', requirePerm('requisition.create'), inTx((db, req) => inv.createRequisition(db, req.user, req.body || {})));
  r.get('/requisitions/:id', reqView, async (req, res) => res.json(await inv.getRequisition(pool, id(req))));
  r.post('/requisitions/:id/approve', requirePerm('requisition.approve'), inTx(async (db, req) => { await inv.approveRequisition(db, req.user, id(req), req.body || {}); return { ok: true }; }));
  r.post('/requisitions/:id/reject', requirePerm('requisition.approve'), inTx(async (db, req) => { await inv.rejectRequisition(db, req.user, id(req), req.body?.reason); return { ok: true }; }));
  r.post('/requisitions/:id/cancel', requirePerm('requisition.create'), inTx(async (db, req) => { await inv.cancelRequisition(db, req.user, id(req)); return { ok: true }; }));
  r.post('/requisitions/:id/issue', requirePerm('requisition.issue'), inTx((db, req) => inv.issueRequisition(db, req.user, id(req), req.body || {})));

  /* ---------- stock counts ---------- */
  const count = requirePerm('stock.count');
  r.get('/counts', count, async (_req, res) => res.json(await q(
    `SELECT c.*, s.name AS store_name, u.full_name AS created_by_name, (SELECT count(*) FILTER (WHERE counted_qty IS NOT NULL) FROM stock_count_lines WHERE count_id=c.id)::int AS counted,
            (SELECT count(*) FROM stock_count_lines WHERE count_id=c.id)::int AS lines
     FROM stock_counts c JOIN stores s ON s.id=c.store_id LEFT JOIN users u ON u.id=c.created_by ORDER BY c.id DESC LIMIT 50`)));
  r.post('/counts', count, inTx((db, req) => inv.startCount(db, req.user, req.body || {})));
  r.get('/counts/:id', count, async (req, res) => {
    const [c] = await q('SELECT c.*, s.name AS store_name FROM stock_counts c JOIN stores s ON s.id=c.store_id WHERE c.id=$1', [id(req)]);
    if (!c) throw new HttpError(404, 'Count not found.');
    const lines = await q(
      `SELECT l.*, i.code, i.name, i.unit, i.category, i.avg_cost, COALESCE(b.qty,0) AS current_qty FROM stock_count_lines l JOIN stock_items i ON i.id=l.item_id
       LEFT JOIN stock_balances b ON b.item_id=l.item_id AND b.store_id=$2 WHERE l.count_id=$1 ORDER BY i.category, i.name`, [c.id, c.store_id]);
    res.json({ ...c, lines });
  });
  r.put('/counts/:id/lines', count, inTx((db, req) => inv.saveCountLines(db, req.user, id(req), req.body?.lines)));
  r.post('/counts/:id/post', count, inTx((db, req) => inv.postCount(db, req.user, id(req))));
  r.post('/counts/:id/cancel', count, inTx(async (db, req) => {
    const { rowCount } = await db.query("UPDATE stock_counts SET status='cancelled' WHERE id=$1 AND status='open'", [id(req)]);
    if (!rowCount) throw new HttpError(409, 'This count is not open.');
    await audit(db, req.user, 'inventory.count_cancel', 'stock_count', id(req)); return { ok: true };
  }));

  /* ---------- recipes ---------- */
  const recipes = anyOf('inventory.manage', 'pos.manage');
  r.get('/recipes', recipes, async (_req, res) => res.json(await inv.recipeCosts(pool)));
  r.get('/recipes/:id', recipes, async (req, res) => res.json(await q('SELECT r.item_id, r.qty, i.name, i.unit, i.avg_cost FROM recipe_lines r JOIN stock_items i ON i.id=r.item_id WHERE r.menu_item_id=$1 ORDER BY i.name', [id(req)])));
  r.put('/recipes/:id', recipes, inTx((db, req) => inv.saveRecipe(db, req.user, id(req), req.body?.lines)));

  /* ---------- reports ---------- */
  r.get('/reports/summary', requirePerm('inventory.view'), async (req, res) => {
    const s = await getSettings(pool);
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : s.business_date;
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : to.slice(0, 8) + '01';
    const stores = await q(`SELECT s.id, s.name, COALESCE(SUM(b.qty * i.avg_cost),0)::bigint AS value FROM stores s LEFT JOIN stock_balances b ON b.store_id=s.id LEFT JOIN stock_items i ON i.id=b.item_id WHERE s.active GROUP BY s.id ORDER BY s.id`);
    res.json({
      from, to, stores: stores.map((x) => ({ ...x, value: Number(x.value) })),
      food_cost: await inv.foodCost(pool, from, to, Number(s.vat_rate)),
      consumption: await inv.consumption(pool, from, to),
      low_stock: (await inv.stockOnHand(pool, null)).filter((i) => i.active && i.low),
      negative: await q(`SELECT i.name, i.unit, s.name AS store_name, b.qty FROM stock_balances b JOIN stock_items i ON i.id=b.item_id JOIN stores s ON s.id=b.store_id WHERE b.qty < 0 ORDER BY i.name`),
    });
  });

  return r;
}
