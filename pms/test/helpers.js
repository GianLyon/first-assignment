// Shared test helpers: a fresh database, a running server and a cookie-keeping API client.
import assert from 'node:assert/strict';
import { createPool, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedProperty, seedPos, seedInventory } from '../src/seed.js';

export const DB = process.env.TEST_DATABASE_URL || 'postgres://hk:hk_dev_pw@localhost:5432/hk_pms_test';
export const DAY0 = '2026-11-10';
export const ctx = { pool: null, server: null, base: '' };

/** Wipe the test database, migrate, seed and start the app on a random port. */
export async function startTestServer({ pos = false, inventory = false } = {}) {
  ctx.pool = createPool(DB);
  await ctx.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(ctx.pool);
  await seedProperty(ctx.pool, { propertyName: 'Test Hotel', adminPassword: 'admin-pass-123', businessDate: DAY0 });
  if (pos || inventory) await seedPos(ctx.pool);
  if (inventory) await seedInventory(ctx.pool);
  ctx.server = createApp(ctx.pool).listen(0);
  ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
  return ctx;
}
export async function stopTestServer() { ctx.server?.close(); await ctx.pool?.end(); }

export function client() {
  let cookie = '';
  const call = async (method, path, body, { raw = false, headers = {} } = {}) => {
    const res = await fetch(ctx.base + path, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  return {
    get: (p) => call('GET', p), post: (p, b = {}, o) => call('POST', p, b, o), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b),
    login: async (u, pw) => { const r = await call('POST', '/api/auth/login', { username: u, password: pw }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r; },
  };
}
export const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
export const roomId = async (c, number) => (await c.get('/api/rooms')).data.find((r) => r.number === number).id;
export const typeId = async (c, code) => (await c.get('/api/room-types')).data.find((t) => t.code === code).id;
export const book = (c, type_id, arrival, departure, first = 'Test', extra = {}) =>
  c.post('/api/reservations', { room_type_id: type_id, arrival, departure, guest: { first_name: first, last_name: 'Guest', phone: '+256700000000' }, ...extra });
