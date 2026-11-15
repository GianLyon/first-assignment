// Phase 11: two-step sign-in and backups (real PostgreSQL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, stopTestServer, client, ok, ctx, DB } from './helpers.js';
import * as totp from '../src/totp.js';
import { createPool, migrate } from '../src/db.js';
import { createBackup, restoreBackup, runBackup, decrypt } from '../src/backup.js';
import { generateDemoData } from '../src/services/demo.js';

let admin, mgr;
const secretOf = async (username, col = 'totp_secret') => (await ctx.pool.query(`SELECT ${col} AS s FROM users WHERE username=$1`, [username])).rows[0].s;
const now = (secret) => totp.codeAt(secret, totp.stepNow());

before(async () => {
  await startTestServer({ inventory: true, distribution: true, operations: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  ok(await admin.post('/api/users', { username: 'manager1', full_name: 'Grace Manager', role: 'manager', password: 'password-123' }));
  mgr = client(); await mgr.login('manager1', 'password-123');
});
after(stopTestServer);

test('authenticator codes match the RFC 6238 test values', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) assert.equal(totp.codeAt(secret, Math.floor(t / 30)), code);
  const st = totp.stepNow();
  assert.equal(totp.verifyCode(secret, totp.codeAt(secret, st - 1)), st - 1); // a code from 30 s ago still works
  assert.equal(totp.verifyCode(secret, totp.codeAt(secret, st - 3)), null);
});

test('two-step sign-in: set up, sign in with a code, codes work once, recovery codes, turning off', async () => {
  const setup = ok(await admin.post('/api/auth/mfa/setup'));
  assert.match(setup.qr_svg, /^<svg/);
  assert.equal(setup.secret.replace(/ /g, ''), await secretOf('admin', 'totp_pending'));
  assert.equal((await admin.post('/api/auth/mfa/enable', { code: '000000' })).status, 400);
  const pending = await secretOf('admin', 'totp_pending');
  const en = ok(await admin.post('/api/auth/mfa/enable', { code: now(pending) }));
  assert.equal(en.recovery_codes.length, 10);
  assert.equal((ok(await admin.get('/api/auth/me'))).mfa.enabled, true);

  // the password alone is no longer enough
  const c = client();
  const step1 = ok(await c.post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' }));
  assert.equal(step1.mfa_required, true);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  assert.equal((await c.post('/api/auth/mfa', { challenge: step1.challenge, code: '123456' })).status, 401);
  const secret = await secretOf('admin');
  // the code used to switch it on cannot be reused; wait for the next one if needed
  let code = now(secret);
  if (totp.verifyCode(secret, code, (await ctx.pool.query("SELECT totp_last_step FROM users WHERE username='admin'")).rows[0].totp_last_step) == null) code = totp.codeAt(secret, totp.stepNow() + 1);
  ok(await c.post('/api/auth/mfa', { challenge: step1.challenge, code }));
  ok(await c.get('/api/auth/me'));
  // the same code cannot be used twice
  const c2 = client();
  const s2 = ok(await c2.post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' }));
  assert.equal((await c2.post('/api/auth/mfa', { challenge: s2.challenge, code })).status, 401);
  // a recovery code works once
  const r = ok(await c2.post('/api/auth/mfa', { challenge: s2.challenge, code: en.recovery_codes[0].toLowerCase() }));
  assert.equal(r.recovery_codes_left, 9);
  const s3 = ok(await client().post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' }));
  const c3 = client();
  assert.equal((await c3.post('/api/auth/mfa', { challenge: s3.challenge, code: en.recovery_codes[0] })).status, 401);
  // five wrong codes end the attempt
  const c4 = client(); const s4 = ok(await c4.post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' }));
  for (let i = 0; i < 5; i++) await c4.post('/api/auth/mfa', { challenge: s4.challenge, code: '000000' });
  assert.equal((await c4.post('/api/auth/mfa', { challenge: s4.challenge, code: en.recovery_codes[1] })).status, 429);
  // turning it off needs the password
  assert.equal((await c.post('/api/auth/mfa/disable', { password: 'wrong' })).status, 400);
  ok(await c.post('/api/auth/mfa/disable', { password: 'admin-pass-123' }));
  assert.equal(await secretOf('admin'), null);
  admin = c;
});

test('required for a role: set-up first, nothing else until then; an administrator can reset it', async () => {
  assert.equal((await mgr.put('/api/settings/security', { mfa_required_roles: ['manager'] })).status, 403);
  ok(await admin.put('/api/settings/security', { mfa_required_roles: ['manager', 'not-a-role'] }));
  assert.deepEqual(ok(await admin.get('/api/settings')).mfa_required_roles, ['manager']);
  const me = ok(await mgr.get('/api/auth/me'));
  assert.equal(me.mfa.setup_needed, true);
  assert.equal((await mgr.get('/api/dashboard')).status, 403);
  assert.equal((await mgr.get('/api/finance/pl')).status, 403);
  ok(await mgr.get('/api/meta'));
  ok(await mgr.post('/api/auth/mfa/setup'));
  ok(await mgr.post('/api/auth/mfa/enable', { code: now(await secretOf('manager1', 'totp_pending')) }));
  ok(await mgr.get('/api/dashboard'));
  assert.equal((await mgr.post('/api/auth/mfa/disable', { password: 'password-123' })).status, 409); // required: cannot be switched off
  // lost phone: the administrator resets it; the manager is signed out and must set it up again
  const u = ok(await admin.get('/api/users')).find((x) => x.username === 'manager1');
  assert.equal(u.mfa_enabled, true);
  ok(await admin.post(`/api/users/${u.id}/mfa-reset`));
  assert.equal((await mgr.get('/api/auth/me')).status, 401);
  const again = client(); ok(await again.post('/api/auth/login', { username: 'manager1', password: 'password-123' }));
  assert.equal(ok(await again.get('/api/auth/me')).mfa.setup_needed, true);
  ok(await admin.put('/api/settings/security', { mfa_required_roles: [] }));
});

test('backups: encrypted, uploaded with a signed request, and restored exactly into an empty database', async () => {
  // sample data gives every part of the system something to back up
  const { rows: [adm] } = await ctx.pool.query("SELECT * FROM users WHERE username='admin'");
  await ctx.pool.query('DELETE FROM guests'); // nothing yet; keeps the "new system" check happy
  await generateDemoData(ctx.pool, adm, { days: 7 });

  // a stand-in for Cloudflare R2
  const stored = {};
  const s3 = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const ok2 = req.method === 'PUT' && /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '');
      if (!ok2) { res.statusCode = 403; return res.end('bad signature'); }
      stored[req.url] = Buffer.concat(chunks); res.end();
    });
  }).listen(0);
  const config = { endpoint: `http://127.0.0.1:${s3.address().port}`, bucket: 'azeli-backups', accessKey: 'AKIA_TEST', secretKey: 'secret', region: 'auto', passphrase: 'a long and secret backup key 2026', hour: 3 };
  const r = await runBackup(ctx.pool, { trigger: 'manual', config });
  s3.close();
  assert.match(r.key, /^test-hotel\/daily\/\d{2}\.azbk$/);
  const file = stored[`/azeli-backups/${r.key}`];
  assert.ok(file && file.length === r.size);
  assert.ok(!file.toString('latin1').includes('Test Hotel'), 'the file must be encrypted');
  assert.throws(() => decrypt(file, 'the wrong key, quite long'), /Wrong backup key/);
  const runs = ok(await admin.get('/api/backups'));
  assert.equal(runs.runs[0].status, 'ok');

  // restore into a separate, empty database
  const target = DB.replace(/\/[^/]+$/, '/hk_pms_restore_test');
  await ctx.pool.query('DROP DATABASE IF EXISTS hk_pms_restore_test').catch(() => {});
  await ctx.pool.query('CREATE DATABASE hk_pms_restore_test');
  const pool2 = createPool(target);
  try {
    await migrate(pool2);
    const res = await restoreBackup(pool2, file, config.passphrase);
    assert.equal(res.property, 'Test Hotel');
    const tables = (await ctx.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('sessions','mfa_challenges') ORDER BY 1")).rows.map((x) => x.tablename);
    for (const t of tables) {
      const [a, b] = await Promise.all([ctx.pool.query(`SELECT count(*)::int AS n FROM "${t}"`), pool2.query(`SELECT count(*)::int AS n FROM "${t}"`)]);
      if (t !== 'backup_runs') assert.equal(b.rows[0].n, a.rows[0].n, `rows in ${t}`);
    }
    const sum = (p) => p.query('SELECT SUM(debit)::bigint AS d, SUM(credit)::bigint AS c, count(*)::int AS n FROM journal_lines').then((x) => x.rows[0]);
    assert.deepEqual(await sum(pool2), await sum(ctx.pool));
    const seq = (p) => p.query('SELECT last_value FROM reservation_code_seq').then((x) => Number(x.rows[0].last_value));
    assert.equal(await seq(pool2), await seq(ctx.pool)); // new bookings continue the numbering
    const guest = (p) => p.query('SELECT first_name, email, tags, created_at FROM guests ORDER BY id LIMIT 1').then((x) => x.rows[0]);
    assert.deepEqual(await guest(pool2), await guest(ctx.pool));
    // a backup from another version is refused, and nothing changes
    await pool2.query("DELETE FROM schema_migrations WHERE name='011_security.sql'");
    await assert.rejects(restoreBackup(pool2, file, config.passphrase), /differs from the backup/);
  } finally { await pool2.end(); await ctx.pool.query('DROP DATABASE IF EXISTS hk_pms_restore_test').catch(() => {}); }
});

test('backup download for the administrator only; refused without a key', async () => {
  const m = client(); await m.login('manager1', 'password-123');
  assert.equal((await m.get('/api/backups')).status, 403);
  assert.equal((await m.get('/api/backups/download')).status, 403);
  const saved = process.env.BACKUP_KEY;
  try {
    delete process.env.BACKUP_KEY;
    assert.equal((await admin.get('/api/backups/download')).status, 409);
    process.env.BACKUP_KEY = 'another long backup key for the test';
    assert.equal((await admin.get('/api/backups/download')).status, 200);
    const run = ok(await admin.get('/api/backups')).runs[0];
    assert.deepEqual([run.trigger, run.status], ['download', 'ok']);
    assert.ok(run.size_bytes > 1000);
    assert.equal(ok(await admin.get('/api/backups')).key_set, true);
  } finally { if (saved) process.env.BACKUP_KEY = saved; else delete process.env.BACKUP_KEY; }
});
