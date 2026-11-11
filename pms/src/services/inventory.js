// Phase 3: Inventory, purchasing, requisitions, recipes and stock counts.
// Stock is valued at weighted average cost per item. Every movement is recorded in stock_movements
// and every change in value posts a balanced journal entry.
import { HttpError, audit, can } from '../auth.js';
import { postJournal } from '../ledger.js';
import { getSettings } from './frontoffice.js';

export const INV = { inventory: '1300', payable: '2000', equity: '3000', costOfSales: '5000', supplies: '5100', variance: '5900' };
export const DEPARTMENTS = ['Kitchen', 'Bar', 'Restaurant', 'Housekeeping', 'Laundry', 'Maintenance', 'Front Office', 'Spa', 'Administration'];

const q3 = (n) => Math.round(Number(n) * 1000) / 1000;
const money = (n) => Math.round(Number(n));
const text = (v, field, { required = false, max = 200 } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s || null;
};
const posQty = (v, field = 'Quantity') => { const n = q3(v); if (!(n > 0) || n > 1e9) throw new HttpError(400, `${field} must be more than zero.`); return n; };
const cost = (v) => { const n = Math.round(Number(v) * 100) / 100; if (!(n >= 0) || n > 1e12) throw new HttpError(400, 'Unit cost must be zero or more.'); return n; };
const isAdmin = (u) => u.role === 'admin';

async function store(db, id) {
  const { rows: [s] } = await db.query('SELECT * FROM stores WHERE id=$1 AND active', [Number(id)]);
  if (!s) throw new HttpError(400, 'Choose a store.');
  return s;
}
async function itemForUpdate(db, id) {
  const { rows: [i] } = await db.query('SELECT * FROM stock_items WHERE id=$1 FOR UPDATE', [Number(id)]);
  if (!i) throw new HttpError(400, 'Unknown stock item.');
  return i;
}

/** Change the quantity of an item in a store and record the movement. */
export async function moveStock(db, user, { itemId, storeId, qty, unitCost, kind, refType, refId, note, date, allowNegative = false }) {
  await db.query('INSERT INTO stock_balances (item_id, store_id, qty) VALUES ($1,$2,0) ON CONFLICT DO NOTHING', [itemId, storeId]);
  const { rows: [b] } = await db.query('SELECT qty FROM stock_balances WHERE item_id=$1 AND store_id=$2 FOR UPDATE', [itemId, storeId]);
  const next = q3(b.qty + qty);
  if (next < 0 && !allowNegative) {
    const { rows: [i] } = await db.query('SELECT name, unit FROM stock_items WHERE id=$1', [itemId]);
    const { rows: [s] } = await db.query('SELECT name FROM stores WHERE id=$1', [storeId]);
    throw new HttpError(409, `Not enough ${i.name} in ${s.name}: ${q3(b.qty)} ${i.unit} available, ${q3(-qty)} needed.`);
  }
  await db.query('UPDATE stock_balances SET qty=$3 WHERE item_id=$1 AND store_id=$2', [itemId, storeId, next]);
  await db.query(
    `INSERT INTO stock_movements (business_date, item_id, store_id, qty, unit_cost, kind, ref_type, ref_id, note, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [date, itemId, storeId, qty, unitCost, kind, refType ?? null, refId == null ? null : String(refId), note ?? null, user?.id ?? null]);
  return next;
}

/* ---------------- master data ---------------- */
export async function saveItem(db, user, id, b) {
  const code = text(b.code, 'Code', { required: !id, max: 20 })?.toUpperCase();
  const name = text(b.name, 'Name', { required: true, max: 120 }), unit = text(b.unit, 'Unit', { required: true, max: 20 });
  const category = text(b.category, 'Category', { max: 60 }) || 'General';
  const reorder = q3(b.reorder_level || 0); if (reorder < 0) throw new HttpError(400, 'Re-order level cannot be negative.');
  if (id) {
    const { rows: [i] } = await db.query('UPDATE stock_items SET name=$2, unit=$3, category=$4, reorder_level=$5, active=$6 WHERE id=$1 RETURNING *', [id, name, unit, category, reorder, b.active !== false]);
    if (!i) throw new HttpError(404, 'Item not found.');
    await audit(db, user, 'inventory.item_update', 'stock_item', i.id, { name, unit, reorder_level: reorder, active: i.active });
    return i;
  }
  const { rows: [i] } = await db.query('INSERT INTO stock_items (code, name, unit, category, reorder_level) VALUES ($1,$2,$3,$4,$5) RETURNING *', [code, name, unit, category, reorder]);
  await audit(db, user, 'inventory.item_create', 'stock_item', i.id, { code, name });
  return i;
}

export async function saveSupplier(db, user, id, b) {
  const vals = [text(b.name, 'Name', { required: true, max: 120 }), text(b.contact, 'Contact', { max: 80 }), text(b.phone, 'Phone', { max: 40 }), text(b.email, 'Email', { max: 120 }), text(b.tin, 'TIN', { max: 30 })];
  if (id) {
    const { rows: [s] } = await db.query('UPDATE suppliers SET name=$2, contact=$3, phone=$4, email=$5, tin=$6, active=$7 WHERE id=$1 RETURNING *', [id, ...vals, b.active !== false]);
    if (!s) throw new HttpError(404, 'Supplier not found.');
    await audit(db, user, 'inventory.supplier_update', 'supplier', s.id, { name: s.name }); return s;
  }
  const { rows: [s] } = await db.query('INSERT INTO suppliers (name, contact, phone, email, tin) VALUES ($1,$2,$3,$4,$5) RETURNING *', vals);
  await audit(db, user, 'inventory.supplier_create', 'supplier', s.id, { name: s.name }); return s;
}

/* ---------------- purchase orders ---------------- */
function cleanLines(lines, { costs = true } = {}) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 200) throw new HttpError(400, 'Add at least one item.');
  const seen = new Set();
  return lines.map((l) => {
    const itemId = Number(l.item_id); if (!Number.isInteger(itemId) || itemId <= 0) throw new HttpError(400, 'Choose an item on every line.');
    if (seen.has(itemId)) throw new HttpError(400, 'Each item can only appear once.'); seen.add(itemId);
    return { item_id: itemId, qty: posQty(l.qty), unit_cost: costs ? cost(l.unit_cost) : null };
  });
}

export async function createPO(db, user, b) {
  const { rows: [sup] } = await db.query('SELECT id FROM suppliers WHERE id=$1 AND active', [Number(b.supplier_id)]);
  if (!sup) throw new HttpError(400, 'Choose a supplier.');
  const st = await store(db, b.store_id);
  const lines = cleanLines(b.lines);
  const { rows: [po] } = await db.query('INSERT INTO purchase_orders (supplier_id, store_id, expected_date, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [sup.id, st.id, b.expected_date || null, text(b.notes, 'Notes', { max: 500 }), user.id]);
  for (const l of lines) await db.query('INSERT INTO purchase_order_lines (po_id, item_id, qty, unit_cost) VALUES ($1,$2,$3,$4)', [po.id, l.item_id, l.qty, l.unit_cost]);
  await audit(db, user, 'purchase.create', 'purchase_order', po.id, { code: po.code, total: Math.round(lines.reduce((a, l) => a + l.qty * l.unit_cost, 0)) });
  return po;
}
async function poForUpdate(db, id) {
  const { rows: [po] } = await db.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [id]);
  if (!po) throw new HttpError(404, 'Purchase order not found.');
  return po;
}
export async function approvePO(db, user, id) {
  const po = await poForUpdate(db, id);
  if (po.status !== 'draft') throw new HttpError(409, 'Only draft orders can be approved.');
  if (po.created_by === user.id && !isAdmin(user)) throw new HttpError(403, 'Someone other than the person who raised the order must approve it.');
  await db.query("UPDATE purchase_orders SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [po.id, user.id]);
  await audit(db, user, 'purchase.approve', 'purchase_order', po.id, { code: po.code });
}
export async function cancelPO(db, user, id) {
  const po = await poForUpdate(db, id);
  if (!['draft', 'approved'].includes(po.status)) throw new HttpError(409, 'Orders that have started arriving cannot be cancelled.');
  await db.query("UPDATE purchase_orders SET status='cancelled' WHERE id=$1", [po.id]);
  await audit(db, user, 'purchase.cancel', 'purchase_order', po.id, { code: po.code });
}
export async function getPO(db, id) {
  const { rows: [po] } = await db.query(
    `SELECT p.*, s.name AS supplier_name, st.name AS store_name, cu.full_name AS created_by_name, au.full_name AS approved_by_name
     FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id JOIN stores st ON st.id=p.store_id
     LEFT JOIN users cu ON cu.id=p.created_by LEFT JOIN users au ON au.id=p.approved_by WHERE p.id=$1`, [id]);
  if (!po) throw new HttpError(404, 'Purchase order not found.');
  const lines = (await db.query('SELECT l.*, i.name, i.unit, i.code FROM purchase_order_lines l JOIN stock_items i ON i.id=l.item_id WHERE po_id=$1 ORDER BY l.id', [id])).rows;
  return { ...po, lines, total: Math.round(lines.reduce((a, l) => a + l.qty * l.unit_cost, 0)) };
}

/* ---------------- goods received ---------------- */
/**
 * Receive stock into a store: against an approved purchase order, directly from a supplier,
 * or as opening stock at go-live (credited to owner's equity instead of the supplier).
 */
export async function receive(db, user, b) {
  const s = await getSettings(db);
  const isOpening = !!b.is_opening;
  let po = null, supplierId = b.supplier_id ? Number(b.supplier_id) : null, storeId = Number(b.store_id);
  if (b.po_id) {
    po = await poForUpdate(db, Number(b.po_id));
    if (!['approved', 'partly_received'].includes(po.status)) throw new HttpError(409, 'This purchase order is not approved for receiving.');
    supplierId = po.supplier_id; storeId = po.store_id;
  }
  if (!isOpening && !supplierId) throw new HttpError(400, 'Choose a supplier.');
  if (supplierId) { const { rows } = await db.query('SELECT 1 FROM suppliers WHERE id=$1', [supplierId]); if (!rows[0]) throw new HttpError(400, 'Unknown supplier.'); }
  const st = await store(db, storeId);
  const lines = cleanLines(b.lines);
  const poLines = po ? (await db.query('SELECT * FROM purchase_order_lines WHERE po_id=$1 FOR UPDATE', [po.id])).rows : [];
  let total = 0;
  const { rows: [grn] } = await db.query(
    'INSERT INTO goods_received (supplier_id, store_id, po_id, is_opening, invoice_ref, business_date, total, received_by) VALUES ($1,$2,$3,$4,$5,$6,0,$7) RETURNING *',
    [supplierId, st.id, po?.id ?? null, isOpening, text(b.invoice_ref, 'Invoice reference', { max: 60 }), s.business_date, user.id]);
  for (const l of lines) {
    let poLine = null;
    if (po) {
      poLine = poLines.find((x) => x.item_id === l.item_id);
      if (!poLine) throw new HttpError(400, 'An item is not on this purchase order.');
      const outstanding = q3(poLine.qty - poLine.received_qty);
      if (l.qty > outstanding + 1e-9) throw new HttpError(400, `Receiving more than ordered (${outstanding} outstanding).`);
      await db.query('UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id=$1', [poLine.id, l.qty]);
      poLine.received_qty = q3(poLine.received_qty + l.qty);
    }
    // weighted average cost across all stores
    const item = await itemForUpdate(db, l.item_id);
    const { rows: [{ onhand }] } = await db.query('SELECT COALESCE(SUM(qty),0) AS onhand FROM stock_balances WHERE item_id=$1', [item.id]);
    const base = Math.max(0, Number(onhand));
    const avg = base + l.qty > 0 ? (base * item.avg_cost + l.qty * l.unit_cost) / (base + l.qty) : l.unit_cost;
    await db.query('UPDATE stock_items SET avg_cost=$2 WHERE id=$1', [item.id, Math.round(avg * 100) / 100]);
    await moveStock(db, user, { itemId: item.id, storeId: st.id, qty: l.qty, unitCost: l.unit_cost, kind: isOpening ? 'opening' : 'receipt', refType: 'grn', refId: grn.id, date: s.business_date });
    await db.query('INSERT INTO goods_received_lines (grn_id, item_id, po_line_id, qty, unit_cost) VALUES ($1,$2,$3,$4,$5)', [grn.id, item.id, poLine?.id ?? null, l.qty, l.unit_cost]);
    total += l.qty * l.unit_cost;
  }
  total = money(total);
  let entryId = null;
  if (total > 0) {
    entryId = await postJournal(db, { date: s.business_date, description: `${grn.code} ${isOpening ? 'opening stock' : 'goods received'}${b.invoice_ref ? ' inv ' + b.invoice_ref : ''}`, refType: 'grn', refId: grn.id, userId: user.id,
      lines: [{ account: INV.inventory, debit: total }, { account: isOpening ? INV.equity : INV.payable, credit: total }] });
  }
  await db.query('UPDATE goods_received SET total=$2, journal_entry_id=$3 WHERE id=$1', [grn.id, total, entryId]);
  if (po) {
    const done = poLines.every((x) => x.received_qty >= x.qty - 1e-9);
    await db.query('UPDATE purchase_orders SET status=$2 WHERE id=$1', [po.id, done ? 'received' : 'partly_received']);
  }
  await audit(db, user, isOpening ? 'inventory.opening_stock' : 'inventory.receive', 'goods_received', grn.id, { code: grn.code, po: po?.code, total });
  return { ...grn, total };
}

/* ---------------- requisitions ---------------- */
async function reqForUpdate(db, id) {
  const { rows: [r] } = await db.query('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [id]);
  if (!r) throw new HttpError(404, 'Requisition not found.');
  return r;
}
export async function createRequisition(db, user, b) {
  const s = await getSettings(db);
  const dept = String(b.department || '');
  if (!DEPARTMENTS.includes(dept)) throw new HttpError(400, 'Choose a department.');
  const from = await store(db, b.from_store_id);
  const to = b.to_store_id ? await store(db, b.to_store_id) : null;
  if (to && to.id === from.id) throw new HttpError(400, 'Choose a different store to send the stock to.');
  const lines = cleanLines(b.lines, { costs: false });
  const { rows: [r] } = await db.query('INSERT INTO requisitions (department, from_store_id, to_store_id, notes, business_date, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [dept, from.id, to?.id ?? null, text(b.notes, 'Notes', { max: 500 }), s.business_date, user.id]);
  for (const l of lines) await db.query('INSERT INTO requisition_lines (req_id, item_id, qty_requested) VALUES ($1,$2,$3)', [r.id, l.item_id, l.qty]);
  await audit(db, user, 'requisition.create', 'requisition', r.id, { code: r.code, department: dept, lines: lines.length });
  return r;
}
export async function approveRequisition(db, user, id, b = {}) {
  const r = await reqForUpdate(db, id);
  if (r.status !== 'pending') throw new HttpError(409, 'Only pending requisitions can be approved.');
  if (r.requested_by === user.id && !isAdmin(user)) throw new HttpError(403, 'You cannot approve your own requisition.');
  const { rows: lines } = await db.query('SELECT * FROM requisition_lines WHERE req_id=$1', [r.id]);
  const changes = new Map((b.lines || []).map((l) => [Number(l.id), q3(l.qty_approved)]));
  for (const l of lines) {
    const qa = changes.has(l.id) ? changes.get(l.id) : l.qty_requested;
    if (!(qa >= 0)) throw new HttpError(400, 'Approved quantities cannot be negative.');
    await db.query('UPDATE requisition_lines SET qty_approved=$2 WHERE id=$1', [l.id, qa]);
  }
  await db.query("UPDATE requisitions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [r.id, user.id]);
  await audit(db, user, 'requisition.approve', 'requisition', r.id, { code: r.code });
}
export async function rejectRequisition(db, user, id, reason) {
  const r = await reqForUpdate(db, id);
  if (!['pending', 'approved'].includes(r.status)) throw new HttpError(409, 'This requisition can no longer be rejected.');
  const why = text(reason, 'Reason', { required: true, max: 300 });
  await db.query("UPDATE requisitions SET status='rejected', reject_reason=$2, approved_by=COALESCE(approved_by,$3) WHERE id=$1", [r.id, why, user.id]);
  await audit(db, user, 'requisition.reject', 'requisition', r.id, { code: r.code, reason: why });
}
export async function cancelRequisition(db, user, id) {
  const r = await reqForUpdate(db, id);
  if (r.status !== 'pending') throw new HttpError(409, 'Only pending requisitions can be cancelled.');
  if (r.requested_by !== user.id && !can(user, 'requisition.approve')) throw new HttpError(403, 'Only the person who raised it, or a manager, can cancel it.');
  await db.query("UPDATE requisitions SET status='cancelled' WHERE id=$1", [r.id]);
  await audit(db, user, 'requisition.cancel', 'requisition', r.id, { code: r.code });
}
/** Issue approved stock: transfer into the department's store, or expense it to the department. */
export async function issueRequisition(db, user, id, b = {}) {
  const r = await reqForUpdate(db, id);
  if (r.status !== 'approved') throw new HttpError(409, 'Only approved requisitions can be issued.');
  const s = await getSettings(db);
  const { rows: lines } = await db.query('SELECT l.*, i.avg_cost FROM requisition_lines l JOIN stock_items i ON i.id=l.item_id WHERE req_id=$1 ORDER BY l.id', [r.id]);
  const changes = new Map((b.lines || []).map((l) => [Number(l.id), q3(l.qty_issued)]));
  let total = 0;
  for (const l of lines) {
    const qi = changes.has(l.id) ? changes.get(l.id) : Number(l.qty_approved);
    if (!(qi >= 0) || qi > Number(l.qty_approved) + 1e-9) throw new HttpError(400, 'You cannot issue more than was approved.');
    await db.query('UPDATE requisition_lines SET qty_issued=$2, unit_cost=$3 WHERE id=$1', [l.id, qi, l.avg_cost]);
    if (qi === 0) continue;
    await moveStock(db, user, { itemId: l.item_id, storeId: r.from_store_id, qty: -qi, unitCost: l.avg_cost, kind: r.to_store_id ? 'transfer_out' : 'issue', refType: 'requisition', refId: r.id, note: r.department, date: s.business_date });
    if (r.to_store_id) await moveStock(db, user, { itemId: l.item_id, storeId: r.to_store_id, qty: qi, unitCost: l.avg_cost, kind: 'transfer_in', refType: 'requisition', refId: r.id, note: r.department, date: s.business_date });
    total += qi * l.avg_cost;
  }
  total = money(total);
  let entryId = null;
  if (!r.to_store_id && total > 0) {
    entryId = await postJournal(db, { date: s.business_date, description: `${r.code} issued to ${r.department}`, refType: 'requisition', refId: r.id, userId: user.id,
      lines: [{ account: INV.supplies, debit: total }, { account: INV.inventory, credit: total }] });
  }
  await db.query("UPDATE requisitions SET status='issued', issued_by=$2, issued_at=now(), total_cost=$3, journal_entry_id=$4 WHERE id=$1", [r.id, user.id, total, entryId]);
  await audit(db, user, 'requisition.issue', 'requisition', r.id, { code: r.code, total, transfer: !!r.to_store_id });
  return { total };
}
export async function getRequisition(db, id) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, fs.name AS from_store, ts.name AS to_store, ru.full_name AS requested_by_name, au.full_name AS approved_by_name, iu.full_name AS issued_by_name
     FROM requisitions r JOIN stores fs ON fs.id=r.from_store_id LEFT JOIN stores ts ON ts.id=r.to_store_id
     LEFT JOIN users ru ON ru.id=r.requested_by LEFT JOIN users au ON au.id=r.approved_by LEFT JOIN users iu ON iu.id=r.issued_by WHERE r.id=$1`, [id]);
  if (!r) throw new HttpError(404, 'Requisition not found.');
  const lines = (await db.query(
    `SELECT l.*, i.name, i.unit, i.code, COALESCE(b.qty,0) AS in_store FROM requisition_lines l JOIN stock_items i ON i.id=l.item_id
     LEFT JOIN stock_balances b ON b.item_id=l.item_id AND b.store_id=$2 WHERE req_id=$1 ORDER BY l.id`, [id, r.from_store_id])).rows;
  return { ...r, lines };
}

/* ---------------- write-offs ---------------- */
export async function writeOff(db, user, b) {
  const s = await getSettings(db);
  const st = await store(db, b.store_id);
  const item = await itemForUpdate(db, b.item_id);
  const qty = posQty(b.qty);
  const why = text(b.reason, 'Reason', { required: true, max: 300 });
  await moveStock(db, user, { itemId: item.id, storeId: st.id, qty: -qty, unitCost: item.avg_cost, kind: 'write_off', refType: 'write_off', note: why, date: s.business_date });
  const value = money(qty * item.avg_cost);
  if (value > 0) await postJournal(db, { date: s.business_date, description: `Write-off ${item.name} (${st.name}): ${why}`, refType: 'write_off', refId: item.id, userId: user.id, lines: [{ account: INV.variance, debit: value }, { account: INV.inventory, credit: value }] });
  await audit(db, user, 'inventory.write_off', 'stock_item', item.id, { store: st.name, qty, value, reason: why });
  return { value };
}

/* ---------------- stock counts ---------------- */
export async function startCount(db, user, b) {
  const s = await getSettings(db);
  const st = await store(db, b.store_id);
  const { rows: open } = await db.query("SELECT 1 FROM stock_counts WHERE store_id=$1 AND status='open'", [st.id]);
  if (open[0]) throw new HttpError(409, `A count is already open for ${st.name}.`);
  const { rows: [c] } = await db.query('INSERT INTO stock_counts (store_id, business_date, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [st.id, s.business_date, text(b.notes, 'Notes', { max: 300 }), user.id]);
  // every active item that is stocked here, or has ever moved through this store
  await db.query(
    `INSERT INTO stock_count_lines (count_id, item_id, expected_qty)
     SELECT $1, i.id, COALESCE(b.qty, 0) FROM stock_items i LEFT JOIN stock_balances b ON b.item_id=i.id AND b.store_id=$2
     WHERE i.active AND (b.item_id IS NOT NULL OR $3)`, [c.id, st.id, st.kind === 'main']);
  await audit(db, user, 'inventory.count_start', 'stock_count', c.id, { store: st.name });
  return c;
}
export async function saveCountLines(db, user, id, lines) {
  const { rows: [c] } = await db.query('SELECT * FROM stock_counts WHERE id=$1 FOR UPDATE', [id]);
  if (!c || c.status !== 'open') throw new HttpError(409, 'This count is not open.');
  for (const l of lines || []) {
    const v = l.counted_qty === '' || l.counted_qty == null ? null : q3(l.counted_qty);
    if (v != null && !(v >= 0)) throw new HttpError(400, 'Counted quantities cannot be negative.');
    await db.query('UPDATE stock_count_lines SET counted_qty=$3 WHERE count_id=$1 AND item_id=$2', [c.id, Number(l.item_id), v]);
  }
  return { ok: true };
}
export async function postCount(db, user, id) {
  const { rows: [c] } = await db.query('SELECT * FROM stock_counts WHERE id=$1 FOR UPDATE', [id]);
  if (!c || c.status !== 'open') throw new HttpError(409, 'This count is not open.');
  const s = await getSettings(db);
  const { rows: lines } = await db.query(
    `SELECT l.*, i.avg_cost, i.name, COALESCE(b.qty,0) AS current_qty FROM stock_count_lines l JOIN stock_items i ON i.id=l.item_id
     LEFT JOIN stock_balances b ON b.item_id=l.item_id AND b.store_id=$2 WHERE l.count_id=$1`, [c.id, c.store_id]);
  let loss = 0, gain = 0;
  for (const l of lines) {
    if (l.counted_qty == null) continue; // not counted: left unchanged
    const diff = q3(l.counted_qty - l.current_qty);
    await db.query('UPDATE stock_count_lines SET posted_qty=$3 WHERE count_id=$1 AND item_id=$2', [c.id, l.item_id, l.current_qty]);
    if (diff === 0) continue;
    await moveStock(db, user, { itemId: l.item_id, storeId: c.store_id, qty: diff, unitCost: l.avg_cost, kind: 'count', refType: 'stock_count', refId: c.id, date: s.business_date, allowNegative: true });
    const v = Math.abs(diff) * l.avg_cost;
    if (diff < 0) loss += v; else gain += v;
  }
  loss = money(loss); gain = money(gain);
  const jl = [];
  if (loss) jl.push({ account: INV.variance, debit: loss }, { account: INV.inventory, credit: loss });
  if (gain) jl.push({ account: INV.inventory, debit: gain }, { account: INV.variance, credit: gain });
  if (jl.length) await postJournal(db, { date: s.business_date, description: `Stock count #${c.id} variances`, refType: 'stock_count', refId: c.id, userId: user.id, lines: jl });
  await db.query("UPDATE stock_counts SET status='posted', posted_by=$2, posted_at=now(), variance_value=$3 WHERE id=$1", [c.id, user.id, gain - loss]);
  await audit(db, user, 'inventory.count_post', 'stock_count', c.id, { loss, gain });
  return { loss, gain, net: gain - loss };
}

/* ---------------- recipes & POS deduction ---------------- */
export async function saveRecipe(db, user, menuItemId, lines) {
  const { rows: [mi] } = await db.query('SELECT * FROM menu_items WHERE id=$1', [menuItemId]);
  if (!mi) throw new HttpError(404, 'Menu item not found.');
  const clean = (lines || []).filter((l) => l.item_id && Number(l.qty) > 0).map((l) => ({ item_id: Number(l.item_id), qty: Math.round(Number(l.qty) * 10000) / 10000 }));
  if (new Set(clean.map((l) => l.item_id)).size !== clean.length) throw new HttpError(400, 'Each ingredient can only appear once.');
  await db.query('DELETE FROM recipe_lines WHERE menu_item_id=$1', [mi.id]);
  for (const l of clean) await db.query('INSERT INTO recipe_lines (menu_item_id, item_id, qty) VALUES ($1,$2,$3)', [mi.id, l.item_id, l.qty]);
  await audit(db, user, 'inventory.recipe_save', 'menu_item', mi.id, { name: mi.name, ingredients: clean.length });
  return { ok: true };
}
export async function recipeCosts(db) {
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.price, c.name AS category, COALESCE(SUM(r.qty * i.avg_cost),0) AS cost, count(r.item_id)::int AS ingredients
     FROM menu_items m JOIN menu_categories c ON c.id=m.category_id LEFT JOIN recipe_lines r ON r.menu_item_id=m.id LEFT JOIN stock_items i ON i.id=r.item_id
     WHERE m.active GROUP BY m.id, c.name, c.sort ORDER BY c.sort, m.name`);
  return rows.map((r) => ({ ...r, cost: Math.round(Number(r.cost)) }));
}

/**
 * Called when a POS bill is settled: deduct recipe ingredients from the outlet's store
 * and post the cost of sales. Sales are never blocked by stock levels (stock may go negative
 * until the delivery is entered; the count corrects it).
 */
export async function deductForCheck(db, user, checkId) {
  const { rows: [c] } = await db.query('SELECT c.*, o.stock_store_id FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id WHERE c.id=$1', [checkId]);
  if (!c?.stock_store_id) return 0;
  const { rows: usage } = await db.query(
    `SELECT r.item_id, SUM(r.qty * l.qty) AS qty, i.avg_cost FROM pos_check_lines l JOIN recipe_lines r ON r.menu_item_id=l.item_id JOIN stock_items i ON i.id=r.item_id
     WHERE l.check_id=$1 AND l.status <> 'voided' GROUP BY r.item_id, i.avg_cost`, [c.id]);
  if (!usage.length) return 0;
  let total = 0;
  for (const u of usage) {
    const qty = q3(u.qty); if (!qty) continue;
    await moveStock(db, user, { itemId: u.item_id, storeId: c.stock_store_id, qty: -qty, unitCost: u.avg_cost, kind: 'sale', refType: 'pos_check', refId: c.id, note: c.code, date: c.business_date, allowNegative: true });
    total += qty * u.avg_cost;
  }
  total = money(total);
  if (total > 0) await postJournal(db, { date: c.business_date, description: `${c.code} cost of sales`, refType: 'pos_check', refId: c.id, userId: user?.id, lines: [{ account: INV.costOfSales, debit: total }, { account: INV.inventory, credit: total }] });
  await db.query('UPDATE pos_checks SET cost_of_sales=$2 WHERE id=$1', [c.id, total]);
  return total;
}

/* ---------------- reports ---------------- */
export async function stockOnHand(db, storeId) {
  const { rows } = await db.query(
    `SELECT i.id, i.code, i.name, i.unit, i.category, i.reorder_level, i.avg_cost, i.active,
            COALESCE(SUM(b.qty) FILTER (WHERE $1::int IS NULL OR b.store_id=$1), 0) AS qty
     FROM stock_items i LEFT JOIN stock_balances b ON b.item_id=i.id
     GROUP BY i.id ORDER BY i.category, i.name`, [storeId || null]);
  return rows.map((r) => ({ ...r, qty: Number(r.qty), value: Math.round(Number(r.qty) * Number(r.avg_cost)), low: Number(r.qty) <= Number(r.reorder_level) }));
}
export async function foodCost(db, from, to, vatRate) {
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.account_code='4100'),0) AS revenue,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.account_code='5000'),0) AS cost
     FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.business_date BETWEEN $1 AND $2`, [from, to]);
  const revenue = Number(r.revenue), costv = Number(r.cost);
  return { from, to, revenue_net: revenue, cost_of_sales: costv, food_cost_pct: revenue ? costv / revenue : 0, vat_rate: vatRate };
}
export async function consumption(db, from, to) {
  const { rows } = await db.query(
    `SELECT r.department, count(*)::int AS requisitions, COALESCE(SUM(r.total_cost),0)::bigint AS value,
            COALESCE(SUM(r.total_cost) FILTER (WHERE r.to_store_id IS NULL),0)::bigint AS expensed
     FROM requisitions r WHERE r.status='issued' AND r.business_date BETWEEN $1 AND $2 GROUP BY r.department ORDER BY value DESC`, [from, to]);
  return rows.map((x) => ({ ...x, value: Number(x.value), expensed: Number(x.expensed) }));
}
