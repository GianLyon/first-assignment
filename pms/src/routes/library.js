// The reports library (mounted at /api/library): the list of reports this person may open, and running one.
import express from 'express';
import { HttpError, can } from '../auth.js';
import { REPORTS, DEPTS, canSee, compile } from '../reports/library.js';
import { getSettings } from '../services/frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const csvCell = (v) => { const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

export function reportsLibraryRouter(pool) {
  const r = express.Router();
  r.get('/', async (req, res) => {
    const depts = DEPTS.filter(([k]) => canSee(req.user, k, can)).map(([key, name]) => ({ key, name, reports: REPORTS.filter((x) => x.dept === key).map((x) => ({ key: x.key, name: x.name, desc: x.desc, range: x.params.includes('range'), outlet: !!x.outlet })) }));
    const outlets = (await pool.query('SELECT id, name FROM outlets WHERE active ORDER BY name')).rows;
    res.json({ departments: depts, outlets });
  });
  r.get('/:key', async (req, res) => {
    const rep = REPORTS.find((x) => x.key === req.params.key);
    if (!rep) throw new HttpError(404, 'Report not found.');
    if (!canSee(req.user, rep.dept, can)) throw new HttpError(403, 'You do not have permission to open this report.');
    const s = await getSettings(pool);
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : s.business_date;
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : to.slice(0, 8) + '01';
    if (from > to) throw new HttpError(400, 'The start date is after the end date.');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 732) throw new HttpError(400, 'Choose at most two years.');
    const outlet = rep.outlet && /^\d+$/.test(req.query.outlet || '') ? Number(req.query.outlet) : null;
    const { text, params } = compile(rep.sql, { from, to, outlet });
    const { rows } = await pool.query({ text, values: params });
    const money = new Set(rep.cols.filter((c) => ['money', 'int', 'num', 'pct'].includes(c[2])).map((c) => c[0]));
    const out = rows.slice(0, 5000).map((row) => { const o = { ...row }; for (const k of money) if (o[k] != null) o[k] = Number(o[k]); return o; });
    const totals = rep.sum ? Object.fromEntries(rep.sum.map((k) => [k, out.reduce((a, x) => a + (Number(x[k]) || 0), 0)])) : null;
    const meta = { key: rep.key, name: rep.name, desc: rep.desc, dept: DEPTS.find(([k]) => k === rep.dept)[1], cols: rep.cols, from: rep.params.includes('range') ? from : null, to: rep.params.includes('range') ? to : null,
      outlet: outlet ? (await pool.query('SELECT name FROM outlets WHERE id=$1', [outlet])).rows[0]?.name || null : null, property: s.property_name, truncated: rows.length > 5000 };
    if (req.query.format === 'csv') {
      const lines = [rep.cols.map((c) => csvCell(c[1])).join(','), ...out.map((row) => rep.cols.map((c) => csvCell(row[c[0]])).join(','))];
      if (totals) lines.push(rep.cols.map((c, i) => csvCell(i === 0 ? 'Total' : totals[c[0]] ?? '')).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${rep.key}-${from}-${to}.csv"`);
      return res.send('﻿' + lines.join('\r\n'));
    }
    res.json({ ...meta, rows: out, totals });
  });
  return r;
}
