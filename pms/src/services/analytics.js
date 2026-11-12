// Dashboard analytics: revenue by department, income vs expenses per day, occupancy (overall, by room type and by room)
// and the key hotel figures. Revenue and expenses come from the accounts, so they always agree with the reports.
import { HttpError } from '../auth.js';
import { getSettings } from './frontoffice.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const span = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
// revenue accounts → the hotel's revenue arms
const ARM = { '4000': 'rooms', '4100': 'fnb', '4200': 'amenities', '4300': 'events' };
export const ARMS = { rooms: 'Rooms', fnb: 'Food & beverage', amenities: 'Amenities', events: 'Events', other: 'Other income' };
const ROOM_NIGHT = "c.department='rooms' AND c.description LIKE 'Room charge, night of %' AND NOT c.voided";

export async function dashboardAnalytics(db, { from, to } = {}) {
  const s = await getSettings(db);
  const lastClosed = addDays(s.business_date, -1);
  to = DATE_RE.test(to || '') ? to : lastClosed;
  from = DATE_RE.test(from || '') ? from : addDays(to, -29);
  if (to < from || span(from, to) > 366) throw new HttpError(400, 'Choose a period of up to a year.');
  const days = span(from, to);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;

  /* today, live */
  const [now] = await q(`SELECT count(*) FILTER (WHERE active)::int AS rooms, count(*) FILTER (WHERE active AND hk_status <> 'out_of_order')::int AS sellable,
      count(*) FILTER (WHERE active AND hk_status='out_of_order')::int AS ooo,
      count(*) FILTER (WHERE active AND id IN (SELECT room_id FROM reservations WHERE status='in_house'))::int AS occupied,
      count(*) FILTER (WHERE active AND hk_status='clean' AND id NOT IN (SELECT room_id FROM reservations WHERE status='in_house' AND room_id IS NOT NULL))::int AS vacant_clean,
      count(*) FILTER (WHERE active AND hk_status='dirty' AND id NOT IN (SELECT room_id FROM reservations WHERE status='in_house' AND room_id IS NOT NULL))::int AS vacant_dirty FROM rooms`);
  const [guests] = await q("SELECT COALESCE(SUM(adults + children),0)::int AS n FROM reservations WHERE status='in_house'");
  const forecast = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(s.business_date, i);
    const [x] = await q("SELECT count(*)::int AS n FROM reservations WHERE status IN ('reserved','in_house') AND arrival <= $1 AND departure > $1", [d]);
    forecast.push({ date: d, rooms: x.n, occupancy: now.sellable ? x.n / now.sellable : 0 });
  }

  /* revenue and expenses per day, from the accounts */
  const rev = await q(`SELECT to_char(e.business_date,'YYYY-MM-DD') AS d, l.account_code AS code, SUM(l.credit - l.debit)::bigint AS amount
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code
    WHERE a.type='revenue' AND e.business_date BETWEEN $1 AND $2 GROUP BY 1, 2`, [from, to]);
  const exp = await q(`SELECT to_char(e.business_date,'YYYY-MM-DD') AS d, a.code, a.name, SUM(l.debit - l.credit)::bigint AS amount
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code
    WHERE a.type='expense' AND e.business_date BETWEEN $1 AND $2 GROUP BY 1, 2, 3`, [from, to]);
  const audits = await q("SELECT to_char(business_date,'YYYY-MM-DD') AS d, room_charges_posted AS sold, room_revenue FROM night_audits WHERE business_date BETWEEN $1 AND $2", [from, to]);
  const col = await q(`SELECT to_char(business_date,'YYYY-MM-DD') AS d, SUM(amount)::bigint AS amount FROM (
      SELECT business_date, amount FROM payments WHERE NOT voided AND method <> 'company_account' AND business_date BETWEEN $1 AND $2
      UNION ALL SELECT business_date, amount FROM pos_payments WHERE method <> 'room' AND business_date BETWEEN $1 AND $2) x GROUP BY 1`, [from, to]);

  const arms = Object.fromEntries(Object.keys(ARMS).map((k) => [k, 0]));
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const byArm = Object.fromEntries(Object.keys(ARMS).map((k) => [k, 0]));
    for (const r of rev.filter((x) => x.d === d)) byArm[ARM[r.code] || 'other'] += Number(r.amount);
    for (const k of Object.keys(byArm)) arms[k] += byArm[k];
    const income = Object.values(byArm).reduce((a, b) => a + b, 0);
    const expenses = exp.filter((x) => x.d === d).reduce((a, x) => a + Number(x.amount), 0);
    const a = audits.find((x) => x.d === d);
    daily.push({ date: d, income, expenses, net: income - expenses, collected: Number(col.find((x) => x.d === d)?.amount || 0), by_arm: byArm,
      rooms_sold: a ? a.sold : null, occupancy: a && now.sellable ? a.sold / now.sellable : null });
  }
  const expByAccount = Object.values(exp.reduce((m, x) => { (m[x.code] ||= { code: x.code, name: x.name, amount: 0 }).amount += Number(x.amount); return m; }, {}))
    .filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount);

  /* occupancy by room type and by room, from the nightly room charges */
  const byType = await q(`SELECT t.id, t.name, t.code, (SELECT count(*) FROM rooms r WHERE r.room_type_id=t.id AND r.active)::int AS rooms,
      count(c.id)::int AS nights, COALESCE(SUM(c.amount),0)::bigint AS revenue
    FROM room_types t LEFT JOIN reservations res ON res.room_type_id=t.id LEFT JOIN folio_charges c ON c.reservation_id=res.id AND ${ROOM_NIGHT} AND c.business_date BETWEEN $1 AND $2
    GROUP BY t.id ORDER BY t.id`, [from, to]);
  const byRoom = await q(`SELECT rm.id, rm.number, t.name AS type_name, rm.hk_status, count(c.id)::int AS nights, COALESCE(SUM(c.amount),0)::bigint AS revenue
    FROM rooms rm JOIN room_types t ON t.id=rm.room_type_id LEFT JOIN reservations res ON res.room_id=rm.id
    LEFT JOIN folio_charges c ON c.reservation_id=res.id AND ${ROOM_NIGHT} AND c.business_date BETWEEN $1 AND $2
    WHERE rm.active GROUP BY rm.id, t.name ORDER BY rm.number`, [from, to]);
  const audited = audits.length;

  /* bookings: where they come from, how long guests stay */
  const sources = await q(`SELECT COALESCE(ch.name, r.source) AS source, count(*)::int AS bookings, COALESCE(SUM(r.departure - r.arrival),0)::int AS nights
    FROM reservations r LEFT JOIN channels ch ON ch.id=r.channel_id WHERE r.arrival BETWEEN $1 AND $2 AND r.status IN ('reserved','in_house','checked_out') GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  const [stay] = await q(`SELECT COALESCE(AVG(departure - arrival),0)::float AS avg_nights, count(*)::int AS stays,
      count(*) FILTER (WHERE status='no_show')::int AS no_shows, count(*) FILTER (WHERE status='cancelled')::int AS cancelled
    FROM reservations WHERE arrival BETWEEN $1 AND $2`, [from, to]);
  const methods = await q(`SELECT method, SUM(amount)::bigint AS amount FROM (
      SELECT method, amount FROM payments WHERE NOT voided AND business_date BETWEEN $1 AND $2
      UNION ALL SELECT method, amount FROM pos_payments WHERE method <> 'room' AND business_date BETWEEN $1 AND $2) x GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  const [fnb] = await q(`SELECT count(*)::int AS checks, COALESCE(SUM(covers),0)::int AS covers,
      COALESCE((SELECT SUM(l.qty*l.unit_price) FROM pos_check_lines l JOIN pos_checks c2 ON c2.id=l.check_id WHERE c2.status='settled' AND c2.business_date BETWEEN $1 AND $2 AND l.status<>'voided'),0)::bigint AS sales
    FROM pos_checks WHERE status='settled' AND business_date BETWEEN $1 AND $2`, [from, to]);

  const income = daily.reduce((a, d) => a + d.income, 0), expenses = daily.reduce((a, d) => a + d.expenses, 0);
  const sold = audits.reduce((a, x) => a + x.sold, 0), roomRev = arms.rooms;
  const available = now.sellable * audited;
  return {
    business_date: s.business_date, from, to, days, audited_days: audited,
    today: { ...now, guests: guests.n, occupancy: now.sellable ? now.occupied / now.sellable : 0 }, forecast,
    totals: { income, expenses, net: income - expenses, collected: daily.reduce((a, d) => a + d.collected, 0), rooms_sold: sold, available,
      occupancy: available ? sold / available : 0, adr: sold ? Math.round(roomRev / sold) : 0, revpar: available ? Math.round(roomRev / available) : 0,
      avg_stay: Math.round(stay.avg_nights * 10) / 10, stays: stay.stays, no_shows: stay.no_shows, cancelled: stay.cancelled,
      fnb_checks: fnb.checks, fnb_covers: fnb.covers, fnb_sales: Number(fnb.sales), fnb_avg_check: fnb.checks ? Math.round(Number(fnb.sales) / fnb.checks) : 0 },
    arms: Object.entries(ARMS).map(([key, label]) => ({ key, label, amount: arms[key] })),
    daily, expenses_by_account: expByAccount.slice(0, 8),
    room_types: byType.map((t) => ({ ...t, revenue: Number(t.revenue), occupancy: t.rooms && audited ? t.nights / (t.rooms * audited) : 0 })),
    rooms: byRoom.map((r) => ({ ...r, revenue: Number(r.revenue), occupancy: audited ? r.nights / audited : 0 })),
    sources, methods: methods.map((m) => ({ ...m, amount: Number(m.amount) })),
  };
}
