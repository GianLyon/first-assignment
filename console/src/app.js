// Azeli Console HTTP app: public endpoints for the website, and the team's admin API.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { tx } from './db.js';
import * as A from './auth.js';
import { DEFAULTS, SECTIONS, validate } from './content.js';
import { checkClient, validUrl } from './clients.js';
import { notifyLead } from './mailer.js';

const { HttpError, audit, can } = A;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
const LEAD_STATUS = ['new', 'contacted', 'proposal', 'won', 'lost'];

export function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.get('/healthz', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'" });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  /* ---------------- public: used by the website ---------------- */
  const pub = express.Router();
  // only the Azeli website may call these from a browser
  pub.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.siteOrigins.includes(origin.replace(/\/+$/, ''))) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  const hits = new Map();
  const limit = (max, windowMs) => (req, _res, next) => {
    const now = Date.now(), key = req.ip, h = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) throw new HttpError(429, 'Too many requests. Please try again later or contact us by phone.');
    h.push(now); hits.set(key, h); next();
  };
  pub.get('/site', limit(120, 60e3), async (_req, res) => {
    const { rows } = await pool.query('SELECT section, published FROM site_content WHERE published IS NOT NULL');
    const out = structuredClone(DEFAULTS);
    for (const r of rows) out[r.section] = r.published;
    res.set('Cache-Control', 'no-store').json(out);
  });
  pub.post('/leads', limit(5, 60 * 60e3), express.json({ limit: '20kb' }), async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot: bots fill in the hidden field; pretend success
    const t = (v, max) => String(v ?? '').trim().slice(0, max);
    const name = t(b.name, 120), email = t(b.email, 160).toLowerCase(), business = t(b.business, 160);
    if (!name || !business || !EMAIL_RE.test(email)) throw new HttpError(400, 'Please fill in your name, a valid email and your business name.');
    const services = (Array.isArray(b.services) ? b.services : [b.services]).map((s) => t(s, 60)).filter(Boolean).slice(0, 15);
    const lead = await tx(pool, async (db) => {
      const { rows: [l] } = await db.query(`INSERT INTO leads (name, email, phone, business, business_type, services, message, package, page) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [name, email, t(b.phone, 40) || null, business, t(b.type, 60) || null, services, t(b.message, 3000) || null, t(b.package, 30) || null, t(b.page, 200) || null]);
      await audit(db, null, 'lead.received', 'lead', l.id, { ref: l.ref });
      return l;
    });
    notifyLead(lead).catch((e) => console.error('Lead email failed:', e.message)); // never delays or fails the visitor
    res.json({ ok: true, ref: lead.ref });
  });
  app.use('/api/public', pub);

  /* ---------------- team API ---------------- */
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !String(req.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'Requests must be sent as JSON.');
    next();
  });
  app.use('/api', express.json({ limit: '200kb' }), A.loadUser(pool));
  const api = express.Router();
  const inTx = (fn) => async (req, res) => res.json(await tx(pool, (db) => fn(db, req, res)));
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.'); return n; };
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

  api.post('/auth/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase(), key = `${email}|${req.ip}`;
    A.checkThrottle(key);
    const [u] = await q('SELECT * FROM users WHERE email=$1 AND active', [email]);
    if (!(await A.checkPassword(String(req.body?.password || ''), u?.password_hash))) {
      A.recordFailure(key); await audit(pool, null, 'auth.failed', 'user', null, { email });
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    A.clearFailures(key);
    res.set('Set-Cookie', await A.createSession(pool, u.id));
    await audit(pool, u, 'auth.login', 'user', u.id);
    res.json({ user: { id: u.id, email: u.email, full_name: u.full_name, role: u.role } });
  });
  api.post('/auth/logout', async (req, res) => { await A.destroySession(pool, req); res.set('Set-Cookie', A.clearCookie()).json({ ok: true }); });
  api.use(A.requireUser);
  api.get('/me', (req, res) => res.json({ user: req.user, can: Object.fromEntries(A.ALL_PERMS.map((p) => [p, can(req.user, p)])), roles: A.ROLES, sections: SECTIONS, deploy_hook: !!config.deployHook }));
  api.post('/me/password', inTx(async (db, req) => {
    const [u] = (await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows;
    if (!(await A.verifyPassword(String(req.body?.current_password || ''), u.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await A.hashPassword(req.body?.new_password)]);
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, req.sessionHash]);
    await audit(db, req.user, 'auth.password_change', 'user', req.user.id);
    return { ok: true };
  }));

  api.get('/dashboard', A.requirePerm('leads.view', 'clients.view', 'content.edit'), async (req, res) => {
    const [l] = await q(`SELECT count(*) FILTER (WHERE status='new')::int AS new, count(*) FILTER (WHERE status IN ('contacted','proposal'))::int AS open,
        count(*) FILTER (WHERE status='won' AND updated_at > now() - interval '30 days')::int AS won30, count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS last30,
        count(*) FILTER (WHERE next_action_date <= CURRENT_DATE AND status IN ('new','contacted','proposal'))::int AS due FROM leads`);
    const [c] = await q(`SELECT count(*) FILTER (WHERE status IN ('active','setup'))::int AS clients, count(*) FILTER (WHERE status='active' AND last_status IS NOT NULL AND last_status<>'online')::int AS offline,
        COALESCE(SUM(monthly_fee_ugx) FILTER (WHERE status='active'),0)::bigint AS mrr FROM clients`);
    const [d] = await q('SELECT count(*)::int AS n FROM site_content WHERE published IS DISTINCT FROM draft');
    res.json({ leads: can(req.user, 'leads.view') ? l : null, clients: can(req.user, 'clients.view') ? c : null, unpublished: d.n,
      recent: can(req.user, 'leads.view') ? await q("SELECT id, ref, name, business, status, created_at FROM leads ORDER BY id DESC LIMIT 6") : [] });
  });

  /* ---- enquiries ---- */
  api.get('/leads', A.requirePerm('leads.view'), async (req, res) => {
    const st = LEAD_STATUS.includes(req.query.status) ? req.query.status : null;
    const s = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    res.json(await q(`SELECT l.*, u.full_name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to
      WHERE ($1::text IS NULL OR l.status=$1) AND ($2='' OR lower(l.name || ' ' || l.business || ' ' || l.email) LIKE '%' || $2 || '%')
      ORDER BY (l.status='new') DESC, l.created_at DESC LIMIT 300`, [st, s]));
  });
  api.get('/leads/:id', A.requirePerm('leads.view'), async (req, res) => {
    const [l] = await q('SELECT l.*, u.full_name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=$1', [id(req)]);
    if (!l) throw new HttpError(404, 'Enquiry not found.');
    res.json({ lead: l, notes: await q('SELECT n.*, u.full_name FROM lead_notes n LEFT JOIN users u ON u.id=n.user_id WHERE lead_id=$1 ORDER BY n.id DESC', [l.id]),
      team: await q("SELECT id, full_name FROM users WHERE active AND role IN ('owner','sales') ORDER BY full_name") });
  });
  api.put('/leads/:id', A.requirePerm('leads.manage'), inTx(async (db, req) => {
    const b = req.body || {};
    if (!LEAD_STATUS.includes(b.status)) throw new HttpError(400, 'Choose a status.');
    if (b.next_action_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.next_action_date)) throw new HttpError(400, 'Follow-up date is not valid.');
    const value = b.value_ugx === '' || b.value_ugx == null ? null : Number(b.value_ugx);
    if (value != null && !(Number.isInteger(value) && value >= 0)) throw new HttpError(400, 'Monthly value must be a whole number of shillings.');
    const { rows: [l] } = await db.query('UPDATE leads SET status=$2, assigned_to=$3, value_ugx=$4, next_action_date=$5, updated_at=now() WHERE id=$1 RETURNING ref, status',
      [id(req), b.status, b.assigned_to ? Number(b.assigned_to) : null, value, b.next_action_date || null]);
    if (!l) throw new HttpError(404, 'Enquiry not found.');
    await audit(db, req.user, 'lead.update', 'lead', id(req), { status: l.status });
    return { ok: true };
  }));
  api.post('/leads/:id/notes', A.requirePerm('leads.manage'), inTx(async (db, req) => {
    const note = String(req.body?.note || '').trim();
    if (!note || note.length > 3000) throw new HttpError(400, 'Write a note (up to 3,000 characters).');
    const { rowCount } = await db.query('INSERT INTO lead_notes (lead_id, user_id, note) SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM leads WHERE id=$1)', [id(req), req.user.id, note]);
    if (!rowCount) throw new HttpError(404, 'Enquiry not found.');
    await db.query('UPDATE leads SET updated_at=now() WHERE id=$1', [id(req)]);
    return { ok: true };
  }));

  /* ---- website content ---- */
  api.get('/content', A.requirePerm('content.edit'), async (_req, res) => {
    const rows = await q("SELECT section, draft, published, updated_at, published_at, u.full_name AS updated_by FROM site_content s LEFT JOIN users u ON u.id=s.updated_by");
    res.json({ sections: Object.fromEntries(Object.keys(SECTIONS).map((k) => {
      const r = rows.find((x) => x.section === k);
      return [k, { draft: r?.draft || DEFAULTS[k], published: r?.published || DEFAULTS[k], changed: !!r && JSON.stringify(r.draft) !== JSON.stringify(r.published ?? DEFAULTS[k]), updated_at: r?.updated_at, updated_by: r?.updated_by, published_at: r?.published_at }];
    })), publishes: await q('SELECT p.*, u.full_name FROM publishes p LEFT JOIN users u ON u.id=p.user_id ORDER BY id DESC LIMIT 10') });
  });
  api.put('/content/:section', A.requirePerm('content.edit'), inTx(async (db, req) => {
    const value = validate(req.params.section, req.body || {});
    await db.query(`INSERT INTO site_content (section, draft, updated_by) VALUES ($1,$2,$3) ON CONFLICT (section) DO UPDATE SET draft=$2, updated_by=$3, updated_at=now()`,
      [req.params.section, value, req.user.id]);
    await audit(db, req.user, 'content.save', 'site_content', req.params.section);
    return { ok: true, value };
  }));
  api.post('/content/publish', A.requirePerm('content.publish'), async (req, res) => {
    const sections = await tx(pool, async (db) => {
      const { rows } = await db.query('UPDATE site_content SET published=draft, published_at=now() WHERE published IS DISTINCT FROM draft RETURNING section');
      return rows.map((r) => r.section);
    });
    let deploy = 'no_hook';
    if (config.deployHook) {
      try { const r = await fetch(config.deployHook, { method: 'POST', signal: AbortSignal.timeout(15000) }); deploy = r.ok ? 'triggered' : `Vercel answered ${r.status}`; } catch (e) { deploy = `Could not reach Vercel: ${e.message}`; }
    }
    await pool.query('INSERT INTO publishes (user_id, sections, deploy) VALUES ($1,$2,$3)', [req.user.id, sections, deploy]);
    await audit(pool, req.user, 'content.publish', 'site_content', null, { sections, deploy });
    res.json({ sections, deploy });
  });

  /* ---- client hotels ---- */
  api.get('/clients', A.requirePerm('clients.view'), async (req, res) => {
    const rows = await q('SELECT * FROM clients ORDER BY status=\'ended\', name');
    res.json(rows.map(({ group_token, ...c }) => ({ ...c, has_key: !!group_token, monthly_fee_ugx: can(req.user, 'clients.manage') || req.user.role === 'sales' ? c.monthly_fee_ugx : null })));
  });
  const saveClient = async (db, req, cid) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'Enter the hotel name.');
    const url = validUrl(b.pms_url);
    const token = String(b.group_token || '').trim();
    if (token && !/^azg_[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'The group access key starts with azg_ (create it on the hotel\'s Group dashboard).');
    const fee = b.monthly_fee_ugx === '' || b.monthly_fee_ugx == null ? null : Number(b.monthly_fee_ugx);
    if (fee != null && !(Number.isInteger(fee) && fee >= 0)) throw new HttpError(400, 'Monthly fee must be a whole number of shillings.');
    const vals = [name, url, String(b.contact_name || '').trim().slice(0, 120) || null, String(b.contact_email || '').trim().slice(0, 160) || null, String(b.contact_phone || '').trim().slice(0, 40) || null,
      ['Essentials', 'Growth', 'Signature', 'PMS only', 'Other'].includes(b.package) ? b.package : null, fee, ['setup', 'active', 'paused', 'ended'].includes(b.status) ? b.status : 'active',
      /^\d{4}-\d{2}-\d{2}$/.test(b.started_on || '') ? b.started_on : null, String(b.notes || '').slice(0, 2000) || null];
    let row;
    if (cid) ({ rows: [row] } = await db.query(`UPDATE clients SET name=$2, pms_url=$3, contact_name=$4, contact_email=$5, contact_phone=$6, package=$7, monthly_fee_ugx=$8, status=$9, started_on=$10, notes=$11,
        group_token=COALESCE(NULLIF($12,''), group_token) WHERE id=$1 RETURNING id`, [cid, ...vals, token]));
    else ({ rows: [row] } = await db.query(`INSERT INTO clients (name, pms_url, contact_name, contact_email, contact_phone, package, monthly_fee_ugx, status, started_on, notes, group_token, lead_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),$12) RETURNING id`, [...vals, token, b.lead_id ? Number(b.lead_id) : null]));
    if (!row) throw new HttpError(404, 'Client not found.');
    await audit(db, req.user, cid ? 'client.update' : 'client.create', 'client', row.id, { name });
    return row;
  };
  api.post('/clients', A.requirePerm('clients.manage'), async (req, res) => { const r = await tx(pool, (db) => saveClient(db, req, null)); await checkClient(pool, r.id); res.json(r); });
  api.put('/clients/:id', A.requirePerm('clients.manage'), async (req, res) => { const r = await tx(pool, (db) => saveClient(db, req, id(req))); await checkClient(pool, r.id); res.json(r); });
  api.post('/clients/:id/check', A.requirePerm('clients.view'), async (req, res) => res.json(await checkClient(pool, id(req))));
  api.post('/clients/check-all', A.requirePerm('clients.view'), async (_req, res) => {
    const rows = await q("SELECT id FROM clients WHERE status IN ('active','setup')");
    await Promise.all(rows.map((r) => checkClient(pool, r.id)));
    res.json({ checked: rows.length });
  });

  /* ---- team ---- */
  const team = A.requirePerm('team.manage');
  api.get('/users', team, async (_req, res) => res.json(await q('SELECT id, email, full_name, role, active, created_at FROM users ORDER BY active DESC, full_name')));
  api.post('/users', team, inTx(async (db, req) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!A.ROLES[b.role]) throw new HttpError(400, 'Choose a role.');
    const name = String(b.full_name || '').trim();
    if (!name) throw new HttpError(400, 'Enter their name.');
    const { rows: [u] } = await db.query('INSERT INTO users (email, full_name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, full_name, role', [email, name.slice(0, 120), b.role, await A.hashPassword(b.password)]);
    await audit(db, req.user, 'user.create', 'user', u.id, { email, role: b.role });
    return u;
  }));
  api.put('/users/:id', team, inTx(async (db, req) => {
    const b = req.body || {}, uid = id(req);
    if (!A.ROLES[b.role]) throw new HttpError(400, 'Choose a role.');
    if (uid === req.user.id && (b.role !== 'owner' || b.active === false)) throw new HttpError(409, 'You cannot remove your own owner access.');
    const { rowCount } = await db.query('UPDATE users SET role=$2, active=$3, full_name=COALESCE(NULLIF($4,\'\'), full_name) WHERE id=$1', [uid, b.role, b.active !== false, String(b.full_name || '').trim().slice(0, 120)]);
    if (!rowCount) throw new HttpError(404, 'User not found.');
    if (b.password) await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [uid, await A.hashPassword(b.password)]);
    if (b.active === false || b.password) await db.query('DELETE FROM sessions WHERE user_id=$1', [uid]);
    const { rows: [o] } = await db.query("SELECT count(*)::int AS n FROM users WHERE role='owner' AND active");
    if (!o.n) throw new HttpError(409, 'At least one active owner is needed.');
    await audit(db, req.user, 'user.update', 'user', uid, { role: b.role, active: b.active !== false });
    return { ok: true };
  }));
  api.get('/audit', team, async (_req, res) => res.json(await q('SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200')));

  app.use('/api', api);
  app.use('/api', () => { throw new HttpError(404, 'Not found.'); });
  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: '1h' }));
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === '23505' ? 409 : err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status === 409 && err.code === '23505' ? 'That already exists.' : status >= 500 ? 'Something went wrong.' : err.message });
  });
  return app;
}
