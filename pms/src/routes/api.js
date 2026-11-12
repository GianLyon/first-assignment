import express from 'express';
import { generateDue } from '../services/reports.js';
import { queueGuestEmails } from '../services/crm.js';
import { dashboardAnalytics } from '../services/analytics.js';
import * as demo from '../services/demo.js';
import { tx } from '../db.js';
import {
  HttpError, requireUser, requirePerm, can, ROLES, PERMISSIONS, ALL_PERMISSIONS, hashPassword, verifyPassword, createSession, sessionCookie, clearCookie,
  destroySession, checkThrottle, recordFailure, clearFailures, audit,
} from '../auth.js';
import * as fo from '../services/frontoffice.js';
import { PAYMENT_METHODS, DEPARTMENTS } from '../ledger.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function apiRouter(pool) {
  const r = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req, key = 'id') => { const n = Number(req.params[key]); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };

  /* ---------- auth ---------- */
  r.post('/auth/login', async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const key = `${username}|${req.ip}`;
    checkThrottle(key);
    const { rows: [u] } = await pool.query('SELECT * FROM users WHERE username = $1 AND active', [username]);
    if (!u || !(await verifyPassword(req.body?.password || '', u.password_hash))) {
      recordFailure(key);
      await audit(pool, null, 'auth.login_failed', 'user', null, { username });
      throw new HttpError(401, 'Wrong username or password.');
    }
    clearFailures(key);
    const { token, expires } = await createSession(pool, u.id);
    await audit(pool, u, 'auth.login', 'user', u.id);
    res.setHeader('Set-Cookie', sessionCookie(token, expires));
    res.json({ user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role } });
  });
  r.post('/auth/logout', async (req, res) => { await destroySession(pool, req); res.setHeader('Set-Cookie', clearCookie()); res.json({ ok: true }); });
  r.get('/auth/me', requireUser, async (req, res) => {
    const { group_token_hash, ...s } = await fo.getSettings(pool);
    res.json({ user: req.user, permissions: PERMISSIONS[req.user.role], settings: s });
  });
  r.post('/auth/change-password', requireUser, async (req, res) => {
    const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await verifyPassword(req.body?.current_password || '', u.password_hash))) throw new HttpError(400, 'Current password is wrong.');
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await hashPassword(req.body?.new_password)]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2', [req.user.id, req.sessionHash]);
    await audit(pool, req.user, 'auth.password_changed', 'user', req.user.id);
    res.json({ ok: true });
  });

  r.use(requireUser);

  /* ---------- settings, room types, rooms ---------- */
  r.get('/settings', async (_req, res) => { const { group_token_hash, ...st } = await fo.getSettings(pool); res.json(st); });
  // letterhead on printed invoices and reports
  r.put('/settings/letterhead', requirePerm('settings.manage'), inTx(async (db, req) => {
    const b = req.body || {};
    const t = (v, label, max) => { const x = String(v ?? '').trim(); if (x.length > max) throw new HttpError(400, `${label} is too long.`); return x || null; };
    const logo = b.logo === undefined ? undefined : (b.logo || null);
    if (logo && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) || logo.length > 400000)) throw new HttpError(400, 'The logo must be a PNG, JPG or WebP image under about 280 KB.');
    const email = t(b.contact_email, 'Email', 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new HttpError(400, 'That email address is not valid.');
    await db.query(`UPDATE settings SET legal_name=$1, address=$2, contact_phone=$3, contact_email=$4, website=$5, tin=$6, invoice_footer=$7${logo === undefined ? '' : ', logo=$8'} WHERE id=1`,
      [t(b.legal_name, 'Registered name', 150), t(b.address, 'Address', 300), t(b.contact_phone, 'Phone', 60), email, t(b.website, 'Website', 120), t(b.tin, 'TIN', 30), t(b.invoice_footer, 'Invoice note', 600), ...(logo === undefined ? [] : [logo])]);
    await audit(db, req.user, 'settings.letterhead', 'settings', 1, { logo: logo === undefined ? 'unchanged' : logo ? 'set' : 'removed' });
    return { ok: true };
  }));
  // sample data for trying the system (administrator only)
  r.get('/demo', requirePerm('users.manage'), async (_req, res) => res.json({ ...demo.demoStatus(), demo_data: (await fo.getSettings(pool)).demo_data }));
  r.post('/demo', requirePerm('users.manage'), async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.body?.days) || 45));
    if (demo.demoStatus().running) throw new HttpError(409, 'Sample data is already being created.');
    await demo.assertEmpty(pool); // refuse at once on a system already in use
    const started = demo.generateDemoData(pool, req.user, { days });
    started.catch(() => {}); // progress and errors are reported by GET /demo
    await new Promise((resolve) => setTimeout(resolve, 300));
    const st = demo.demoStatus();
    if (st.error) throw new HttpError(409, st.error);
    res.json(st);
  });
  r.post('/demo/remove', requirePerm('users.manage'), inTx((_db, req) => demo.removeDemoData(pool, req.user, req.body || {})));
  r.get('/analytics', requirePerm('reports.view'), async (req, res) => res.json(await dashboardAnalytics(pool, { from: req.query.from, to: req.query.to })));
  r.put('/settings', requirePerm('settings.manage'), inTx(async (db, req) => {
    const b = req.body || {};
    const name = String(b.property_name || '').trim(); const vat = Number(b.vat_rate);
    if (!name) throw new HttpError(400, 'Property name is required.');
    if (!(vat >= 0 && vat < 100)) throw new HttpError(400, 'VAT rate must be between 0 and 100.');
    const { rows: [s] } = await db.query('UPDATE settings SET property_name=$1, vat_rate=$2 WHERE id=1 RETURNING *', [name, vat]);
    await audit(db, req.user, 'settings.update', 'settings', 1, { property_name: name, vat_rate: vat });
    return s;
  }));

  r.get('/room-types', async (_req, res) => res.json((await pool.query('SELECT * FROM room_types ORDER BY id')).rows));
  r.post('/room-types', requirePerm('settings.manage'), inTx(async (db, req) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase(), name = String(b.name || '').trim(), rate = Number(b.base_rate);
    if (!code || !name || !Number.isInteger(rate) || rate < 0) throw new HttpError(400, 'Code, name and a whole-shilling rate are required.');
    const { rows: [t] } = await db.query('INSERT INTO room_types (code, name, base_rate, max_occupancy) VALUES ($1,$2,$3,$4) RETURNING *', [code, name, rate, Math.max(1, Number(b.max_occupancy) || 2)]);
    await audit(db, req.user, 'room_type.create', 'room_type', t.id, t);
    return t;
  }));
  r.put('/room-types/:id', requirePerm('settings.manage'), inTx(async (db, req) => {
    const b = req.body || {}; const rate = Number(b.base_rate);
    if (!String(b.name || '').trim() || !Number.isInteger(rate) || rate < 0) throw new HttpError(400, 'Name and a whole-shilling rate are required.');
    const { rows: [t] } = await db.query('UPDATE room_types SET name=$2, base_rate=$3, max_occupancy=$4, active=$5 WHERE id=$1 RETURNING *',
      [id(req), String(b.name).trim(), rate, Math.max(1, Number(b.max_occupancy) || 2), b.active !== false]);
    if (!t) throw new HttpError(404, 'Room type not found.');
    await audit(db, req.user, 'room_type.update', 'room_type', t.id, t);
    return t;
  }));

  r.get('/rooms', async (_req, res) => res.json((await pool.query('SELECT r.*, t.code AS type_code, t.name AS type_name FROM rooms r JOIN room_types t ON t.id=r.room_type_id ORDER BY r.number')).rows));
  r.post('/rooms', requirePerm('settings.manage'), inTx(async (db, req) => {
    const b = req.body || {}; const number = String(b.number || '').trim();
    if (!number) throw new HttpError(400, 'Room number is required.');
    const { rows: [room] } = await db.query('INSERT INTO rooms (number, room_type_id, floor) VALUES ($1,$2,$3) RETURNING *', [number, Number(b.room_type_id), String(b.floor || '').trim() || null]);
    await audit(db, req.user, 'room.create', 'room', room.id, room);
    return room;
  }));
  r.put('/rooms/:id', requirePerm('settings.manage'), inTx(async (db, req) => {
    const b = req.body || {};
    const { rows: [room] } = await db.query('UPDATE rooms SET room_type_id=$2, floor=$3, active=$4, notes=$5 WHERE id=$1 RETURNING *',
      [id(req), Number(b.room_type_id), String(b.floor || '').trim() || null, b.active !== false, String(b.notes || '').trim() || null]);
    if (!room) throw new HttpError(404, 'Room not found.');
    await audit(db, req.user, 'room.update', 'room', room.id, room);
    return room;
  }));
  r.patch('/rooms/:id/housekeeping', requirePerm('housekeeping.update'), inTx(async (db, req) => { await fo.setHousekeeping(db, req.user, id(req), req.body?.hk_status); return { ok: true }; }));

  r.get('/room-board', requirePerm('reservations.view'), async (_req, res) => {
    const s = await fo.getSettings(pool);
    const { rows } = await pool.query(
      `SELECT rm.id, rm.number, rm.floor, rm.hk_status, rm.active, t.code AS type_code, t.name AS type_name,
              r.id AS reservation_id, r.code, r.departure, g.first_name, g.last_name
       FROM rooms rm JOIN room_types t ON t.id = rm.room_type_id
       LEFT JOIN reservations r ON r.room_id = rm.id AND r.status = 'in_house' LEFT JOIN guests g ON g.id = r.guest_id
       WHERE rm.active ORDER BY rm.floor NULLS LAST, rm.number`);
    res.json({ business_date: s.business_date, rooms: rows });
  });

  r.get('/availability', requirePerm('reservations.view'), async (req, res) => {
    const s = await fo.getSettings(pool);
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : s.business_date;
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 14));
    res.json(await fo.availabilityGrid(pool, from, days));
  });

  /* ---------- guests & reservations ---------- */
  r.get('/guests', requirePerm('reservations.view'), async (req, res) => {
    const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
    res.json((await pool.query(`SELECT * FROM guests WHERE lower(first_name || ' ' || last_name) LIKE $1 OR lower(coalesce(phone,'')) LIKE $1 OR lower(coalesce(email,'')) LIKE $1 ORDER BY last_name, first_name LIMIT 25`, [q])).rows);
  });

  r.get('/reservations', requirePerm('reservations.view'), async (req, res) => {
    const s = await fo.getSettings(pool);
    const view = String(req.query.view || 'active'), q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
    const where = {
      active: "r.status IN ('reserved','in_house')", arrivals: "r.status='reserved' AND r.arrival <= $1", inhouse: "r.status='in_house'",
      departures: "r.status='in_house' AND r.departure <= $1", upcoming: "r.status='reserved' AND r.arrival > $1",
      past: "r.status IN ('checked_out','cancelled','no_show')",
    }[view];
    if (!where) throw new HttpError(400, 'Unknown view.');
    const { rows } = await pool.query(
      `SELECT r.id, r.code, r.status, r.arrival, r.departure, r.rate, r.source, r.adults, r.company_name, g.first_name, g.last_name, g.phone,
              t.name AS room_type_name, rm.number AS room_number,
              COALESCE((SELECT SUM(amount) FROM folio_charges c WHERE c.reservation_id=r.id AND NOT voided),0)
              - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.reservation_id=r.id AND NOT voided),0) AS balance
       FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types t ON t.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id
       WHERE ${where} AND ($1::date IS NOT NULL) AND (lower(g.first_name || ' ' || g.last_name || ' ' || r.code || ' ' || coalesce(g.phone,'')) LIKE $2)
       ORDER BY ${view === 'past' ? 'r.departure DESC' : 'r.arrival, rm.number NULLS LAST'} LIMIT 200`, [s.business_date, q]);
    res.json(rows.map((x) => ({ ...x, balance: Number(x.balance) })));
  });
  r.post('/reservations', requirePerm('reservations.manage'), inTx((db, req) => fo.createReservation(db, req.user, req.body || {})));
  r.get('/reservations/:id', requirePerm('reservations.view'), async (req, res) => res.json(await fo.folio(pool, id(req))));
  r.put('/reservations/:id', requirePerm('reservations.manage'), inTx((db, req) => fo.updateReservation(db, req.user, id(req), req.body || {})));
  r.post('/reservations/:id/cancel', requirePerm('reservations.manage'), inTx(async (db, req) => { await fo.cancelReservation(db, req.user, id(req), req.body?.reason); return { ok: true }; }));
  r.post('/reservations/:id/check-in', requirePerm('frontdesk.checkin'), inTx((db, req) => fo.checkIn(db, req.user, id(req), req.body || {})));
  r.put('/reservations/:id/registration', requirePerm('frontdesk.checkin'), inTx((db, req) => fo.updateRegistration(db, req.user, id(req), req.body || {})));
  r.post('/reservations/:id/move', requirePerm('frontdesk.checkin'), inTx((db, req) => fo.moveRoom(db, req.user, id(req), req.body || {})));
  r.post('/reservations/:id/check-out', requirePerm('frontdesk.checkout'), inTx((db, req) => fo.checkOut(db, req.user, id(req))));
  r.post('/reservations/:id/charges', requirePerm('folio.post'), inTx((db, req) => fo.postCharge(db, req.user, id(req), req.body || {})));
  r.post('/reservations/:id/payments', requirePerm('payments.post'), inTx((db, req) => fo.postPayment(db, req.user, id(req), req.body || {})));
  r.post('/charges/:id/void', requirePerm('folio.void'), inTx(async (db, req) => { await fo.voidCharge(db, req.user, id(req), req.body?.reason); return { ok: true }; }));
  r.post('/payments/:id/void', requirePerm('folio.void'), inTx(async (db, req) => { await fo.voidPayment(db, req.user, id(req), req.body?.reason); return { ok: true }; }));

  /* ---------- dashboard & night audit ---------- */
  r.get('/dashboard', requirePerm('reservations.view'), async (_req, res) => {
    const s = await fo.getSettings(pool);
    const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
    const rooms = await one(`SELECT count(*) FILTER (WHERE active AND hk_status<>'out_of_order')::int AS sellable, count(*) FILTER (WHERE hk_status='dirty' AND active)::int AS dirty, count(*) FILTER (WHERE hk_status='out_of_order' AND active)::int AS ooo FROM rooms`);
    const inHouse = await one("SELECT count(*)::int AS n FROM reservations WHERE status='in_house'");
    const arrivals = (await pool.query(`SELECT r.id, r.code, g.first_name, g.last_name, t.name AS room_type_name, r.source FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types t ON t.id=r.room_type_id WHERE r.status='reserved' AND r.arrival <= $1 ORDER BY g.last_name`, [s.business_date])).rows;
    const departures = (await pool.query(`SELECT r.id, r.code, g.first_name, g.last_name, rm.number AS room_number,
        COALESCE((SELECT SUM(amount) FROM folio_charges c WHERE c.reservation_id=r.id AND NOT voided),0) - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.reservation_id=r.id AND NOT voided),0) AS balance
        FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.status='in_house' AND r.departure <= $1 ORDER BY rm.number`, [s.business_date])).rows;
    const last = await one('SELECT * FROM night_audits ORDER BY business_date DESC LIMIT 1');
    const overbooked = (await pool.query(`SELECT r.id, r.code, r.arrival, r.departure, g.first_name, g.last_name, t.name AS room_type_name, r.source FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types t ON t.id=r.room_type_id WHERE r.overbooked AND r.status='reserved' ORDER BY r.arrival`)).rows;
    res.json({ business_date: s.business_date, property_name: s.property_name, rooms, in_house: inHouse.n, arrivals, departures: departures.map((d) => ({ ...d, balance: Number(d.balance) })), last_audit: last || null, overbooked });
  });
  r.get('/night-audit', requirePerm('audit.run'), async (_req, res) => {
    res.json({ preview: await fo.nightAuditPreview(pool), history: (await pool.query('SELECT a.*, u.full_name AS run_by_name FROM night_audits a LEFT JOIN users u ON u.id=a.run_by ORDER BY business_date DESC LIMIT 30')).rows });
  });
  r.post('/night-audit', requirePerm('audit.run'), async (req, res) => {
    const result = await tx(pool, (db) => fo.runNightAudit(db, req.user));
    // the day is closed: produce the scheduled reports for it (a failure here never undoes the audit)
    try { result.reports_queued = (await tx(pool, (db) => generateDue(db))).created; } catch (e) { console.error('Scheduled reports failed:', e.message); result.reports_queued = 0; }
    try { result.guest_emails_queued = (await tx(pool, (db) => queueGuestEmails(db))).queued; } catch (e) { console.error('Guest emails failed:', e.message); result.guest_emails_queued = 0; }
    res.json(result);
  });

  /* ---------- accounting & reports ---------- */
  r.get('/accounts/trial-balance', requirePerm('accounts.view'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
       FROM accounts a LEFT JOIN journal_lines l ON l.account_code = a.code GROUP BY a.code ORDER BY a.code`);
    const lines = rows.map((x) => { const net = Number(x.debit) - Number(x.credit); return { code: x.code, name: x.name, type: x.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }; });
    res.json({ lines, total_debit: lines.reduce((a, l) => a + l.debit, 0), total_credit: lines.reduce((a, l) => a + l.credit, 0) });
  });
  r.get('/accounts/journal', requirePerm('accounts.view'), async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const { rows } = await pool.query(
      `SELECT e.id, e.business_date, e.description, e.ref_type, e.ref_id, e.created_at, u.full_name AS created_by_name,
              json_agg(json_build_object('account', l.account_code, 'name', a.name, 'debit', l.debit, 'credit', l.credit) ORDER BY l.id) AS lines
       FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id JOIN accounts a ON a.code=l.account_code LEFT JOIN users u ON u.id=e.created_by
       GROUP BY e.id, u.full_name ORDER BY e.id DESC LIMIT $1`, [limit]);
    res.json(rows);
  });
  r.get('/reports/daily', requirePerm('reports.view'), async (req, res) => {
    const s = await fo.getSettings(pool);
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : (await pool.query("SELECT to_char($1::date - 1, 'YYYY-MM-DD') AS d", [s.business_date])).rows[0].d;
    const q = async (sql) => (await pool.query(sql, [date])).rows;
    const byDept = await q('SELECT department, SUM(amount)::bigint AS amount, count(*)::int AS n FROM folio_charges WHERE business_date=$1 AND NOT voided GROUP BY department');
    const pays = await q(`SELECT method, SUM(amount)::bigint AS amount FROM (
        SELECT method, amount FROM payments WHERE business_date=$1 AND NOT voided
        UNION ALL SELECT method, amount FROM pos_payments WHERE business_date=$1 AND method <> 'room') x GROUP BY method`);
    // Restaurant/bar sales paid on the spot (sales charged to rooms are already in folio charges)
    const posDirect = Number((await q("SELECT COALESCE(SUM(amount),0) AS a FROM pos_payments WHERE business_date=$1 AND method <> 'room'"))[0].a);
    const fnbIdx = byDept.findIndex((d) => d.department === 'fnb');
    if (fnbIdx >= 0) byDept[fnbIdx].amount = Number(byDept[fnbIdx].amount) + posDirect; else if (posDirect) byDept.push({ department: 'fnb', amount: posDirect, n: 0 });
    const audit = (await q('SELECT * FROM night_audits WHERE business_date=$1'))[0] || null;
    const sellable = (await pool.query("SELECT count(*)::int AS n FROM rooms WHERE active AND hk_status <> 'out_of_order'")).rows[0].n;
    const occupied = audit ? audit.room_charges_posted : (byDept.find((d) => d.department === 'rooms')?.n || 0);
    const roomRev = Number(byDept.find((d) => d.department === 'rooms')?.amount || 0);
    const vatRate = Number(s.vat_rate);
    const total = byDept.reduce((a, d) => a + Number(d.amount), 0);
    res.json({
      date, audited: !!audit, sellable_rooms: sellable, occupied_rooms: occupied, occupancy: sellable ? occupied / sellable : 0,
      adr: occupied ? Math.round(roomRev / occupied) : 0, revpar: sellable ? Math.round(roomRev / sellable) : 0,
      revenue: Object.fromEntries(DEPARTMENTS.map((d) => [d, Number(byDept.find((x) => x.department === d)?.amount || 0)])), revenue_total: total,
      vat_included: Math.round((total * vatRate) / (100 + vatRate)),
      payments: Object.fromEntries(PAYMENT_METHODS.map((m) => [m, Number(pays.find((x) => x.method === m)?.amount || 0)])),
    });
  });

  /* ---------- users & audit log ---------- */
  r.get('/users', requirePerm('users.manage'), async (_req, res) => res.json((await pool.query('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id')).rows));
  r.post('/users', requirePerm('users.manage'), inTx(async (db, req) => {
    const b = req.body || {}; const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username: 3–40 lowercase letters, numbers, dots, dashes or underscores.');
    if (!ROLES.includes(b.role)) throw new HttpError(400, 'Choose a role.');
    if (!String(b.full_name || '').trim()) throw new HttpError(400, 'Full name is required.');
    const exists = await db.query('SELECT 1 FROM users WHERE username=$1', [username]);
    if (exists.rows[0]) throw new HttpError(409, 'That username is taken.');
    const { rows: [u] } = await db.query('INSERT INTO users (username, full_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, username, full_name, role, active',
      [username, String(b.full_name).trim(), await hashPassword(b.password), b.role]);
    await audit(db, req.user, 'user.create', 'user', u.id, { username, role: b.role });
    return u;
  }));
  r.put('/users/:id', requirePerm('users.manage'), inTx(async (db, req) => {
    const b = req.body || {}; const uid = id(req);
    if (b.role !== undefined && !ROLES.includes(b.role)) throw new HttpError(400, 'Choose a role.');
    if (uid === req.user.id && (b.active === false || (b.role && b.role !== req.user.role))) throw new HttpError(400, 'You cannot disable or change the role of your own account.');
    const { rows: [u] } = await db.query('UPDATE users SET full_name=COALESCE($2, full_name), role=COALESCE($3, role), active=COALESCE($4, active) WHERE id=$1 RETURNING id, username, full_name, role, active',
      [uid, b.full_name ? String(b.full_name).trim() : null, b.role || null, typeof b.active === 'boolean' ? b.active : null]);
    if (!u) throw new HttpError(404, 'User not found.');
    if (b.password) { await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [uid, await hashPassword(b.password)]); await db.query('DELETE FROM sessions WHERE user_id=$1', [uid]); }
    if (b.active === false) await db.query('DELETE FROM sessions WHERE user_id=$1', [uid]);
    await audit(db, req.user, 'user.update', 'user', uid, { role: b.role, active: b.active, password_reset: !!b.password });
    return u;
  }));
  r.get('/audit-log', requirePerm('auditlog.view'), async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json((await pool.query('SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT $1', [limit])).rows);
  });
  r.get('/meta', (_req, res) => res.json({ roles: ROLES, payment_methods: PAYMENT_METHODS, departments: DEPARTMENTS, can: Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, can(_req.user, p)])) }));

  return r;
}
