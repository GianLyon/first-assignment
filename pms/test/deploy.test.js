// Go-live: health check, first-start setup that is safe to repeat, and proxy-aware visitor addresses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, client, ok, ctx } from './helpers.js';
import { seedAll } from '../src/seed.js';

before(async () => { await startTestServer(); });
after(stopTestServer);

test('health check answers without signing in', async () => {
  const r = await fetch(ctx.base + '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('first-start setup fills in what is missing and is safe to run again', async () => {
  const logs = [];
  const env = { PROPERTY_NAME: 'Other Name', ADMIN_PASSWORD: 'ignored-123', PUBLIC_URL: 'https://pms.example.com/' };
  const r = await seedAll(ctx.pool, env, (m) => logs.push(m));
  assert.equal(r.skipped, true); // the property already exists: nothing is overwritten
  const s = (await ctx.pool.query('SELECT property_name, public_url FROM settings')).rows[0];
  assert.equal(s.property_name, 'Test Hotel');
  assert.equal(s.public_url, 'https://pms.example.com');
  assert.ok(logs.some((l) => /Restaurant, bar/.test(l))); // missing parts were added
  const again = []; await seedAll(ctx.pool, env, (m) => again.push(m));
  assert.ok(!again.some((l) => /Restaurant, bar/.test(l)));
  const n = (await ctx.pool.query('SELECT count(*)::int AS n FROM outlets')).rows[0].n;
  await seedAll(ctx.pool, env, () => {});
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM outlets')).rows[0].n, n);
  const admin = client(); await admin.login('admin', 'admin-pass-123'); // the original password still works
  ok(await admin.get('/api/auth/me'));
});
