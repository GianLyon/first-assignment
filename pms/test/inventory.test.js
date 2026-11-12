// Phase 3: inventory, purchasing, requisitions, recipes and stock counts (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok } from './helpers.js';

let admin, mgr, store, chef, hk, waiter, S;
const item = (code) => S.items.find((i) => i.code === code);
const st = (name) => S.stores.find((s) => s.name === name);
const qtyIn = async (c, code, storeName) => (await c.get(`/api/inventory/items/${item(code).id}/balances`)).data.find((b) => b.name === storeName)?.qty ?? 0;
const lastJournal = async () => ok(await admin.get('/api/accounts/journal?limit=1'))[0].lines.map((l) => [l.account, l.debit, l.credit]);

before(async () => {
  await startTestServer({ inventory: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [username, role] of [['manager1', 'manager'], ['store1', 'storekeeper'], ['chef1', 'kitchen'], ['housekeep', 'housekeeping'], ['waiter1', 'waiter']]) {
    ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' }));
  }
  mgr = client(); await mgr.login('manager1', 'password-123');
  store = client(); await store.login('store1', 'password-123');
  chef = client(); await chef.login('chef1', 'password-123');
  hk = client(); await hk.login('housekeep', 'password-123');
  waiter = client(); await waiter.login('waiter1', 'password-123');
  S = ok(await store.get('/api/inventory/setup'));
});
after(stopTestServer);

test('roles', async () => {
  assert.equal((await waiter.get('/api/inventory/stock')).status, 403);
  assert.equal((await hk.get('/api/inventory/stock')).status, 403);
  ok(await chef.get('/api/inventory/stock'));
  assert.equal((await chef.post('/api/inventory/receipts', {})).status, 403);
  assert.equal((await store.post('/api/inventory/purchase-orders/1/approve')).status, 403);
  assert.equal((await chef.post('/api/inventory/items', { code: 'X', name: 'X', unit: 'kg' })).status, 403);
  const it = ok(await store.post('/api/inventory/items', { code: 'salt', name: 'Salt', unit: 'kg', category: 'Dry goods', reorder_level: 2 }));
  assert.equal(it.code, 'SALT');
  assert.equal((await store.post('/api/inventory/items', { code: 'SALT', name: 'Salt again', unit: 'kg' })).status, 409);
});

test('opening stock is credited to equity', async () => {
  const g = ok(await store.post('/api/inventory/receipts', { is_opening: true, store_id: st('Main store').id, lines: [
    { item_id: item('CHK').id, qty: 20, unit_cost: 15000 }, { item_id: item('SOAP').id, qty: 200, unit_cost: 800 }, { item_id: item('LAGER').id, qty: 48, unit_cost: 3500 }] }));
  assert.match(g.code, /^GRN\d+$/); assert.equal(g.total, 20 * 15000 + 200 * 800 + 48 * 3500);
  assert.deepEqual(await lastJournal(), [['1300', g.total, 0], ['3000', 0, g.total]]);
  assert.equal(await qtyIn(store, 'CHK', 'Main store'), 20);
});

test('purchase order: approval by someone else, partial deliveries, weighted average cost', async () => {
  const supplier = S.suppliers[0];
  const po = ok(await store.post('/api/inventory/purchase-orders', { supplier_id: supplier.id, store_id: st('Main store').id, lines: [{ item_id: item('CHK').id, qty: 20, unit_cost: 18000 }, { item_id: item('RICE').id, qty: 50, unit_cost: 4500 }] }));
  assert.equal((await store.post('/api/inventory/receipts', { po_id: po.id, lines: [{ item_id: item('CHK').id, qty: 5, unit_cost: 18000 }] })).status, 409); // not approved
  ok(await mgr.post(`/api/inventory/purchase-orders/${po.id}/approve`));
  assert.equal((await mgr.post(`/api/inventory/purchase-orders/${po.id}/approve`)).status, 409);
  // first delivery: 10 kg chicken at 18,000 → average (20×15,000 + 10×18,000) / 30 = 16,000
  ok(await store.post('/api/inventory/receipts', { po_id: po.id, invoice_ref: 'INV-77', lines: [{ item_id: item('CHK').id, qty: 10, unit_cost: 18000 }] }));
  assert.deepEqual(await lastJournal(), [['1300', 180000, 0], ['2000', 0, 180000]]);
  let p = ok(await store.get(`/api/inventory/purchase-orders/${po.id}`));
  assert.equal(p.status, 'partly_received');
  let stock = ok(await store.get('/api/inventory/stock'));
  assert.equal(stock.find((i) => i.code === 'CHK').avg_cost, 16000);
  assert.equal((await store.post('/api/inventory/receipts', { po_id: po.id, lines: [{ item_id: item('CHK').id, qty: 11, unit_cost: 18000 }] })).status, 400); // more than outstanding
  assert.equal((await store.post('/api/inventory/receipts', { po_id: po.id, lines: [{ item_id: item('BEEF').id, qty: 1, unit_cost: 1 }] })).status, 400); // not on PO
  ok(await store.post('/api/inventory/receipts', { po_id: po.id, lines: [{ item_id: item('CHK').id, qty: 10, unit_cost: 18000 }, { item_id: item('RICE').id, qty: 50, unit_cost: 4500 }] }));
  p = ok(await store.get(`/api/inventory/purchase-orders/${po.id}`));
  assert.equal(p.status, 'received');
  assert.equal((await store.post(`/api/inventory/purchase-orders/${po.id}/cancel`)).status, 409);
  stock = ok(await store.get('/api/inventory/stock'));
  assert.equal(stock.find((i) => i.code === 'CHK').qty, 40);
  assert.equal(stock.find((i) => i.code === 'CHK').avg_cost, 16500); // (30×16,000 + 10×18,000) / 40
  // a manager cannot approve an order they raised themselves
  const own = ok(await mgr.post('/api/inventory/purchase-orders', { supplier_id: supplier.id, store_id: st('Main store').id, lines: [{ item_id: item('VEG').id, qty: 10, unit_cost: 3000 }] }));
  assert.equal((await mgr.post(`/api/inventory/purchase-orders/${own.id}/approve`)).status, 403);
});

test('requisitions: request, approve (not your own), issue as transfer or department expense', async () => {
  // kitchen asks for chicken to be moved into the kitchen store
  const rq = ok(await chef.post('/api/inventory/requisitions', { department: 'Kitchen', from_store_id: st('Main store').id, to_store_id: st('Kitchen').id, lines: [{ item_id: item('CHK').id, qty: 15 }] }));
  assert.match(rq.code, /^RQ\d+$/);
  assert.equal((await chef.post(`/api/inventory/requisitions/${rq.id}/approve`)).status, 403);
  assert.equal((await store.post(`/api/inventory/requisitions/${rq.id}/issue`)).status, 409); // not approved yet
  const full = ok(await mgr.get(`/api/inventory/requisitions/${rq.id}`));
  ok(await mgr.post(`/api/inventory/requisitions/${rq.id}/approve`, { lines: [{ id: full.lines[0].id, qty_approved: 12 }] }));
  assert.equal((await store.post(`/api/inventory/requisitions/${rq.id}/issue`, { lines: [{ id: full.lines[0].id, qty_issued: 13 }] })).status, 400); // above approved
  ok(await store.post(`/api/inventory/requisitions/${rq.id}/issue`));
  assert.equal(await qtyIn(store, 'CHK', 'Main store'), 28);
  assert.equal(await qtyIn(store, 'CHK', 'Kitchen'), 12);
  // housekeeping soap is used up by the department: expensed
  const h = ok(await hk.post('/api/inventory/requisitions', { department: 'Housekeeping', from_store_id: st('Main store').id, lines: [{ item_id: item('SOAP').id, qty: 50 }] }));
  ok(await mgr.post(`/api/inventory/requisitions/${h.id}/approve`));
  const iss = ok(await store.post(`/api/inventory/requisitions/${h.id}/issue`));
  assert.equal(iss.total, 50 * 800);
  assert.deepEqual(await lastJournal(), [['5100', 40000, 0], ['1300', 0, 40000]]);
  // cannot issue more than the store holds
  const big = ok(await chef.post('/api/inventory/requisitions', { department: 'Kitchen', from_store_id: st('Main store').id, to_store_id: st('Kitchen').id, lines: [{ item_id: item('BEEF').id, qty: 5 }] }));
  ok(await mgr.post(`/api/inventory/requisitions/${big.id}/approve`));
  const fail = await store.post(`/api/inventory/requisitions/${big.id}/issue`);
  assert.equal(fail.status, 409); assert.match(fail.data.error, /Not enough Beef fillet/);
  ok(await mgr.post(`/api/inventory/requisitions/${big.id}/reject`, { reason: 'Out of stock, order raised' }));
  // managers cannot approve their own requisitions
  const mine = ok(await mgr.post('/api/inventory/requisitions', { department: 'Administration', from_store_id: st('Main store').id, lines: [{ item_id: item('SOAP').id, qty: 1 }] }));
  assert.equal((await mgr.post(`/api/inventory/requisitions/${mine.id}/approve`)).status, 403);
  ok(await mgr.post(`/api/inventory/requisitions/${mine.id}/cancel`));
});

test('POS sales deduct recipe ingredients from the outlet store and post cost of sales', async () => {
  const setup = ok(await waiter.get('/api/pos/setup'));
  const rest = setup.outlets.find((o) => o.name === 'Restaurant');
  const dish = setup.items.find((i) => i.name === 'Chicken luwombo');
  ok(await waiter.post('/api/pos/shift/open', { outlet_id: rest.id }));
  const c = ok(await waiter.post('/api/pos/checks', { outlet_id: rest.id }));
  ok(await waiter.post(`/api/pos/checks/${c.id}/lines`, { item_id: dish.id, qty: 2 }));
  ok(await waiter.post(`/api/pos/checks/${c.id}/settle`, { payments: [{ method: 'cash', amount: 90000 }] }));
  assert.equal(await qtyIn(store, 'CHK', 'Kitchen'), 12 - 0.8);
  // 0.8 kg chicken at 16,500 = 13,200; vegetables and matoke have no stock or cost yet
  assert.deepEqual(await lastJournal(), [['5000', 13200, 0], ['1300', 0, 13200]]);
  // selling with no stock is allowed (negative), and shows on the report
  const tea = setup.items.find((i) => i.name === 'Whole grilled tilapia & chips');
  const c2 = ok(await waiter.post('/api/pos/checks', { outlet_id: rest.id }));
  ok(await waiter.post(`/api/pos/checks/${c2.id}/lines`, { item_id: tea.id, qty: 1 }));
  ok(await waiter.post(`/api/pos/checks/${c2.id}/settle`, { payments: [{ method: 'card', amount: 55000 }] }));
  const rep = ok(await mgr.get('/api/inventory/reports/summary'));
  assert.ok(rep.negative.some((n) => n.name === 'Tilapia (whole)' && n.store_name === 'Kitchen'));
  assert.ok(rep.food_cost.cost_of_sales >= 13200);
  assert.ok(rep.food_cost.revenue_net > 0);
});

test('write-offs and stock counts post variances; the books stay balanced', async () => {
  assert.equal((await store.post('/api/inventory/write-offs', { store_id: st('Main store').id, item_id: item('LAGER').id, qty: 2 })).status, 400); // reason required
  ok(await store.post('/api/inventory/write-offs', { store_id: st('Main store').id, item_id: item('LAGER').id, qty: 2, reason: 'Broken in delivery' }));
  assert.deepEqual(await lastJournal(), [['5900', 7000, 0], ['1300', 0, 7000]]);
  const c = ok(await store.post('/api/inventory/counts', { store_id: st('Main store').id }));
  assert.equal((await store.post('/api/inventory/counts', { store_id: st('Main store').id })).status, 409); // one open count per store
  const full = ok(await store.get(`/api/inventory/counts/${c.id}`));
  assert.ok(full.lines.find((l) => l.code === 'LAGER').expected_qty === 46);
  // count: 44 lager (2 missing), 30 chicken (2 more than the system), rice not counted
  ok(await store.put(`/api/inventory/counts/${c.id}/lines`, { lines: [{ item_id: item('LAGER').id, counted_qty: 44 }, { item_id: item('CHK').id, counted_qty: 30 }] }));
  const res = ok(await store.post(`/api/inventory/counts/${c.id}/post`));
  assert.equal(res.loss, 2 * 3500); assert.equal(res.gain, 2 * 16500);
  assert.equal(await qtyIn(store, 'LAGER', 'Main store'), 44);
  assert.equal(await qtyIn(store, 'CHK', 'Main store'), 30);
  assert.equal(await qtyIn(store, 'RICE', 'Main store'), 50); // uncounted lines are untouched
  const mv = ok(await store.get(`/api/inventory/items/${item('LAGER').id}/movements`));
  assert.deepEqual(mv.map((m) => m.kind), ['count', 'write_off', 'opening']);
  const tb = ok(await admin.get('/api/accounts/trial-balance'));
  assert.equal(tb.total_debit, tb.total_credit);
});

test('recipes can be edited and are costed; consumption report', async () => {
  const recipes = ok(await mgr.get('/api/inventory/recipes'));
  const luwombo = recipes.find((r) => r.name === 'Chicken luwombo');
  assert.equal(luwombo.ingredients, 3);
  ok(await mgr.put(`/api/inventory/recipes/${luwombo.id}`, { lines: [{ item_id: item('CHK').id, qty: 0.5 }] }));
  const after2 = ok(await mgr.get('/api/inventory/recipes')).find((r) => r.name === 'Chicken luwombo');
  assert.equal(after2.ingredients, 1); assert.equal(after2.cost, Math.round(0.5 * 16500));
  assert.equal((await mgr.put(`/api/inventory/recipes/${luwombo.id}`, { lines: [{ item_id: item('CHK').id, qty: 1 }, { item_id: item('CHK').id, qty: 1 }] })).status, 400);
  const rep = ok(await mgr.get('/api/inventory/reports/summary'));
  assert.equal(rep.consumption.find((d) => d.department === 'Housekeeping').expensed, 40000);
  assert.equal(rep.consumption.find((d) => d.department === 'Kitchen').value, 12 * 16500);
  assert.ok(rep.stores.find((s) => s.name === 'Main store').value > 0);
  const log = ok(await admin.get('/api/audit-log?limit=200'));
  for (const a of ['inventory.opening_stock', 'purchase.approve', 'inventory.receive', 'requisition.issue', 'inventory.write_off', 'inventory.count_post', 'inventory.recipe_save']) assert.ok(log.some((l) => l.action === a), a);
});
