// Phase 17: the public demo. With DEMO_MODE=1 this copy of Azeli PMS is a showroom: visitors from azelitech.com
// press "Explore the demo" and are signed in as a demo general manager over a sample hotel. Anything that could
// lock people out or reach the outside world is switched off, and the sample hotel is rebuilt every night.
import crypto from 'node:crypto';
import { HttpError, hashPassword, createSession, sessionCookie, audit } from './auth.js';
import { tx } from './db.js';

export const demoMode = () => process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true';
const DEMO_USER = 'demo';

/** Make sure the demo sign-in exists: full access except staff accounts. */
export async function ensureDemoUser(pool) {
  const { rows: [u] } = await pool.query('SELECT id FROM users WHERE username=$1', [DEMO_USER]);
  let id = u?.id;
  if (!id) {
    // nobody can sign in with this password: the demo sign-in goes through /api/auth/demo
    ({ rows: [{ id }] } = await pool.query("INSERT INTO users (username, full_name, password_hash, role, department, job_title) VALUES ($1,'Demo visitor',$2,'general_manager','Management','General manager') RETURNING id",
      [DEMO_USER, await hashPassword(crypto.randomBytes(24).toString('base64url'))]));
  }
  await pool.query("INSERT INTO user_permissions (user_id, perm, allow) VALUES ($1,'users.manage',FALSE) ON CONFLICT (user_id, perm) DO UPDATE SET allow=FALSE", [id]);
  await pool.query("UPDATE users SET active=TRUE, role='general_manager' WHERE id=$1", [id]);
  return id;
}

/** POST /api/auth/demo: sign in as the demo visitor. */
export async function demoSignIn(pool, res) {
  if (!demoMode()) throw new HttpError(404, 'Not found.');
  const id = await ensureDemoUser(pool);
  const { token, expires } = await createSession(pool, id);
  res.setHeader('Set-Cookie', sessionCookie(token, expires));
  return { ok: true };
}

// what a visitor may not do in the demo
const BLOCKED = [
  /^\/auth\/change-password/, /^\/auth\/mfa\/(setup|enable|disable|recovery-codes)/, /^\/users/, /^\/roles/, /^\/backups/, /^\/demo\/remove/, /^\/settings\/security/,
  /^\/reporting\/outbox\/send/, /^\/crm\/campaigns\/\d+\/(send|test)/, /^\/distribution\/channels/, /^\/messages\/(settings|templates|automations)/,
];
export const demoGuard = (req, _res, next) => {
  if (!demoMode() || ['GET', 'HEAD'].includes(req.method)) return next();
  if (BLOCKED.some((re) => re.test(req.path))) throw new HttpError(403, 'This is switched off in the demo. Book a walkthrough to see it on your own hotel.');
  next();
};

/** Every night (hotel time 03:00–03:59): wipe the sample hotel and build a fresh one, so each visitor starts clean. */
let lastReset = null;
export async function nightlyDemoReset(pool, { now = new Date(), force = false } = {}) {
  if (!demoMode()) return false;
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
  const hour = Number(now.toLocaleString('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Africa/Kampala' }));
  if (!force && (hour !== 3 || lastReset === day)) return false;
  lastReset = day;
  const demo = await import('./services/demo.js');
  const { rows: [s] } = await pool.query('SELECT property_name, demo_data FROM settings WHERE id=1');
  const { rows: [admin] } = await pool.query("SELECT id, username, role FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (s.demo_data) await demo.removeDemoData(pool, admin, { confirm: s.property_name });
  await tx(pool, (db) => db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username=$1)', [DEMO_USER]));
  await demo.generateDemoData(pool, admin, { days: 45 });
  await audit(pool, admin, 'demo.nightly_reset', 'settings', 1, { day });
  return true;
}

/** On start: a demo system with nothing in it gets its sample hotel straight away. */
export async function prepareDemo(pool) {
  if (!demoMode()) return;
  await ensureDemoUser(pool);
  const { rows: [x] } = await pool.query('SELECT (SELECT count(*) FROM reservations)::int AS n, (SELECT demo_data FROM settings WHERE id=1) AS demo');
  if (!x.n && !x.demo) await nightlyDemoReset(pool, { force: true });
}
