// Phase 17: roles in the database, department heads, and rights for one person.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok } from './helpers.js';

let admin;
const make = async (username, role) => { ok(await admin.post('/api/users', { username, full_name: username.toUpperCase(), role, password: 'password-123' })); const c = client(); await c.login(username, 'password-123'); return c; };
const can = async (c) => ok(await c.get('/api/meta')).can;

before(async () => { await startTestServer({ pos: true, inventory: true, operations: true }); admin = client(); await admin.login('admin', 'admin-pass-123'); });
after(stopTestServer);

test('new roles: general manager has everything, finance manager everything but staff accounts, department heads their department', async () => {
  const acc = ok(await admin.get('/api/access'));
  const keys = acc.roles.map((r) => r.key);
  for (const k of ['general_manager', 'finance_manager', 'fo_supervisor', 'hk_supervisor', 'fnb_manager', 'stores_manager', 'sales_marketing']) assert.ok(keys.includes(k), k);
  assert.ok(acc.catalogue.every((p) => p.module && p.label));
  const gm = await make('gm1', 'general_manager'), fin = await make('fin1', 'finance_manager'), hks = await make('hks1', 'hk_supervisor'), fnb = await make('fnb1', 'fnb_manager');
  const g = await can(gm), f = await can(fin), h = await can(hks), b = await can(fnb);
  assert.ok(Object.values(g).every(Boolean));
  assert.equal(f['users.manage'], false); assert.equal(f['finance.manage'], true); assert.equal(f['pos.manage'], true); assert.equal(f['audit.run'], true);
  assert.equal(h['housekeeping.supervise'], true); assert.equal(h['finance.view'], false); assert.equal(h['pos.use'], false);
  assert.equal(b['pos.void'], true); assert.equal(b['requisition.approve'], true); assert.equal(b['reservations.manage'], false);
  assert.equal((await gm.get('/api/access')).status, 200);
  assert.equal((await fin.get('/api/access')).status, 403);
  // the GM can approve their own leave-type overrides like the administrator (full access)
  assert.equal(ok(await gm.get('/api/auth/me')).permissions.includes('*'), true);
});

test('a person can get extra rights or have some taken away; their role is untouched', async () => {
  const rec = await make('rec1', 'front_office');
  assert.equal((await can(rec))['events.manage'], true);
  const me = ok(await admin.get('/api/users')).find((u) => u.username === 'rec1');
  assert.equal((await admin.put(`/api/users/${me.id}/permissions`, { grants: ['inventory.view', 'not.a.right'], removals: ['events.manage'] })).status, 200);
  const c = await can(rec);
  assert.equal(c['inventory.view'], true); assert.equal(c['events.manage'], false); assert.equal(c['reservations.manage'], true);
  assert.equal((await rec.get('/api/ops/events')).status, 200); // events.view stays
  assert.equal((await rec.post('/api/ops/events', {})).status, 403); // events.manage removed
  const acc = ok(await admin.get('/api/access'));
  assert.deepEqual(acc.overrides.filter((o) => o.user_id === me.id).map((o) => [o.perm, o.allow]).sort(), [['events.manage', false], ['inventory.view', true]]);
  // other receptionists are not affected
  const rec2 = await make('rec2', 'front_office');
  assert.equal((await can(rec2))['inventory.view'], false);
  // back to the role
  ok(await admin.put(`/api/users/${me.id}/permissions`, { grants: [], removals: [] }));
  assert.equal((await can(rec))['events.manage'], true);
});

test('roles can be edited, reset, created and deleted; full access is protected', async () => {
  // take night audit away from every night auditor
  const na = await make('na1', 'night_auditor');
  const role = ok(await admin.get('/api/access')).roles.find((r) => r.key === 'night_auditor');
  ok(await admin.put('/api/roles/night_auditor', { name: role.name, perms: role.perms.filter((p) => p !== 'audit.run') }));
  assert.equal((await can(na))['audit.run'], false);
  ok(await admin.post('/api/roles/night_auditor/reset'));
  assert.equal((await can(na))['audit.run'], true);
  assert.equal((await admin.put('/api/roles/admin', { perms: [] })).status, 400);
  // a custom role
  const spa = ok(await admin.post('/api/roles', { key: 'Spa manager', name: 'Spa manager', department: 'Spa', perms: ['amenities.sell', 'amenities.manage', 'reports.view', 'bogus'] }));
  assert.equal(spa.key, 'spa_manager'); assert.deepEqual(spa.perms, ['amenities.sell', 'amenities.manage', 'reports.view']);
  const sp = await make('spa1', 'spa_manager');
  assert.equal((await can(sp))['amenities.manage'], true);
  assert.equal((await admin.post('/api/roles/spa_manager/delete')).status, 409); // someone has it
  assert.equal((await admin.post('/api/users', { username: 'x1', full_name: 'X', role: 'emperor', password: 'password-123' })).status, 400);
  // someone with staff rights but not full access cannot hand out full access
  const hr = await make('hr1', 'hr_officer');
  const hrUser = ok(await admin.get('/api/users')).find((u) => u.username === 'hr1');
  ok(await admin.put(`/api/users/${hrUser.id}/permissions`, { grants: ['users.manage'], removals: [] }));
  assert.equal((await hr.put('/api/roles/hr_officer', { full_access: true })).status, 403);
  assert.equal((await hr.post('/api/users', { username: 'boss2', full_name: 'Boss', role: 'general_manager', password: 'password-123' })).status, 403);
  assert.equal((await hr.put(`/api/users/${hrUser.id}`, { role: 'general_manager' })).status, 403); // nor promote anyone to full access
  assert.equal((await hr.post('/api/users', { username: 'cook2', full_name: 'Cook', role: 'kitchen', password: 'password-123' })).status, 200);
  assert.equal((await hr.put(`/api/users/${hrUser.id}/permissions`, { grants: [], removals: ['users.manage'] })).status, 400); // not your own
});
