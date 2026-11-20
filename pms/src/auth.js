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
  manager: ['guests.manage', 'marketing.manage', 'messages.use', 'messages.manage', 'assistant.use', 'housekeeping.supervise', 'reports.schedule', 'group.view', 'reservations.view', 'reservations.manage', 'frontdesk.checkin', 'frontdesk.checkout', 'folio.post', 'folio.void', 'payments.post',
    'housekeeping.update', 'audit.run', 'accounts.view', 'reports.view', 'settings.manage', 'auditlog.view', 'pos.use', 'pos.void', 'pos.manage', 'pos.kitchen',
    'inventory.view', 'inventory.manage', 'inventory.receive', 'purchase.approve', 'requisition.create', 'requisition.approve', 'requisition.issue', 'stock.count', 'distribution.manage', 'finance.view', 'hr.view', 'hr.manage', 'hr.approve', 'roster.manage', 'attendance.record', 'staff.self',
    'amenities.sell', 'amenities.manage', 'events.view', 'events.manage', 'assets.manage', 'maintenance.report', 'maintenance.work'],
  front_office: ['guests.manage', 'messages.use', 'assistant.use', 'reservations.view', 'reservations.manage', 'frontdesk.checkin', 'frontdesk.checkout', 'folio.post', 'payments.post', 'housekeeping.update', 'reports.view', 'pos.use', 'requisition.create', 'staff.self', 'amenities.sell', 'events.view', 'events.manage', 'maintenance.report'],
  night_auditor: ['messages.use', 'assistant.use', 'reservations.view', 'reservations.manage', 'frontdesk.checkin', 'frontdesk.checkout', 'folio.post', 'payments.post', 'audit.run', 'reports.view', 'accounts.view', 'pos.use', 'staff.self', 'amenities.sell', 'events.view', 'maintenance.report'],
  housekeeping: ['reservations.view', 'housekeeping.update', 'requisition.create', 'staff.self', 'maintenance.report'],
  accountant: ['assistant.use', 'group.view', 'reservations.view', 'folio.void', 'accounts.view', 'reports.view', 'auditlog.view', 'inventory.view', 'stock.count', 'finance.view', 'finance.manage', 'accounts.journal', 'hr.view', 'payroll.manage', 'staff.self', 'events.view', 'assets.manage', 'maintenance.report'],
  waiter: ['pos.use', 'staff.self', 'maintenance.report'],
  kitchen: ['pos.kitchen', 'inventory.view', 'requisition.create', 'staff.self', 'events.view', 'maintenance.report'],
  storekeeper: ['assistant.use', 'inventory.view', 'inventory.manage', 'inventory.receive', 'requisition.create', 'requisition.issue', 'stock.count', 'staff.self', 'maintenance.report'],
  hr_officer: ['assistant.use', 'hr.view', 'hr.manage', 'roster.manage', 'attendance.record', 'payroll.manage', 'staff.self', 'maintenance.report'],
  maintenance: ['maintenance.report', 'maintenance.work', 'inventory.view', 'requisition.create', 'staff.self'],
};

/* department heads and senior roles (Phase 17) */
const FO = PERMISSIONS.front_office;
Object.assign(PERMISSIONS, {
  general_manager: ['*'],
  fo_supervisor: [...new Set([...FO, 'folio.void', 'audit.run', 'messages.manage', 'marketing.manage', 'reports.schedule', 'accounts.view', 'distribution.manage', 'housekeeping.supervise'])],
  hk_supervisor: ['reservations.view', 'housekeeping.update', 'housekeeping.supervise', 'maintenance.report', 'requisition.create', 'inventory.view', 'staff.self', 'roster.manage', 'attendance.record', 'reports.view', 'assistant.use'],
  fnb_manager: ['pos.use', 'pos.void', 'pos.manage', 'pos.kitchen', 'inventory.view', 'requisition.create', 'requisition.approve', 'stock.count', 'events.view', 'events.manage', 'amenities.sell', 'amenities.manage', 'reports.view', 'staff.self', 'maintenance.report', 'roster.manage', 'attendance.record', 'assistant.use'],
  stores_manager: [...new Set([...PERMISSIONS.storekeeper, 'purchase.approve', 'requisition.approve', 'reports.view', 'finance.view', 'assistant.use'])],
  sales_marketing: ['reservations.view', 'reservations.manage', 'guests.manage', 'marketing.manage', 'messages.use', 'messages.manage', 'events.view', 'events.manage', 'distribution.manage', 'reports.view', 'assistant.use', 'staff.self', 'maintenance.report'],
});
export const ALL_PERMISSIONS = [...new Set(Object.values(PERMISSIONS).flat().filter((p) => p !== '*')), 'users.manage'];
PERMISSIONS.finance_manager = ALL_PERMISSIONS.filter((p) => p !== 'users.manage');

/** Built-in roles: name, what they are for, department, order on the Users page. Their rights can be edited on the Users page. */
export const ROLE_INFO = {
  admin: ['Administrator', 'Everything, including staff accounts and access rights. Cannot be changed.', 'Management', 1],
  general_manager: ['General manager', 'Everything in every department, including staff accounts.', 'Management', 2],
  finance_manager: ['Finance manager', 'Everything except staff accounts: all money, reports and every department.', 'Finance', 3],
  manager: ['Duty manager', 'Runs all departments day to day: voids, night audit, settings, approvals.', 'Management', 4],
  fo_supervisor: ['Front office supervisor', 'Front desk plus voids, night audit, WhatsApp and marketing set-up, channels.', 'Front office', 10],
  front_office: ['Receptionist', 'Bookings, check-in and out, charges, payments, WhatsApp.', 'Front office', 11],
  night_auditor: ['Night auditor', 'Front desk plus the night audit and the accounts view.', 'Front office', 12],
  sales_marketing: ['Sales & marketing', 'Bookings, guest profiles, campaigns, WhatsApp, events and channels.', 'Sales & marketing', 15],
  hk_supervisor: ['Housekeeping supervisor', 'Room status, shares out and inspects rooms, rosters, faults.', 'Housekeeping', 20],
  housekeeping: ['Room attendant', 'Their own rooms to clean, room status, faults.', 'Housekeeping', 21],
  fnb_manager: ['F&B manager', 'Restaurant and bar: POS, menus, voids, stock requests, events.', 'Food & beverage', 30],
  waiter: ['Waiter / cashier', 'Point of sale only.', 'Food & beverage', 31],
  kitchen: ['Kitchen / bar', 'Kitchen and bar ticket screen, stock requests.', 'Food & beverage', 32],
  stores_manager: ['Stores & procurement manager', 'Stock, purchase orders and their approval, requisitions.', 'Stores', 40],
  storekeeper: ['Storekeeper', 'Stock, deliveries, issuing requisitions, counts.', 'Stores', 41],
  accountant: ['Accountant', 'Accounts, reports, voids, journals, payroll and the audit log.', 'Finance', 50],
  hr_officer: ['HR officer', 'Staff records, rosters, attendance, leave and payroll.', 'HR', 60],
  maintenance: ['Maintenance technician', 'Repair jobs and assets.', 'Maintenance', 70],
};
/** What each right allows, grouped by module, for the access screens. */
export const PERM_INFO = {
  'reservations.view': ['Front office', 'See bookings, room board and availability'], 'reservations.manage': ['Front office', 'Create, change and cancel bookings'],
  'frontdesk.checkin': ['Front office', 'Check guests in, registration cards, room moves'], 'frontdesk.checkout': ['Front office', 'Check guests out'],
  'folio.post': ['Front office', 'Post charges to guest bills'], 'folio.void': ['Front office', 'Void charges and payments'], 'payments.post': ['Front office', 'Take payments'],
  'audit.run': ['Front office', 'Run the night audit'], 'guests.manage': ['Guests & marketing', 'Edit guest profiles and consent'], 'marketing.manage': ['Guests & marketing', 'Campaigns and automatic emails'],
  'messages.use': ['Guests & marketing', 'WhatsApp inbox and phone book'], 'messages.manage': ['Guests & marketing', 'WhatsApp set-up, templates and automations'],
  'assistant.use': ['Management', 'Assistant and to-do lists'], 'housekeeping.update': ['Housekeeping', 'Room status, own rooms to clean, block faulty rooms'], 'housekeeping.supervise': ['Housekeeping', 'Share out rooms, inspect, send back'],
  'distribution.manage': ['Distribution', 'Rate plans, channels (OTAs)'], 'settings.manage': ['Management', 'Property settings, rooms, booking engine'], 'auditlog.view': ['Management', 'Audit log'],
  'reports.view': ['Reports', 'Reports and dashboards'], 'reports.schedule': ['Reports', 'Schedule department reports by email'], 'group.view': ['Reports', 'Group dashboard'],
  'accounts.view': ['Finance', 'Trial balance and journal'], 'accounts.journal': ['Finance', 'Manual journals and chart of accounts'], 'finance.view': ['Finance', 'Companies, suppliers, expenses, statements'], 'finance.manage': ['Finance', 'Invoices, bills, payments, bank, close the books'],
  'pos.use': ['Food & beverage', 'Point of sale'], 'pos.void': ['Food & beverage', 'Void items sent to the kitchen'], 'pos.manage': ['Food & beverage', 'Menus, tables, outlets'], 'pos.kitchen': ['Food & beverage', 'Kitchen and bar screen'],
  'inventory.view': ['Stores', 'See stock'], 'inventory.manage': ['Stores', 'Items, recipes, suppliers, stores'], 'inventory.receive': ['Stores', 'Purchase orders and deliveries'], 'purchase.approve': ['Stores', 'Approve purchase orders'],
  'requisition.create': ['Stores', 'Request stock'], 'requisition.approve': ['Stores', 'Approve requisitions'], 'requisition.issue': ['Stores', 'Issue requisitions'], 'stock.count': ['Stores', 'Stock counts and write-offs'],
  'hr.view': ['HR', 'See staff records'], 'hr.manage': ['HR', 'Edit staff records'], 'hr.approve': ['HR', 'Approve leave'], 'roster.manage': ['HR', 'Rosters'], 'attendance.record': ['HR', 'Attendance'], 'payroll.manage': ['HR', 'Payroll'], 'staff.self': ['HR', 'Own payslips and leave'],
  'amenities.sell': ['Operations', 'Book amenities and services'], 'amenities.manage': ['Operations', 'Set up amenities'], 'events.view': ['Operations', 'See events'], 'events.manage': ['Operations', 'Book and bill events'],
  'assets.manage': ['Operations', 'Assets and depreciation'], 'maintenance.report': ['Operations', 'Report faults'], 'maintenance.work': ['Operations', 'Work on repair jobs, block rooms'],
  'users.manage': ['Management', 'Staff accounts and access rights'],
};
export const ROLES = Object.keys(PERMISSIONS);

/** Put the built-in roles in the database. Rights edited on the Users page are kept; new built-in roles get their defaults. */
export async function syncRoles(pool) {
  for (const [key, perms] of Object.entries(PERMISSIONS)) {
    const [name, description, department, sort] = ROLE_INFO[key] || [key, null, null, 100];
    // rights added to a built-in role in a later version reach existing hotels; rights a hotel removed stay removed
    await pool.query(`INSERT INTO roles (key, name, description, department, perms, defaults, builtin, sort) VALUES ($1,$2,$3,$4,$5,$5,TRUE,$6)
      ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, department=EXCLUDED.department, sort=EXCLUDED.sort, builtin=TRUE,
        perms = CASE WHEN roles.key='admin' OR roles.perms='{}' THEN EXCLUDED.perms
                     ELSE ARRAY(SELECT DISTINCT unnest(roles.perms || ARRAY(SELECT unnest(EXCLUDED.perms) EXCEPT SELECT unnest(roles.defaults)))) END,
        defaults = EXCLUDED.perms`, [key, name, description, department, perms, sort]);
  }
}
/** A signed-in user's rights come from their role (as stored) plus their own additions and removals. */
export const can = (user, perm) => {
  if (!user) return false;
  const perms = user.perms || PERMISSIONS[user.role] || [];
  if (user.denied?.includes(perm)) return false;
  return perms.includes('*') || perms.includes(perm);
};
/** Everything, like the administrator (general manager): used where only the top can override a rule. */
export const hasAll = (user) => !!user && (user.perms || PERMISSIONS[user.role] || []).includes('*');

/* ---------- sessions ---------- */
const COOKIE = 'azeli_session';
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
        `SELECT u.id, u.username, u.full_name, u.role, (u.totp_secret IS NOT NULL) AS mfa_enabled,
                COALESCE(u.role = ANY(st.mfa_required_roles), FALSE) AS mfa_required,
                ARRAY(SELECT DISTINCT unnest(COALESCE(ro.perms, '{}') || ARRAY(SELECT perm FROM user_permissions up WHERE up.user_id=u.id AND up.allow))) AS perms,
                ARRAY(SELECT perm FROM user_permissions up WHERE up.user_id=u.id AND NOT up.allow) AS denied
         FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN settings st ON st.id = 1 LEFT JOIN roles ro ON ro.key = u.role
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha256(token)]);
      if (rows[0]) { const u = rows[0]; u.perms = u.perms.filter((p) => !u.denied.includes(p)); req.user = u; req.sessionHash = sha256(token); }
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
