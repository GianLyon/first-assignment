// Phase 17: the assistant for every department. Each check reads the system and says, in plain words, what needs
// doing, what does not balance, what is running out, whose details are missing and what looks wrong.
// Front office comes from frontDeskTasks (assistant.js); the rest is here. Everything is read-only.
import { getSettings } from './frontoffice.js';
import { frontDeskTasks } from './assistant.js';

const ugx = (n) => 'UGX ' + Math.round(Number(n) || 0).toLocaleString('en-US');
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dayName = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const list = (rows, f, n = 5) => rows.slice(0, n).map(f).join(', ') + (rows.length > n ? ` and ${rows.length - n} more` : '');
const one = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const many = async (db, sql, p = []) => (await db.query(sql, p)).rows;

export const DEPARTMENTS = {
  management: 'Management', front_office: 'Front office', finance: 'Finance', procurement: 'Stores & procurement', marketing: 'Sales & marketing',
  housekeeping: 'Housekeeping & maintenance', fnb: 'Food & beverage', hr: 'People (HR)',
};
// who sees which department (a right in that department is enough)
export const DEPT_PERMS = {
  management: ['settings.manage', 'auditlog.view'], front_office: ['reservations.view'], finance: ['finance.view', 'accounts.view'], procurement: ['inventory.view', 'purchase.approve'],
  marketing: ['marketing.manage', 'messages.manage', 'distribution.manage'], housekeeping: ['housekeeping.update', 'maintenance.work'], fnb: ['pos.manage', 'pos.void'], hr: ['hr.view'],
};

/* ---------------- finance: what does not balance, what is owed, what is late ---------------- */
async function finance(db, bd) {
  const out = [], add = (t) => out.push({ dept: 'finance', ...t });
  const bal = async (code) => Number((await one(db, 'SELECT COALESCE(SUM(debit - credit),0) AS b FROM journal_lines WHERE account_code=$1', [code])).b);
  // 1. the books: every entry must balance (the database refuses anything else), so check the totals and the sub-ledgers
  const tb = await one(db, 'SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines');
  if (Number(tb.d) !== Number(tb.c)) add({ priority: 'urgent', title: 'The trial balance does not balance', detail: `Debits ${ugx(tb.d)}, credits ${ugx(tb.c)}. Call Azeli support.`, link: '#accounts' });
  const folios = Number((await one(db, `SELECT COALESCE((SELECT SUM(amount) FROM folio_charges WHERE NOT voided),0) - COALESCE((SELECT SUM(amount) FROM payments WHERE NOT voided),0) AS b`)).b);
  const gl1100 = await bal('1100');
  if (Math.abs(gl1100 - folios) > 0) add({ priority: 'high', title: 'Guest ledger does not match the guest bills', detail: `Accounts show ${ugx(gl1100)}; the open guest bills add up to ${ugx(folios)} (difference ${ugx(gl1100 - folios)}). Look for a manual journal posted to account 1100.`, link: '#accounts' });
  const stockValue = Number((await one(db, 'SELECT COALESCE(SUM(b.qty * i.avg_cost),0) AS v FROM stock_balances b JOIN stock_items i ON i.id=b.item_id')).v);
  const gl1300 = await bal('1300');
  if (Math.abs(gl1300 - stockValue) > Math.max(5000, Math.abs(stockValue) * 0.005)) add({ priority: 'high', title: 'Inventory in the accounts does not match the stock on hand', detail: `Accounts ${ugx(gl1300)}, stock valued at ${ugx(stockValue)} (difference ${ugx(gl1300 - stockValue)}). A stock count or a manual journal may be missing.`, link: '#invreports' });
  // 2. money owed to us
  const overdue = await many(db, `SELECT c.name, i.number, to_char(i.due_date,'YYYY-MM-DD') AS due, i.total - COALESCE((SELECT SUM(a.amount) FROM ar_allocations a WHERE a.invoice_id=i.id),0) AS open
    FROM invoices i JOIN companies c ON c.id=i.company_id WHERE i.status='issued' AND i.due_date < $1 ORDER BY i.due_date`, [bd]);
  const od = overdue.filter((x) => Number(x.open) > 0);
  if (od.length) add({ priority: od.some((x) => x.due < addDays(bd, -30)) ? 'high' : 'normal', title: `${od.length} company invoice${od.length === 1 ? '' : 's'} overdue: ${ugx(od.reduce((a, x) => a + Number(x.open), 0))}`, detail: list(od, (x) => `${x.name} ${x.number} (due ${dayName(x.due)})`), link: '#companies' });
  const overLimit = await many(db, `SELECT c.id, c.name, c.credit_limit,
      COALESCE((SELECT SUM(amount) FROM payments WHERE company_id=c.id AND method='company_account' AND NOT voided),0)
      + COALESCE((SELECT SUM(il.amount) FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id WHERE i.company_id=c.id AND i.status='issued' AND il.payment_id IS NULL),0)
      - COALESCE((SELECT SUM(amount) FROM ar_receipts WHERE company_id=c.id),0) AS owed FROM companies c WHERE c.active AND c.credit_limit > 0`);
  for (const c of overLimit.filter((x) => Number(x.owed) > Number(x.credit_limit))) add({ priority: 'high', title: `${c.name} is over its credit limit`, detail: `Owes ${ugx(c.owed)} against a limit of ${ugx(c.credit_limit)}. Ask for payment before taking more stays on account.`, link: `#company/${c.id}` });
  // 3. money we owe
  const bills = await many(db, `SELECT s.name, b.bill_number, to_char(b.due_date,'YYYY-MM-DD') AS due, b.total - COALESCE((SELECT SUM(a.amount) FROM ap_allocations a WHERE a.bill_id=b.id),0) AS open
    FROM supplier_bills b JOIN suppliers s ON s.id=b.supplier_id WHERE b.status='open' AND b.due_date <= $1::date + 3 ORDER BY b.due_date`, [bd]);
  const due = bills.filter((x) => Number(x.open) > 0);
  if (due.length) add({ priority: due.some((x) => x.due < bd) ? 'high' : 'normal', title: `${due.length} supplier bill${due.length === 1 ? '' : 's'} due or overdue: ${ugx(due.reduce((a, x) => a + Number(x.open), 0))}`, detail: list(due, (x) => `${x.name} ${x.bill_number} (${x.due < bd ? 'overdue since' : 'due'} ${dayName(x.due)})`), link: '#payables' });
  // 4. bank reconciliation and closing the month
  const banks = await many(db, `SELECT a.code, a.name, (SELECT max(r.statement_date) FROM bank_reconciliations r WHERE r.account_code=a.code AND r.status='finished') AS last
    FROM accounts a WHERE a.is_cash AND a.active AND a.code <> '1000'`);
  for (const b of banks) {
    const last = b.last ? ymd(b.last) : null;
    if (!last || last < addDays(bd, -35)) add({ priority: 'normal', title: `Reconcile ${b.name}`, detail: last ? `Last reconciled to ${dayName(last)}. Match it to the statement so missing or wrong payments show up.` : 'Never reconciled. Match it to the bank or mobile money statement.', link: '#bankrec' });
  }
  const s = await getSettings(db);
  const monthStart = bd.slice(0, 8) + '01', lastMonthEnd = addDays(monthStart, -1);
  if (Number(bd.slice(8)) >= 10 && (!s.books_locked_until || ymd(s.books_locked_until) < lastMonthEnd)) add({ priority: 'normal', title: `Close the books for ${new Date(lastMonthEnd + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}`, detail: 'Once the month is checked, lock it so nobody can post to it by mistake.', link: '#money' });
  // 5. payroll
  const period = bd.slice(0, 7);
  if (Number(bd.slice(8)) >= 25 && !(await one(db, 'SELECT 1 AS x FROM payroll_runs WHERE period=$1', [period]))) add({ priority: 'normal', title: `Prepare payroll for ${period}`, detail: 'No payroll run for this month yet.', link: '#payroll' });
  const unapproved = await one(db, "SELECT count(*)::int AS n FROM payroll_runs WHERE status NOT IN ('posted','paid') AND created_at < now() - interval '2 days'");
  if (unapproved.n) add({ priority: 'normal', title: `${unapproved.n} payroll run${unapproved.n === 1 ? '' : 's'} waiting for approval or posting`, detail: 'Prepared more than 2 days ago.', link: '#payroll' });
  // 6. anything that looks wrong: many voids by one person
  const voids = await many(db, `SELECT u.full_name, count(*)::int AS n, SUM(x.amount)::bigint AS total FROM (
      SELECT voided_by AS uid, amount FROM folio_charges WHERE voided AND voided_at > now() - interval '7 days'
      UNION ALL SELECT voided_by, amount FROM payments WHERE voided AND posted_at > now() - interval '7 days') x JOIN users u ON u.id=x.uid GROUP BY u.full_name HAVING count(*) >= 5 ORDER BY n DESC`).catch(() => []);
  for (const v of voids) add({ priority: 'high', title: `Check voids by ${v.full_name}`, detail: `${v.n} voids worth ${ugx(v.total)} in the last 7 days. Each has a reason in the audit log.`, link: '#log' });
  return out;
}

/* ---------------- stores & procurement: running out, waiting, missing ---------------- */
async function procurement(db, bd) {
  const out = [], add = (t) => out.push({ dept: 'procurement', ...t });
  const low = await many(db, `SELECT i.name, i.unit, i.reorder_level, COALESCE(SUM(b.qty),0) AS qty FROM stock_items i LEFT JOIN stock_balances b ON b.item_id=i.id
    WHERE i.active GROUP BY i.id HAVING COALESCE(SUM(b.qty),0) <= i.reorder_level AND i.reorder_level > 0 ORDER BY COALESCE(SUM(b.qty),0) / NULLIF(i.reorder_level,0)`);
  const out0 = low.filter((x) => Number(x.qty) <= 0);
  if (out0.length) add({ priority: 'urgent', title: `${out0.length} item${out0.length === 1 ? ' has' : 's have'} run out`, detail: list(out0, (x) => x.name), link: '#invreports' });
  const lowOnly = low.filter((x) => Number(x.qty) > 0);
  if (lowOnly.length) add({ priority: 'high', title: `${lowOnly.length} item${lowOnly.length === 1 ? ' is' : 's are'} running low`, detail: list(lowOnly, (x) => `${x.name} (${Number(x.qty)} ${x.unit} left, re-order at ${x.reorder_level})`), link: '#invreports' });
  const neg = await many(db, 'SELECT i.name, s.name AS store, b.qty FROM stock_balances b JOIN stock_items i ON i.id=b.item_id JOIN stores s ON s.id=b.store_id WHERE b.qty < 0');
  if (neg.length) add({ priority: 'high', title: `${neg.length} item${neg.length === 1 ? ' shows' : 's show'} less than zero`, detail: `${list(neg, (x) => `${x.name} in ${x.store}`)}. Sales used more than was received: a delivery may be missing, or the recipe is wrong.`, link: '#counts' });
  const po = await one(db, "SELECT count(*) FILTER (WHERE status='draft')::int AS draft, count(*) FILTER (WHERE status IN ('approved','partly_received') AND COALESCE(expected_date, created_at::date + 7) < $1)::int AS late FROM purchase_orders", [bd]);
  if (po.draft) add({ priority: 'normal', title: `${po.draft} purchase order${po.draft === 1 ? '' : 's'} waiting for approval`, detail: 'Someone other than the person who raised it must approve.', link: '#purchasing' });
  if (po.late) add({ priority: 'high', title: `${po.late} approved order${po.late === 1 ? ' has' : 's have'} not arrived`, detail: 'Past the expected date. Chase the supplier.', link: '#purchasing' });
  const req = await one(db, "SELECT count(*) FILTER (WHERE status='requested')::int AS a, count(*) FILTER (WHERE status='approved')::int AS i FROM requisitions");
  if (req.a) add({ priority: 'normal', title: `${req.a} requisition${req.a === 1 ? '' : 's'} to approve`, detail: 'Departments are waiting for stock.', link: '#requisitions' });
  if (req.i) add({ priority: 'normal', title: `${req.i} approved requisition${req.i === 1 ? '' : 's'} to issue`, detail: 'Approved and not yet issued from the store.', link: '#requisitions' });
  const stores = await many(db, `SELECT s.name, (SELECT max(c.business_date) FROM stock_counts c WHERE c.store_id=s.id AND c.status='posted') AS last FROM stores s WHERE s.active`);
  const uncounted = stores.filter((x) => !x.last || ymd(x.last) < addDays(bd, -31));
  if (uncounted.length) add({ priority: 'normal', title: `Count stock in ${uncounted.length} store${uncounted.length === 1 ? '' : 's'}`, detail: `${list(uncounted, (x) => `${x.name} (${x.last ? 'last ' + dayName(ymd(x.last)) : 'never'})`)}. A monthly count catches losses early.`, link: '#counts' });
  const nocost = await many(db, 'SELECT i.name FROM stock_items i JOIN stock_balances b ON b.item_id=i.id WHERE i.active AND i.avg_cost = 0 AND b.qty > 0 GROUP BY i.name');
  if (nocost.length) add({ priority: 'normal', title: `${nocost.length} item${nocost.length === 1 ? ' has' : 's have'} stock but no cost`, detail: `${list(nocost, (x) => x.name)}. Food cost and stock value will be wrong until they are received at a price.`, link: '#stockitems' });
  const sup = await many(db, "SELECT name FROM suppliers WHERE active AND (tin IS NULL OR (bank_account_no IS NULL AND momo_number IS NULL) OR phone IS NULL)");
  if (sup.length) add({ priority: 'low', title: `${sup.length} supplier${sup.length === 1 ? ' is' : 's are'} missing details`, detail: `${list(sup, (x) => x.name)}: TIN, phone or how to pay them.`, link: '#purchasing' });
  return out;
}

/* ---------------- sales & marketing ---------------- */
async function marketing(db, bd) {
  const out = [], add = (t) => out.push({ dept: 'marketing', ...t });
  const { rows: [cap] } = await db.query("SELECT count(*)::int AS n FROM rooms WHERE active AND hk_status <> 'out_of_order'");
  const weeks = await many(db, `SELECT to_char(w,'YYYY-MM-DD') AS w,
      (SELECT COALESCE(SUM(LEAST(r.departure, w::date + 7) - GREATEST(r.arrival, w::date)),0) FROM reservations r WHERE r.status IN ('reserved','in_house') AND r.arrival < w::date + 7 AND r.departure > w::date)::int AS nights
    FROM generate_series($1::date + 7, $1::date + 34, interval '7 days') w`, [bd]);
  const soft = weeks.filter((x) => cap.n && x.nights / (cap.n * 7) < 0.35);
  if (soft.length) add({ priority: 'high', title: `${soft.length} week${soft.length === 1 ? '' : 's'} ahead look quiet`, detail: `${list(soft, (x) => `week of ${dayName(x.w)}: ${Math.round((x.nights / (cap.n * 7)) * 100)}% booked`)}. Send a campaign to past guests, open a promotion on the channels, or call corporate clients.`, link: '#campaigns' });
  const mix = await one(db, `SELECT count(*) FILTER (WHERE channel_id IS NOT NULL OR source IN ('Booking.com','Expedia','Agoda','Airbnb'))::int AS ota, count(*)::int AS total, COALESCE(SUM((departure - arrival) * rate * commission_pct / 100) FILTER (WHERE commission_pct IS NOT NULL),0)::bigint AS comm
    FROM reservations WHERE created_at > now() - interval '30 days' AND status <> 'cancelled'`).catch(() => ({ ota: 0, total: 0, comm: 0 }));
  if (mix.total >= 10 && mix.ota / mix.total > 0.5) add({ priority: 'normal', title: `${Math.round((mix.ota / mix.total) * 100)}% of new bookings came through OTAs`, detail: `About ${ugx(mix.comm)} in commission this month. Push direct booking: website rate, WhatsApp, repeat-guest offers.`, link: '#bookingengine' });
  const s = await getSettings(db);
  if (!s.review_url) add({ priority: 'normal', title: 'Add your review page link', detail: 'Thank-you emails and WhatsApps ask for reviews; without a Google or TripAdvisor link they cannot.', link: '#guestemails' });
  const drafts = await one(db, "SELECT count(*)::int AS n FROM campaigns WHERE status='draft' AND created_at < now() - interval '3 days'");
  if (drafts.n) add({ priority: 'low', title: `${drafts.n} campaign draft${drafts.n === 1 ? '' : 's'} not sent`, detail: 'Finish and send, or delete.', link: '#campaigns' });
  const consent = await one(db, `SELECT count(*)::int AS total, count(*) FILTER (WHERE marketing_consent AND unsubscribed_at IS NULL)::int AS yes, count(*) FILTER (WHERE email IS NULL AND phone IS NULL)::int AS nocontact
    FROM guests g WHERE merged_into IS NULL AND erased_at IS NULL AND EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id=g.id AND r.created_at > now() - interval '60 days')`);
  if (consent.total >= 10 && consent.yes / consent.total < 0.3) add({ priority: 'normal', title: `Only ${Math.round((consent.yes / consent.total) * 100)}% of recent guests agreed to marketing`, detail: 'Ask at check-in and on the website: past guests are the cheapest bookings.', link: '#guests' });
  if (consent.nocontact) add({ priority: 'normal', title: `${consent.nocontact} recent guest${consent.nocontact === 1 ? ' has' : 's have'} no phone or email`, detail: 'They cannot be thanked, asked for a review or invited back.', link: '#guests' });
  const hot = await many(db, `SELECT c.id, COALESCE(g.first_name || ' ' || g.last_name, c.profile_name, '+' || c.wa_id) AS who, i.stage, i.score FROM wa_intents i JOIN wa_conversations c ON c.id=i.conversation_id LEFT JOIN guests g ON g.id=c.guest_id
    WHERE i.stage IN ('ready','buyer') AND c.status='open' AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id=c.guest_id AND r.created_at > i.updated_at - interval '1 day') ORDER BY i.score DESC LIMIT 10`).catch(() => []);
  if (hot.length) add({ priority: 'urgent', title: `${hot.length} WhatsApp lead${hot.length === 1 ? ' is' : 's are'} ready to book`, detail: `${list(hot, (x) => `${x.who} (${x.score}%)`)}. Reply with a price and a booking link now.`, link: `#inbox/${hot[0].id}` });
  const chErr = await many(db, 'SELECT name, last_error FROM channels WHERE active AND last_error IS NOT NULL');
  for (const c of chErr) add({ priority: 'high', title: `Channel problem: ${c.name}`, detail: c.last_error, link: '#channels' });
  return out;
}

/* ---------------- housekeeping & maintenance ---------------- */
async function housekeeping(db, bd) {
  const out = [], add = (t) => out.push({ dept: 'housekeeping', ...t });
  const t = await one(db, "SELECT count(*)::int AS total, count(*) FILTER (WHERE assigned_to IS NULL AND status='pending')::int AS unassigned, count(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS open, count(*) FILTER (WHERE status='done')::int AS uninspected FROM hk_tasks WHERE business_date=$1", [bd]);
  const dirty = await one(db, "SELECT count(*)::int AS n FROM rooms WHERE active AND hk_status='dirty'");
  if (!t.total && dirty.n) add({ priority: 'high', title: "Today's room list has not been made", detail: `${dirty.n} rooms are dirty. Press “Refresh room list”, then “Share out rooms”.`, link: '#housekeeping' });
  if (t.unassigned) add({ priority: 'high', title: `${t.unassigned} room${t.unassigned === 1 ? '' : 's'} not given to anyone`, detail: 'Share them out so they get cleaned.', link: '#housekeeping' });
  if (t.uninspected >= 3) add({ priority: 'normal', title: `${t.uninspected} cleaned rooms waiting for inspection`, detail: 'Pass them or send them back before guests arrive.', link: '#housekeeping' });
  const wo = await many(db, "SELECT w.id, w.code, w.title, w.priority, to_char(w.due_date,'YYYY-MM-DD') AS due, rm.number FROM work_orders w LEFT JOIN rooms rm ON rm.id=w.room_id WHERE w.status IN ('open','in_progress','on_hold') AND (w.due_date < $1 OR w.priority='urgent') ORDER BY w.due_date", [bd]);
  if (wo.length) add({ priority: wo.some((x) => x.priority === 'urgent') ? 'urgent' : 'high', title: `${wo.length} repair job${wo.length === 1 ? ' is' : 's are'} overdue or urgent`, detail: list(wo, (x) => `${x.code} ${x.title}${x.number ? ` (room ${x.number})` : ''}`), link: '#maintenance' });
  const ooo = await many(db, `SELECT rm.number, b.reason, to_char(b.date_from,'YYYY-MM-DD') AS f, b.work_order_id FROM room_blocks b JOIN rooms rm ON rm.id=b.room_id
    WHERE b.released_at IS NULL AND b.kind='out_of_order' AND b.date_from <= $1 AND (b.date_to IS NULL OR b.date_to > $1)`, [bd]);
  const long = ooo.filter((x) => x.f < addDays(bd, -7));
  if (long.length) add({ priority: 'high', title: `${long.length} room${long.length === 1 ? ' has' : 's have'} been off sale for over a week`, detail: `${list(long, (x) => `${x.number}: ${x.reason}`)}. Every night off sale is lost revenue.`, link: '#maintenance' });
  const noJob = ooo.filter((x) => !x.work_order_id);
  if (noJob.length) add({ priority: 'normal', title: `${noJob.length} blocked room${noJob.length === 1 ? ' has' : 's have'} no repair job`, detail: `${list(noJob, (x) => x.number)}. Nobody in maintenance is fixing ${noJob.length === 1 ? 'it' : 'them'}.`, link: '#maintenance' });
  const svc = await one(db, "SELECT count(*)::int AS n FROM assets a WHERE a.status <> 'disposed' AND a.service_interval_days IS NOT NULL AND COALESCE(a.last_service_date, a.purchase_date) + a.service_interval_days <= $1", [bd]);
  if (svc.n) add({ priority: 'normal', title: `${svc.n} asset${svc.n === 1 ? ' is' : 's are'} due for service`, detail: 'Generators, AC, pumps…: press “Create due services” in Maintenance.', link: '#maintenance' });
  return out;
}

/* ---------------- food & beverage ---------------- */
async function fnb(db) {
  const out = [], add = (t) => out.push({ dept: 'fnb', ...t });
  const norecipe = await many(db, 'SELECT m.name FROM menu_items m WHERE m.active AND NOT EXISTS (SELECT 1 FROM recipe_lines r WHERE r.menu_item_id=m.id)');
  if (norecipe.length) add({ priority: 'normal', title: `${norecipe.length} menu item${norecipe.length === 1 ? ' has' : 's have'} no recipe`, detail: `${list(norecipe, (x) => x.name)}. Their sales do not take stock out, so food cost and stock are understated.`, link: '#stockitems' });
  const costly = await many(db, `SELECT m.name, m.price, SUM(r.qty * i.avg_cost) AS cost FROM menu_items m JOIN recipe_lines r ON r.menu_item_id=m.id JOIN stock_items i ON i.id=r.item_id
    WHERE m.active AND m.price > 0 GROUP BY m.id HAVING SUM(r.qty * i.avg_cost) > m.price / 1.18 * 0.45`);
  if (costly.length) add({ priority: 'high', title: `${costly.length} dish${costly.length === 1 ? '' : 'es'} cost more than 45% of the price`, detail: `${list(costly, (x) => `${x.name} (${Math.round((x.cost / (x.price / 1.18)) * 100)}%)`)}. Re-price, change the portion or the supplier.`, link: '#stockitems' });
  const voids = await one(db, "SELECT count(*)::int AS n FROM pos_check_lines WHERE voided AND voided_at > now() - interval '7 days'").catch(() => ({ n: 0 }));
  if (voids.n >= 10) add({ priority: 'normal', title: `${voids.n} items voided on the POS this week`, detail: 'Check the reasons; frequent voids can hide lost sales.', link: '#possales' });
  return out;
}

/* ---------------- people (HR) ---------------- */
async function hr(db, bd) {
  const out = [], add = (t) => out.push({ dept: 'hr', ...t });
  const missing = await many(db, `SELECT first_name || ' ' || last_name AS name, ARRAY_REMOVE(ARRAY[CASE WHEN nin IS NULL THEN 'NIN' END, CASE WHEN tin IS NULL THEN 'TIN' END, CASE WHEN nssf_no IS NULL THEN 'NSSF no.' END,
      CASE WHEN phone IS NULL THEN 'phone' END, CASE WHEN pay_method='bank' AND bank_account IS NULL THEN 'bank account' WHEN pay_method='mobile_money' AND momo_number IS NULL THEN 'mobile money no.' END], NULL) AS gaps
    FROM employees WHERE status='active'`);
  const gaps = missing.filter((x) => x.gaps.length);
  if (gaps.length) add({ priority: 'normal', title: `${gaps.length} staff record${gaps.length === 1 ? ' is' : 's are'} missing details`, detail: list(gaps, (x) => `${x.name}: ${x.gaps.join(', ')}`), link: '#employees' });
  const leave = await one(db, "SELECT count(*)::int AS n FROM leave_requests WHERE status='pending'");
  if (leave.n) add({ priority: 'normal', title: `${leave.n} leave request${leave.n === 1 ? '' : 's'} to decide`, detail: 'Staff are waiting for an answer.', link: '#leave' });
  const tomorrow = addDays(bd, 1);
  const rostered = await one(db, 'SELECT count(*)::int AS n FROM roster WHERE date=$1 AND shift_id IS NOT NULL', [tomorrow]);
  const staff = await one(db, "SELECT count(*)::int AS n FROM employees WHERE status='active'");
  if (staff.n && !rostered.n) add({ priority: 'high', title: `Nobody is on the roster for ${dayName(tomorrow)}`, detail: 'Plan tomorrow\'s shifts so every department is covered.', link: '#roster' });
  const att = await one(db, 'SELECT count(*)::int AS n FROM attendance WHERE date=$1', [bd]);
  if (staff.n && !att.n && rostered.n) add({ priority: 'low', title: 'No attendance recorded today', detail: 'Clock staff in and out so payroll and overtime are right.', link: '#attendance' });
  const login = await many(db, "SELECT u.full_name FROM users u WHERE u.active AND u.role <> 'admin' AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id=u.id)");
  if (login.length >= 3) add({ priority: 'low', title: `${login.length} sign-ins are not linked to a staff record`, detail: `${list(login, (x) => x.full_name)}. Link them so staff see their own payslips and leave.`, link: '#employees' });
  return out;
}

/* ---------------- management: the day in numbers, and the most urgent items from every department ---------------- */
async function management(db, bd, all) {
  const out = [], add = (t) => out.push({ dept: 'management', ...t });
  const k = await one(db, `SELECT
      (SELECT COALESCE(SUM(amount),0) FROM folio_charges WHERE NOT voided AND business_date >= date_trunc('month', $1::date)) AS mtd,
      (SELECT COALESCE(SUM(amount),0) FROM folio_charges WHERE NOT voided AND business_date >= (date_trunc('month', $1::date) - interval '1 month')::date AND business_date <= ($1::date - interval '1 month')::date) AS last_mtd`, [bd]);
  if (Number(k.last_mtd) > 0) {
    const ch = Math.round(((k.mtd - k.last_mtd) / k.last_mtd) * 100);
    add({ priority: ch < -10 ? 'high' : 'normal', title: `Revenue this month ${ugx(k.mtd)} (${ch >= 0 ? '+' : ''}${ch}% on last month to date)`, detail: ch < -10 ? 'Behind last month. See Sales & marketing for quiet weeks to fill.' : 'On track against last month.', link: '#dashboard' });
  }
  const urgent = all.filter((x) => x.priority === 'urgent' && x.dept !== 'management');
  for (const u of urgent.slice(0, 8)) add({ ...u, dept: 'management', title: `${DEPARTMENTS[u.dept]}: ${u.title}` });
  const audit = await one(db, "SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'settings.%' AND at > now() - interval '24 hours'");
  if (audit.n) add({ priority: 'low', title: `${audit.n} settings change${audit.n === 1 ? '' : 's'} in the last day`, detail: 'Check they were intended.', link: '#log' });
  return out;
}

/** Every department's list. `only` limits it to departments the user may see. */
export async function insights(db, { only = null } = {}) {
  const s = await getSettings(db), bd = ymd(s.business_date);
  const fd = await frontDeskTasks(db);
  const by = {
    front_office: fd.tasks.filter((t) => t.kind !== 'plan' || true).map((t) => ({ dept: 'front_office', priority: t.priority, title: t.title, detail: t.detail, link: t.link })),
    finance: await finance(db, bd), procurement: await procurement(db, bd), marketing: await marketing(db, bd), housekeeping: await housekeeping(db, bd), fnb: await fnb(db), hr: await hr(db, bd),
  };
  by.management = await management(db, bd, Object.values(by).flat());
  const order = { urgent: 0, high: 1, normal: 2, low: 3 };
  for (const k of Object.keys(by)) by[k].sort((a, b) => order[a.priority] - order[b.priority]);
  const depts = Object.keys(DEPARTMENTS).filter((d) => !only || only.includes(d));
  return { business_date: bd, departments: depts.map((d) => ({ key: d, name: DEPARTMENTS[d], items: by[d] || [] })), forecast: fd.forecast, local_time: fd.local_time };
}
