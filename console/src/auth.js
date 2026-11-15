// Team sign-in, roles and the audit trail.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters.');
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}
// a fixed hash so a sign-in for an unknown email takes as long as a real one
const DUMMY = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
export const checkPassword = (password, stored) => verifyPassword(password, stored || DUMMY).then((ok) => ok && !!stored);

/* owner: everything · editor: website content · sales: enquiries and clients (view) */
export const ROLES = { owner: 'Owner', editor: 'Website editor', sales: 'Sales' };
const PERMS = {
  owner: ['*'],
  editor: ['content.edit', 'content.publish', 'leads.view'],
  sales: ['leads.manage', 'leads.view', 'clients.view'],
};
export const can = (user, perm) => !!user && (PERMS[user.role] || []).some((p) => p === '*' || p === perm);
export const ALL_PERMS = ['content.edit', 'content.publish', 'leads.view', 'leads.manage', 'clients.view', 'clients.manage', 'team.manage'];

const COOKIE = 'azeli_console';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600e3);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [sha256(token), userId, expires]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires.toUTCString()}${config.production ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.production ? '; Secure' : ''}`;
function readToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}
export const loadUser = (pool) => async (req, _res, next) => {
  req.user = null;
  const t = readToken(req);
  if (t) {
    const { rows: [u] } = await pool.query(`SELECT u.id, u.email, u.full_name, u.role, (u.totp_secret IS NOT NULL) AS mfa_enabled,
        COALESCE(u.role = ANY(cs.mfa_required_roles), FALSE) AS mfa_required FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN console_settings cs ON cs.id=1
      WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`, [sha256(t)]);
    if (u) { req.user = u; req.sessionHash = sha256(t); }
  }
  next();
};
export const destroySession = (pool, req) => (req.sessionHash ? pool.query('DELETE FROM sessions WHERE token_hash=$1', [req.sessionHash]) : null);
export const requireUser = (req, _res, next) => { if (!req.user) throw new HttpError(401, 'Please sign in.'); next(); };
export const requirePerm = (...perms) => (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  if (!perms.some((p) => can(req.user, p))) throw new HttpError(403, 'You do not have permission to do this.');
  next();
};

/* failed sign-ins: 5 per email + address, then a 10-minute pause */
const attempts = new Map();
export function checkThrottle(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 10 minutes.');
}
export function recordFailure(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1; if (a.n >= 5) { a.until = Date.now() + 10 * 60e3; a.n = 0; }
  attempts.set(key, a);
}
export const clearFailures = (key) => attempts.delete(key);

export const audit = (db, user, action, entity, id, details = {}) =>
  db.query('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)', [user?.id ?? null, action, entity, id == null ? null : String(id), details]);
