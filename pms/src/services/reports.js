// Phase 8: department reports (built from live data), email delivery and the group dashboard.
import crypto from 'node:crypto';
import { HttpError, audit } from '../auth.js';
import { getSettings } from './frontoffice.js';
import { validateEndpoint } from '../channels/index.js';
import { sendMail, transportInfo } from '../email/index.js';

export const REPORTS = {
  manager: 'General manager',
  front_office: 'Front office',
  fnb: 'Food & beverage',
  stores: 'Stores & purchasing',
  finance: 'Finance',
  hr: 'People (HR)',
  events: 'Events & amenities',
  maintenance: 'Maintenance',
};
export const FREQUENCIES = { daily: 'Daily', weekly: 'Weekly (Mon–Sun)', monthly: 'Monthly' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
const n0 = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
const pct = (v) => `${(Math.round((Number(v) || 0) * 1000) / 10).toFixed(1)}%`;
const dmy = (d) => new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const label = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/* ------------------------- shared figures ------------------------- */
async function revenueByAccount(db, from, to) {
  const { rows } = await db.query(`SELECT a.code, a.name, SUM(l.credit - l.debit)::bigint AS amount FROM journal_lines l
      JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code
    WHERE e.business_date BETWEEN $1 AND $2 AND a.type='revenue' GROUP BY a.code, a.name HAVING SUM(l.credit - l.debit) <> 0 ORDER BY a.code`, [from, to]);
  return rows;
}
async function movement(db, from, to, codes) {
  const { rows: [r] } = await db.query(`SELECT COALESCE(SUM(l.debit - l.credit),0)::bigint AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    WHERE e.business_date BETWEEN $1 AND $2 AND l.account_code = ANY($3)`, [from, to, codes]);
  return Number(r.v);
}
async function balances(db, to, where) {
  const { rows } = await db.query(`SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit - l.credit) FILTER (WHERE e.business_date <= $1),0)::bigint AS bal
    FROM accounts a LEFT JOIN journal_lines l ON l.account_code=a.code LEFT JOIN journal_entries e ON e.id=l.entry_id
    WHERE ${where} GROUP BY a.code ORDER BY a.code`, [to]);
  return rows;
}
async function rooms(db, from, to) {
  const { rows: [a] } = await db.query('SELECT count(*)::int AS nights, COALESCE(SUM(room_charges_posted),0)::int AS occupied FROM night_audits WHERE business_date BETWEEN $1 AND $2', [from, to]);
  const { rows: [r] } = await db.query("SELECT count(*)::int AS n FROM rooms WHERE active AND hk_status <> 'out_of_order'");
  const roomRev = -(await movement(db, from, to, ['4000']));
  const available = r.n * Math.max(a.nights, 0);
  return { audited_nights: a.nights, occupied: a.occupied, available, room_revenue: roomRev,
    occupancy: available ? a.occupied / available : 0, adr: a.occupied ? roomRev / a.occupied : 0, revpar: available ? roomRev / available : 0 };
}
async function collections(db, from, to) {
  const { rows } = await db.query(`SELECT method, SUM(amount)::bigint AS amount FROM (
      SELECT method, amount FROM payments WHERE business_date BETWEEN $1 AND $2 AND NOT voided
      UNION ALL SELECT method, amount FROM pos_payments WHERE business_date BETWEEN $1 AND $2 AND method <> 'room') x GROUP BY method ORDER BY 2 DESC`, [from, to]);
  return rows;
}

/* ------------------------- report builders ------------------------- */
// Each returns { kpis: [[label, value, note?]], sections: [{ title, head, rows, empty? }] } with values already formatted.
// A head label starting with '#' is a number column.
const BUILD = {
  async manager(db, from, to) {
    const rm = await rooms(db, from, to);
    const rev = await revenueByAccount(db, from, to);
    const total = rev.reduce((s, r) => s + Number(r.amount), 0);
    const col = await collections(db, from, to);
    const next = addDays(to, 1);
    const { rows: [fo] } = await db.query(`SELECT count(*) FILTER (WHERE arrival=$1 AND status='reserved')::int AS arrivals, count(*) FILTER (WHERE departure=$1 AND status='in_house')::int AS departures,
      count(*) FILTER (WHERE status='in_house')::int AS in_house FROM reservations`, [next]);
    const bal = await balances(db, to, "a.is_cash OR a.code IN ('1100','1200','2000','2200')");
    return {
      kpis: [['Occupancy', pct(rm.occupancy), `${rm.occupied} of ${rm.available} room nights`], ['ADR', n0(rm.adr), 'UGX'], ['RevPAR', n0(rm.revpar), 'UGX'], ['Revenue', n0(total), 'UGX excl. VAT']],
      sections: [
        { title: 'Revenue by department (excl. VAT)', head: ['Account', '#UGX'], rows: [...rev.map((r) => [`${r.code} ${r.name}`, n0(r.amount)]), ['Total', n0(total)]], empty: 'No revenue posted.' },
        { title: 'Money collected', head: ['Method', '#UGX'], rows: col.map((c) => [label(c.method), n0(c.amount)]), empty: 'Nothing collected.' },
        { title: `Next day (${dmy(next)})`, head: ['', '#'], rows: [['Arrivals expected', String(fo.arrivals)], ['Departures due', String(fo.departures)], ['Guests in-house now', String(fo.in_house)]] },
        { title: `Balances at ${dmy(to)}`, head: ['Account', '#UGX'], rows: bal.map((b) => [`${b.code} ${b.name}`, n0(['liability', 'equity', 'revenue'].includes(b.type) ? -b.bal : b.bal)]) },
      ],
    };
  },

  async front_office(db, from, to) {
    const rm = await rooms(db, from, to);
    const { rows: [c] } = await db.query(`SELECT
        count(*) FILTER (WHERE arrival BETWEEN $1 AND $2 AND status IN ('in_house','checked_out'))::int AS arrived,
        count(*) FILTER (WHERE departure BETWEEN $1 AND $2 AND status='checked_out')::int AS departed,
        count(*) FILTER (WHERE arrival BETWEEN $1 AND $2 AND status='no_show')::int AS no_shows,
        count(*) FILTER (WHERE arrival BETWEEN $1 AND $2 AND status='cancelled')::int AS cancelled FROM reservations`, [from, to]);
    const { rows: src } = await db.query(`SELECT COALESCE(ch.name, r.source) AS source, count(*)::int AS n, COALESCE(SUM(r.rate * (r.departure - r.arrival)),0)::bigint AS value
      FROM reservations r LEFT JOIN channels ch ON ch.id=r.channel_id WHERE r.created_at::date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
    const { rows: [rc] } = await db.query("SELECT count(*)::int AS n FROM rooms WHERE active AND hk_status <> 'out_of_order'");
    const fc = [];
    for (let i = 1; i <= 7; i++) {
      const d = addDays(to, i);
      const { rows: [x] } = await db.query("SELECT count(*)::int AS n FROM reservations WHERE status IN ('reserved','in_house') AND arrival <= $1 AND departure > $1", [d]);
      fc.push([dmy(d), String(x.n), rc.n ? pct(x.n / rc.n) : '—']);
    }
    return {
      kpis: [['Occupancy', pct(rm.occupancy), `${rm.occupied} room nights`], ['Arrivals', String(c.arrived)], ['Departures', String(c.departed)], ['No-shows / cancelled', `${c.no_shows} / ${c.cancelled}`]],
      sections: [
        { title: 'New bookings by source', head: ['Source', '#Bookings', '#Room value (UGX)'], rows: src.map((s) => [label(s.source), String(s.n), n0(s.value)]), empty: 'No new bookings.' },
        { title: 'Next 7 days', head: ['Night', '#Rooms booked', '#Occupancy'], rows: fc },
      ],
    };
  },

  async fnb(db, from, to) {
    const { rows: outlets } = await db.query(`SELECT o.name, count(DISTINCT c.id)::int AS checks, COALESCE(SUM(c.covers),0)::int AS covers,
        COALESCE((SELECT SUM(l.qty*l.unit_price) FROM pos_check_lines l JOIN pos_checks c2 ON c2.id=l.check_id WHERE c2.outlet_id=o.id AND c2.status='settled' AND c2.business_date BETWEEN $1 AND $2 AND l.status <> 'voided'),0)::bigint AS sales
      FROM outlets o LEFT JOIN pos_checks c ON c.outlet_id=o.id AND c.status='settled' AND c.business_date BETWEEN $1 AND $2 GROUP BY o.id ORDER BY o.name`, [from, to]);
    const { rows: items } = await db.query(`SELECT l.name, SUM(l.qty)::int AS qty, SUM(l.qty*l.unit_price)::bigint AS sales FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id
      WHERE c.status='settled' AND c.business_date BETWEEN $1 AND $2 AND l.status <> 'voided' GROUP BY l.name ORDER BY 3 DESC LIMIT 10`, [from, to]);
    const { rows: [v] } = await db.query(`SELECT count(*)::int AS n, COALESCE(SUM(l.qty*l.unit_price),0)::bigint AS value FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id
      WHERE l.status='voided' AND c.business_date BETWEEN $1 AND $2`, [from, to]);
    const sales = outlets.reduce((s, o) => s + Number(o.sales), 0);
    const netRev = -(await movement(db, from, to, ['4100'])), cos = await movement(db, from, to, ['5000']);
    const covers = outlets.reduce((s, o) => s + o.covers, 0);
    return {
      kpis: [['Sales', n0(sales), 'UGX incl. VAT'], ['Covers', String(covers)], ['Average per cover', covers ? n0(sales / covers) : '—', 'UGX'], ['Food & drink cost', netRev ? pct(cos / netRev) : '—', 'of F&B revenue excl. VAT']],
      sections: [
        { title: 'Sales by outlet', head: ['Outlet', '#Bills', '#Covers', '#Sales (UGX)'], rows: outlets.map((o) => [o.name, String(o.checks), String(o.covers), n0(o.sales)]) },
        { title: 'Top 10 items', head: ['Item', '#Qty', '#Sales (UGX)'], rows: items.map((i) => [i.name, String(i.qty), n0(i.sales)]), empty: 'No sales.' },
        { title: 'Voided items', head: ['', '#'], rows: [['Items voided after sending', String(v.n)], ['Value (UGX)', n0(v.value)]] },
      ],
    };
  },

  async stores(db, from, to) {
    const { rows: val } = await db.query(`SELECT s.name, COALESCE(SUM(b.qty * i.avg_cost),0)::bigint AS value FROM stores s LEFT JOIN stock_balances b ON b.store_id=s.id LEFT JOIN stock_items i ON i.id=b.item_id GROUP BY s.id ORDER BY s.name`);
    const { rows: low } = await db.query(`SELECT i.name, i.unit, i.reorder_level, COALESCE(SUM(b.qty),0) AS qty FROM stock_items i LEFT JOIN stock_balances b ON b.item_id=i.id
      WHERE i.active AND i.reorder_level > 0 GROUP BY i.id HAVING COALESCE(SUM(b.qty),0) <= i.reorder_level ORDER BY i.name LIMIT 30`);
    const { rows: [q] } = await db.query(`SELECT (SELECT count(*) FROM requisitions WHERE status='pending')::int AS req_pending, (SELECT count(*) FROM requisitions WHERE status='approved')::int AS req_to_issue,
        (SELECT count(*) FROM purchase_orders WHERE status='draft')::int AS po_to_approve, (SELECT count(*) FROM purchase_orders WHERE status IN ('approved','partly_received'))::int AS po_open,
        (SELECT COALESCE(SUM(total),0) FROM goods_received WHERE business_date BETWEEN $1 AND $2 AND NOT is_opening)::bigint AS received,
        (SELECT COALESCE(SUM(total_cost),0) FROM requisitions WHERE status='issued' AND business_date BETWEEN $1 AND $2)::bigint AS issued`, [from, to]);
    const total = val.reduce((s, v) => s + Number(v.value), 0);
    return {
      kpis: [['Stock value', n0(total), 'UGX at average cost'], ['Deliveries', n0(q.received), 'UGX received'], ['Issued to departments', n0(q.issued), 'UGX'], ['Items to re-order', String(low.length)]],
      sections: [
        { title: 'Waiting for action', head: ['', '#'], rows: [['Requisitions waiting approval', String(q.req_pending)], ['Approved requisitions to issue', String(q.req_to_issue)], ['Purchase orders waiting approval', String(q.po_to_approve)], ['Purchase orders awaiting delivery', String(q.po_open)]] },
        { title: 'Stock value by store', head: ['Store', '#UGX'], rows: val.map((v) => [v.name, n0(v.value)]) },
        { title: 'At or below re-order level', head: ['Item', '#On hand', '#Re-order at'], rows: low.map((l) => [l.name, `${Number(l.qty)} ${l.unit}`, `${Number(l.reorder_level)} ${l.unit}`]), empty: 'Nothing to re-order.' },
      ],
    };
  },

  async finance(db, from, to) {
    const rev = await revenueByAccount(db, from, to);
    const revenue = rev.reduce((s, r) => s + Number(r.amount), 0);
    const { rows: exp } = await db.query(`SELECT a.code, a.name, SUM(l.debit - l.credit)::bigint AS amount FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code
      WHERE e.business_date BETWEEN $1 AND $2 AND a.type='expense' GROUP BY a.code, a.name HAVING SUM(l.debit - l.credit) <> 0 ORDER BY 3 DESC`, [from, to]);
    const expenses = exp.reduce((s, r) => s + Number(r.amount), 0);
    const vat = -(await movement(db, from, to, ['2100']));
    const bal = await balances(db, to, "a.is_cash OR a.code IN ('1100','1200','2000','2100','2400')");
    const { rows: [ar] } = await db.query(`SELECT COALESCE(SUM(i.total - COALESCE((SELECT SUM(amount) FROM ar_allocations x WHERE x.invoice_id=i.id),0)) FILTER (WHERE i.due_date < $1),0)::bigint AS overdue
      FROM invoices i WHERE i.status='issued'`, [to]);
    return {
      kpis: [['Revenue', n0(revenue), 'UGX excl. VAT'], ['Expenses', n0(expenses), 'UGX incl. cost of sales'], ['Result', n0(revenue - expenses), revenue - expenses >= 0 ? 'profit' : 'loss'], ['Overdue invoices', n0(ar.overdue), 'UGX past due date']],
      sections: [
        { title: 'Revenue', head: ['Account', '#UGX'], rows: rev.map((r) => [`${r.code} ${r.name}`, n0(r.amount)]), empty: 'No revenue posted.' },
        { title: 'Expenses', head: ['Account', '#UGX'], rows: exp.map((r) => [`${r.code} ${r.name}`, n0(r.amount)]), empty: 'No expenses posted.' },
        { title: `Balances at ${dmy(to)}`, head: ['Account', '#UGX'], rows: bal.map((b) => [`${b.code} ${b.name}`, n0(['liability', 'equity', 'revenue'].includes(b.type) ? -b.bal : b.bal)]) },
        { title: 'VAT', head: ['', '#UGX'], rows: [['Net VAT movement in the period (output less input and payments)', n0(vat)]] },
      ],
    };
  },

  async hr(db, from, to) {
    const { rows: dept } = await db.query("SELECT department, count(*)::int AS n FROM employees WHERE status='active' GROUP BY 1 ORDER BY 1");
    const { rows: [a] } = await db.query(`SELECT count(*)::int AS signins, count(DISTINCT employee_id)::int AS people FROM attendance WHERE date BETWEEN $1 AND $2 AND clock_in IS NOT NULL`, [from, to]);
    const { rows: leave } = await db.query(`SELECT e.first_name || ' ' || e.last_name AS name, e.department, t.name AS type, to_char(l.from_date,'YYYY-MM-DD') AS f, to_char(l.to_date,'YYYY-MM-DD') AS t
      FROM leave_requests l JOIN employees e ON e.id=l.employee_id JOIN leave_types t ON t.code=l.type WHERE l.status='approved' AND l.from_date <= $2 AND l.to_date >= $1 ORDER BY l.from_date`, [from, to]);
    const { rows: [p] } = await db.query("SELECT count(*)::int AS n FROM leave_requests WHERE status='pending'");
    const { rows: [run] } = await db.query('SELECT status FROM payroll_runs WHERE period=$1', [to.slice(0, 7)]);
    const head = dept.reduce((s, d) => s + d.n, 0);
    return {
      kpis: [['Staff', String(head), 'active employees'], ['Sign-ins', String(a.signins), `${a.people} people`], ['On leave', String(leave.length), 'in the period'], ['Leave to approve', String(p.n)]],
      sections: [
        { title: 'Staff by department', head: ['Department', '#Staff'], rows: dept.map((d) => [d.department, String(d.n)]), empty: 'No employees yet.' },
        { title: 'Leave in the period', head: ['Employee', 'Department', 'Type', 'Dates'], rows: leave.map((l) => [l.name, l.department, l.type, `${dmy(l.f)} – ${dmy(l.t)}`]), empty: 'Nobody on leave.' },
        { title: 'Payroll', head: ['', ''], rows: [[`Payroll ${to.slice(0, 7)}`, run ? label(run.status) : 'Not started']] },
      ],
    };
  },

  async events(db, from, to) {
    const { rows: am } = await db.query(`SELECT a.category, count(*)::int AS n, SUM(b.qty*b.unit_price)::bigint AS amount FROM amenity_bookings b JOIN amenities a ON a.id=b.amenity_id
      WHERE b.status='completed' AND b.service_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 3 DESC`, [from, to]);
    const { rows: [ev] } = await db.query(`SELECT count(*) FILTER (WHERE status='completed' AND event_date BETWEEN $1 AND $2)::int AS held, count(*) FILTER (WHERE status IN ('enquiry','tentative'))::int AS pipeline FROM events`, [from, to]);
    const evRev = -(await movement(db, from, to, ['4300']));
    const { rows: up } = await db.query(`SELECT e.code, e.title, to_char(e.event_date,'YYYY-MM-DD') AS d, to_char(e.start_time,'HH24:MI') AS st, fr.name AS room, e.pax, e.status,
        COALESCE((SELECT SUM(CASE WHEN kind='deposit' THEN amount ELSE -amount END) FROM event_payments p WHERE p.event_id=e.id),0)::bigint AS deposits
      FROM events e JOIN function_rooms fr ON fr.id=e.function_room_id WHERE e.status IN ('tentative','confirmed') AND e.event_date BETWEEN $1 AND $2 ORDER BY e.event_date, e.start_time`, [addDays(to, 1), addDays(to, 14)]);
    const amTotal = am.reduce((s, x) => s + Number(x.amount), 0);
    return {
      kpis: [['Amenity sales', n0(amTotal), 'UGX incl. VAT'], ['Events held', String(ev.held)], ['Event revenue', n0(evRev), 'UGX excl. VAT'], ['Enquiries open', String(ev.pipeline)]],
      sections: [
        { title: 'Amenities sold', head: ['Category', '#Services', '#UGX'], rows: am.map((x) => [label(x.category), String(x.n), n0(x.amount)]), empty: 'No amenities sold.' },
        { title: 'Events in the next 14 days', head: ['Date', 'Event', 'Room', '#Guests', 'Status', '#Deposits (UGX)'], rows: up.map((e) => [`${dmy(e.d)} ${e.st}`, `${e.code} ${e.title}`, e.room, String(e.pax), label(e.status), n0(e.deposits)]), empty: 'No events booked.' },
      ],
    };
  },

  async maintenance(db, from, to) {
    const { rows: [w] } = await db.query(`SELECT count(*) FILTER (WHERE status IN ('open','in_progress','on_hold'))::int AS open,
        count(*) FILTER (WHERE status IN ('open','in_progress','on_hold') AND due_date < $3)::int AS overdue,
        count(*) FILTER (WHERE status='done' AND completed_at::date BETWEEN $1 AND $2)::int AS done,
        COALESCE(SUM(cost) FILTER (WHERE status='done' AND completed_at::date BETWEEN $1 AND $2),0)::bigint AS cost FROM work_orders`, [from, to, addDays(to, 1)]);
    const { rows: open } = await db.query(`SELECT w.code, w.title, w.priority, to_char(w.due_date,'YYYY-MM-DD') AS due, rm.number AS room, a.name AS asset, w.assigned_to, w.status
      FROM work_orders w LEFT JOIN rooms rm ON rm.id=w.room_id LEFT JOIN assets a ON a.id=w.asset_id WHERE w.status IN ('open','in_progress','on_hold')
      ORDER BY array_position(ARRAY['urgent','high','normal','low'], w.priority), w.due_date NULLS LAST LIMIT 40`);
    const { rows: ooo } = await db.query("SELECT number FROM rooms WHERE hk_status='out_of_order' ORDER BY number");
    const { rows: due } = await db.query(`SELECT name, location, to_char(COALESCE(last_service_date, purchase_date) + service_interval_days,'YYYY-MM-DD') AS d FROM assets
      WHERE status <> 'disposed' AND service_interval_days IS NOT NULL AND COALESCE(last_service_date, purchase_date) + service_interval_days <= $1::date + 7 ORDER BY 3`, [to]);
    return {
      kpis: [['Open jobs', String(w.open)], ['Overdue', String(w.overdue)], ['Completed', String(w.done), `UGX ${n0(w.cost)} spent`], ['Rooms out of order', String(ooo.length), ooo.map((r) => r.number).join(', ')]],
      sections: [
        { title: 'Open jobs (most urgent first)', head: ['Job', 'Where', 'Priority', 'Due', 'Assigned'], rows: open.map((o) => [`${o.code} ${o.title}`, [o.room && `Room ${o.room}`, o.asset].filter(Boolean).join(' · '), label(o.priority), o.due ? dmy(o.due) : '', o.assigned_to || '']), empty: 'No open jobs.' },
        { title: 'Services due within a week', head: ['Asset', 'Location', 'Due'], rows: due.map((d) => [d.name, d.location || '', dmy(d.d)]), empty: 'Nothing due.' },
      ],
    };
  },
};

/* ------------------------- generate & render ------------------------- */
export async function buildReport(db, report, from, to) {
  if (!BUILD[report]) throw new HttpError(400, 'Unknown report.');
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw new HttpError(400, 'Choose a valid period.');
  if (days(from, to) > 366) throw new HttpError(400, 'The period can be at most a year.');
  const s = await getSettings(db);
  const data = await BUILD[report](db, from, to);
  const period = from === to ? dmy(from) : `${dmy(from)} – ${dmy(to)}`;
  return { ...data, property: s.property_name, report_name: REPORTS[report], period, generated_at: new Date().toISOString() };
}

const escH = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Email HTML (inline styles: email clients ignore stylesheets). */
export function renderHtml(d) {
  const kpi = d.kpis.map(([l, v, n]) => `<td style="padding:12px 14px;border:1px solid #e6dfd3;background:#fff;vertical-align:top"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#637173">${escH(l)}</div><div style="font-family:Georgia,serif;font-size:22px;color:#0f2a2e;margin-top:2px">${escH(v)}</div>${n ? `<div style="font-size:12px;color:#637173">${escH(n)}</div>` : ''}</td>`).join('');
  const sec = d.sections.map((s) => `<h3 style="font-family:Georgia,serif;color:#a8853f;font-size:15px;margin:22px 0 6px">${escH(s.title)}</h3>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px">${s.head.some((h) => h.replace('#', '')) ? `<tr>${s.head.map((h) => `<th style="text-align:${h.startsWith('#') ? 'right' : 'left'};padding:6px 8px;border-bottom:2px solid #0f2a2e;font-size:11px;text-transform:uppercase;color:#637173">${escH(h.replace(/^#/, ''))}</th>`).join('')}</tr>` : ''}
    ${s.rows.length ? s.rows.map((r) => `<tr>${r.map((c, i) => `<td style="padding:6px 8px;border-bottom:1px solid #e6dfd3;text-align:${s.head[i]?.startsWith('#') ? 'right' : 'left'}">${escH(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${s.head.length}" style="padding:8px;color:#637173">${escH(s.empty || 'Nothing to show.')}</td></tr>`}</table>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f6f3ee;font-family:Arial,Helvetica,sans-serif;color:#1d2a2c">
  <div style="max-width:720px;margin:0 auto;padding:24px">
    <div style="font-family:Georgia,serif;font-size:13px;color:#a8853f;letter-spacing:.08em;text-transform:uppercase">${escH(d.property)}</div>
    <h1 style="font-family:Georgia,serif;font-size:26px;color:#0f2a2e;margin:4px 0 2px">${escH(d.report_name)} report</h1>
    <div style="color:#637173;font-size:14px;margin-bottom:16px">${escH(d.period)}</div>
    <table cellpadding="0" cellspacing="6" style="width:100%;border-collapse:separate"><tr>${kpi}</tr></table>${sec}
    <p style="font-size:11px;color:#8a9496;margin-top:28px">Sent automatically by Azeli Property Management Software. Figures come from the live system at the time of sending.</p>
  </div></body></html>`;
}
export function renderText(d) {
  const lines = [`${d.property}: ${d.report_name} report`, d.period, '', ...d.kpis.map(([l, v, n]) => `${l}: ${v}${n ? ` (${n})` : ''}`)];
  for (const s of d.sections) {
    lines.push('', s.title.toUpperCase());
    if (!s.rows.length) lines.push(`  ${s.empty || 'Nothing to show.'}`);
    for (const r of s.rows) lines.push('  ' + r.filter((c) => c !== '').join(' | '));
  }
  lines.push('', 'Sent automatically by Azeli Property Management Software.');
  return lines.join('\n');
}

async function queueEmails(db, run, data, recipients) {
  const subject = `${data.property}: ${data.report_name} report, ${data.period}`;
  const html = renderHtml(data), text = renderText(data);
  for (const to of recipients) {
    await db.query('INSERT INTO email_outbox (run_id, to_address, subject, html, text_body) VALUES ($1,$2,$3,$4,$5)', [run.id, to, subject, html, text]);
  }
}

/** The periods that are complete when `closed` is the last audited business date. */
export function periodsClosedBy(closed) {
  const out = [{ frequency: 'daily', from: closed, to: closed }];
  const dow = new Date(closed + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  if (dow === 0) out.push({ frequency: 'weekly', from: addDays(closed, -6), to: closed });
  if (addDays(closed, 1).slice(8) === '01') out.push({ frequency: 'monthly', from: closed.slice(0, 8) + '01', to: closed });
  return out;
}

/** Create and queue every scheduled report whose period has just closed. Safe to call any number of times. */
export async function generateDue(db) {
  const { rows: [last] } = await db.query("SELECT to_char(max(business_date),'YYYY-MM-DD') AS d FROM night_audits");
  if (!last?.d) return { created: 0 };
  let created = 0;
  for (const p of periodsClosedBy(last.d)) {
    const { rows: subs } = await db.query('SELECT * FROM report_subscriptions WHERE active AND frequency=$1 ORDER BY id', [p.frequency]);
    for (const sub of subs) {
      const data = await buildReport(db, sub.report, p.from, p.to);
      const { rows: [run] } = await db.query(`INSERT INTO report_runs (report, frequency, period_from, period_to, title, data) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (report, frequency, period_from) WHERE frequency <> 'manual' DO NOTHING RETURNING id`, [sub.report, p.frequency, p.from, p.to, `${data.report_name}, ${data.period}`, data]);
      if (!run) continue; // already produced
      await queueEmails(db, run, data, sub.recipients);
      created++;
    }
  }
  return { created };
}

/** Produce a report now for any period; optionally email it. */
export async function runNow(db, user, { report, from, to, recipients }) {
  const data = await buildReport(db, report, from, to);
  const { rows: [run] } = await db.query("INSERT INTO report_runs (report, frequency, period_from, period_to, title, data, created_by) VALUES ($1,'manual',$2,$3,$4,$5,$6) RETURNING id",
    [report, from, to, `${data.report_name}, ${data.period}`, data, user.id]);
  const to_ = parseRecipients(recipients, false);
  if (to_.length) await queueEmails(db, run, data, to_);
  await audit(db, user, 'report.run', 'report_run', run.id, { report, from, to, emailed: to_.length });
  return { id: run.id, emailed: to_.length };
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export function parseRecipients(v, required = true) {
  const list = [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const bad = list.find((e) => !EMAIL_RE.test(e) || e.length > 200);
  if (bad) throw new HttpError(400, `"${bad}" is not a valid email address.`);
  if (required && !list.length) throw new HttpError(400, 'Add at least one email address.');
  if (list.length > 20) throw new HttpError(400, 'At most 20 recipients.');
  return list;
}

export async function saveSubscription(db, user, id, b) {
  if (!REPORTS[b.report]) throw new HttpError(400, 'Choose a report.');
  if (!FREQUENCIES[b.frequency]) throw new HttpError(400, 'Choose how often.');
  const recipients = parseRecipients(b.recipients);
  let row;
  if (id) ({ rows: [row] } = await db.query('UPDATE report_subscriptions SET report=$2, frequency=$3, recipients=$4, active=$5 WHERE id=$1 RETURNING *', [id, b.report, b.frequency, recipients, b.active !== false]));
  else ({ rows: [row] } = await db.query('INSERT INTO report_subscriptions (report, frequency, recipients, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [b.report, b.frequency, recipients, user.id]));
  if (!row) throw new HttpError(404, 'Schedule not found.');
  await audit(db, user, id ? 'report.schedule_update' : 'report.schedule_create', 'report_subscription', row.id, { report: b.report, frequency: b.frequency, recipients: recipients.length });
  return row;
}

/* ------------------------- email outbox ------------------------- */
const BACKOFF_MIN = [1, 5, 15, 60, 180];
/** Send queued emails. Failures are retried with back-off and given up after 6 attempts. */
export async function processOutbox(pool, limit = 20) {
  const { rows } = await pool.query("SELECT * FROM email_outbox WHERE status='queued' AND next_attempt_at <= now() ORDER BY id LIMIT $1", [limit]);
  const info = transportInfo();
  let sent = 0, failed = 0;
  for (const m of rows) {
    // claim the message so two workers never send it twice
    const { rowCount } = await pool.query("UPDATE email_outbox SET attempts=attempts+1, next_attempt_at=now() + interval '10 minutes' WHERE id=$1 AND status='queued' AND attempts=$2", [m.id, m.attempts]);
    if (!rowCount) continue;
    try {
      await sendMail({ to: m.to_address, subject: m.subject, html: m.html, text: m.text_body });
      await pool.query('UPDATE email_outbox SET status=$2, sent_at=now(), last_error=NULL WHERE id=$1', [m.id, info.live ? 'sent' : 'test']);
      sent++;
    } catch (e) {
      const attempts = m.attempts + 1;
      const giveUp = attempts >= 6;
      await pool.query(`UPDATE email_outbox SET status=$2, last_error=$3, next_attempt_at=now() + make_interval(mins => $4) WHERE id=$1`,
        [m.id, giveUp ? 'failed' : 'queued', String(e.message || e).slice(0, 500), BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]]);
      failed++;
    }
  }
  return { sent, failed };
}
export async function retryEmail(db, user, id) {
  const { rowCount } = await db.query("UPDATE email_outbox SET status='queued', attempts=0, next_attempt_at=now(), last_error=NULL WHERE id=$1 AND status='failed'", [id]);
  if (!rowCount) throw new HttpError(409, 'Only failed emails can be retried.');
  await audit(db, user, 'report.email_retry', 'email', id);
}

/* ------------------------- group (multi-property) ------------------------- */
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export async function newGroupToken(db, user) {
  const token = 'azg_' + crypto.randomBytes(24).toString('base64url');
  await db.query('UPDATE settings SET group_token_hash=$1, group_token_hint=$2 WHERE id=1', [hashToken(token), token.slice(-4)]);
  await audit(db, user, 'group.token_issue', 'settings', 1, { hint: token.slice(-4) });
  return token;
}
export async function revokeGroupToken(db, user) {
  await db.query('UPDATE settings SET group_token_hash=NULL, group_token_hint=NULL WHERE id=1');
  await audit(db, user, 'group.token_revoke', 'settings', 1);
}
export async function checkGroupToken(db, header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  const { rows: [s] } = await db.query('SELECT group_token_hash FROM settings WHERE id=1');
  if (!m || !s?.group_token_hash) return false;
  const a = Buffer.from(hashToken(m[1])), b = Buffer.from(s.group_token_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The figures one property shares with its group office. Totals only, no guest data. */
export async function propertySummary(db, from, to) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from || days(from, to) > 366) throw new HttpError(400, 'Choose a valid period (up to a year).');
  const s = await getSettings(db);
  const rm = await rooms(db, from, to);
  const rev = await revenueByAccount(db, from, to);
  const dept = { rooms: 0, fnb: 0, amenities: 0, events: 0, other: 0 };
  for (const r of rev) dept[{ '4000': 'rooms', '4100': 'fnb', '4200': 'amenities', '4300': 'events' }[r.code] || 'other'] += Number(r.amount);
  const col = (await collections(db, from, to)).reduce((t, c) => t + Number(c.amount), 0);
  const expenses = await movement(db, from, to, (await db.query("SELECT code FROM accounts WHERE type='expense'")).rows.map((r) => r.code));
  const bal = await balances(db, to, "a.is_cash OR a.code IN ('1200')");
  const { rows: [h] } = await db.query("SELECT (SELECT count(*) FROM reservations WHERE status='in_house')::int AS in_house, (SELECT count(*) FROM rooms WHERE active)::int AS rooms, (SELECT count(*) FROM work_orders WHERE status IN ('open','in_progress','on_hold') AND priority IN ('urgent','high'))::int AS urgent_jobs");
  return {
    property: s.property_name, business_date: s.business_date, from, to,
    rooms: h.rooms, in_house: h.in_house, occupied: rm.occupied, available: rm.available, occupancy: rm.occupancy, adr: Math.round(rm.adr), revpar: Math.round(rm.revpar),
    revenue: dept, revenue_total: Object.values(dept).reduce((a, b) => a + b, 0), expenses, collected: col,
    cash: bal.filter((b) => b.code !== '1200').reduce((t, b) => t + Number(b.bal), 0), receivable: Number(bal.find((b) => b.code === '1200')?.bal || 0), urgent_jobs: h.urgent_jobs,
  };
}

export async function saveGroupProperty(db, user, id, b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 100) throw new HttpError(400, 'Enter the property name.');
  let url;
  try { url = validateEndpoint(String(b.base_url || '').trim()); } catch (e) { throw new HttpError(400, e.message); }
  url = url.replace(/\/+$/, '');
  const token = String(b.token || '').trim();
  if (!id && !/^azg_[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Paste the group access key from that property (it starts with azg_).');
  if (token && !/^azg_[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'That is not a group access key.');
  let row;
  if (id) ({ rows: [row] } = await db.query('UPDATE group_properties SET name=$2, base_url=$3, token=COALESCE(NULLIF($4,\'\'), token), active=$5 WHERE id=$1 RETURNING id, name, base_url, active', [id, name, url, token, b.active !== false]));
  else ({ rows: [row] } = await db.query('INSERT INTO group_properties (name, base_url, token) VALUES ($1,$2,$3) RETURNING id, name, base_url, active', [name, url, token]));
  if (!row) throw new HttpError(404, 'Property not found.');
  await audit(db, user, id ? 'group.property_update' : 'group.property_add', 'group_property', row.id, { name, url });
  return row;
}

/** This property plus every linked property, fetched in parallel. A property that cannot be reached is shown as offline. */
export async function groupDashboard(pool, from, to) {
  const self = { id: 0, name: null, ...(await propertySummary(pool, from, to)), status: 'ok', self: true };
  self.name = self.property;
  const { rows: props } = await pool.query('SELECT * FROM group_properties WHERE active ORDER BY name');
  const others = await Promise.all(props.map(async (p) => {
    let status = 'ok', data = null;
    try {
      const base = validateEndpoint(p.base_url).replace(/\/?$/, '/');
      const res = await fetch(new URL(`api/group/summary?from=${from}&to=${to}`, base),
        { headers: { authorization: `Bearer ${p.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (res.status === 401) throw new Error('The access key was refused. Ask that property for a new one.');
      if (!res.ok) throw new Error(`The property answered ${res.status}.`);
      data = await res.json();
      if (typeof data?.revenue_total !== 'number') throw new Error('Unexpected answer from the property.');
    } catch (e) {
      status = e.name === 'TimeoutError' ? 'Could not be reached (no answer within 8 seconds).'
        : e.message === 'fetch failed' || e.cause ? 'Could not be reached. Check the address and that the property\'s system is online.' : String(e.message || e).slice(0, 200);
    }
    await pool.query('UPDATE group_properties SET last_status=$2, last_checked_at=now() WHERE id=$1', [p.id, status]);
    return { id: p.id, name: p.name, status, ...(data || {}) };
  }));
  const all = [self, ...others];
  const ok = all.filter((p) => p.status === 'ok');
  const sum = (k) => ok.reduce((t, p) => t + Number(p[k] || 0), 0);
  const occupied = sum('occupied'), available = sum('available'), roomRev = ok.reduce((t, p) => t + Number(p.revenue?.rooms || 0), 0);
  const total = { name: 'Group total', properties: ok.length, rooms: sum('rooms'), in_house: sum('in_house'), occupied, available, occupancy: available ? occupied / available : 0,
    adr: occupied ? Math.round(roomRev / occupied) : 0, revpar: available ? Math.round(roomRev / available) : 0, revenue_total: sum('revenue_total'), expenses: sum('expenses'),
    collected: sum('collected'), cash: sum('cash'), receivable: sum('receivable'), urgent_jobs: sum('urgent_jobs'),
    revenue: Object.fromEntries(['rooms', 'fnb', 'amenities', 'events', 'other'].map((k) => [k, ok.reduce((t, p) => t + Number(p.revenue?.[k] || 0), 0)])) };
  return { from, to, properties: all, total };
}
