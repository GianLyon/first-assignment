import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

/* ---------- passwords ---------- */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
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

/* ---------- roles & permissions ---------- */
export const PERMISSIONS = {
  admin: ['*'],
  manager: ['reservations.view', 'reservations.manage', 'frontdesk.checkin', 'frontdesk.checkout', 'folio.post', 'folio.void', 'payments.post',
    'housekeeping.update', 'audit.run', 'accounts.view', 'reports.view', 'settings.manage', 'auditlog.view'],
  front_office: ['reservations.view', 'reservations.manage', 'frontdesk.checkin', 'frontdesk.checkout', 'folio.post', 'payments.post', 'housekeeping.update', 'reports.view'],
  night_auditor: ['reservations.view', 'reservations.manage', 'frontdesk.checkin', 'frontdesk.checkout', 'folio.post', 'payments.post', 'audit.run', 'reports.view', 'accounts.view'],
  housekeeping: ['reservations.view', 'housekeeping.update'],
  accountant: ['reservations.view', 'folio.void', 'accounts.view', 'reports.view', 'auditlog.view'],
};
export const ROLES = Object.keys(PERMISSIONS);
export const ALL_PERMISSIONS = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p !== '*')), 'users.manage'];
export const can = (user, perm) => !!user && (PERMISSIONS[user.role] || []).some((p) => p === '*' || p === perm);

/* ---------- sessions ---------- */
const COOKIE = 'hk_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600e3);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, expires]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, expires };
}
export function sessionCookie(token, expires) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${config.production ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.production ? '; Secure' : ''}`;

function readToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

export function loadUser(pool) {
  return async (req, _res, next) => {
    const token = readToken(req);
    req.user = null;
    if (token) {
      const { rows } = await pool.query(
        `SELECT u.id, u.username, u.full_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha256(token)]);
      if (rows[0]) { req.user = rows[0]; req.sessionHash = sha256(token); }
    }
    next();
  };
}
export async function destroySession(pool, req) {
  if (req.sessionHash) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]);
}

export function requireUser(req, _res, next) {
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  next();
}
export const requirePerm = (perm) => (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  if (!can(req.user, perm)) throw new HttpError(403, 'You do not have permission to do this.');
  next();
};

/* ---------- simple login throttling (per username + IP) ---------- */
const attempts = new Map();
export function checkThrottle(key) {
  const now = Date.now(), a = attempts.get(key);
  if (a && a.until > now) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in a few minutes.');
}
export function recordFailure(key) {
  const now = Date.now(), a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1; if (a.n >= 5) { a.until = now + 5 * 60e3; a.n = 0; }
  attempts.set(key, a);
}
export const clearFailures = (key) => attempts.delete(key);

/* ---------- audit trail ---------- */
export async function audit(db, user, action, entity, entityId, details = {}) {
  await db.query('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [user?.id ?? null, action, entity ?? null, entityId == null ? null : String(entityId), details]);
}
