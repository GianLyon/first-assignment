// Phase 17: the public demo (DEMO_MODE=1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, typeId, ctx } from './helpers.js';
import { prepareDemo, nightlyDemoReset } from '../src/demomode.js';

before(async () => { process.env.DEMO_MODE = '1'; await startTestServer({ pos: true, inventory: true, distribution: true, hr: true, operations: true }); });
after(async () => { delete process.env.DEMO_MODE; await stopTestServer(); });

test('a demo system fills itself with a sample hotel and lets visitors in with one click', { timeout: 240000 }, async () => {
  await prepareDemo(ctx.pool);
  assert.ok((await ctx.pool.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n > 50);
  const info = ok(await client().get('/api/demo-info'));
  assert.equal(info.demo, true);
  const v = client();
  ok(await v.post('/api/auth/demo'));
  const me = ok(await v.get('/api/auth/me'));
  assert.equal(me.user.username, 'demo'); assert.equal(me.user.role, 'general_manager');
  const can = ok(await v.get('/api/meta')).can;
  assert.equal(can['finance.manage'], true); assert.equal(can['users.manage'], false);
  // visitors can work the hotel …
  ok(await v.post('/api/reservations', { room_type_id: await typeId(v, 'STD'), arrival: me.settings.business_date.slice(0, 10), departure: new Date(Date.parse(me.settings.business_date) + 3 * 864e5).toISOString().slice(0, 10), guest: { first_name: 'Visitor', last_name: 'Test' } }));
  // … but not lock others out or reach the outside world
  for (const [m, path, body] of [['post', '/api/auth/change-password', { current: 'x', password: 'whatever-123' }], ['post', '/api/auth/mfa/setup', {}], ['post', '/api/users', {}], ['put', '/api/roles/manager', {}], ['post', '/api/backups', {}], ['post', '/api/reporting/outbox/send', {}], ['post', '/api/demo/remove', {}]]) {
    const r = await v[m](path, body);
    assert.equal(r.status, 403, path); assert.match(r.data.error, /demo/, path);
  }
  // the nightly rebuild starts again from a clean sample hotel
  assert.equal(await nightlyDemoReset(ctx.pool, { force: true }), true);
  assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM guests WHERE first_name='Visitor'")).rows[0].n, 0);
  assert.equal((await v.get('/api/auth/me')).status, 401); // visitors start a fresh session
  ok(await v.post('/api/auth/demo'));
  // without DEMO_MODE the door is closed
  delete process.env.DEMO_MODE;
  assert.equal((await client().post('/api/auth/demo')).status, 404);
  process.env.DEMO_MODE = '1';
});
