// The reports library: every department's reports in one place, each a single query with typed columns.
//
// A report: { key, dept, name, desc, params: ['range'] | [] , outlet?: true, cols: [[key, label, type]], sum: [keys], sql }
//   types: text, int, money (UGX), num, pct, date, ts, time
//   sql uses :from, :to and :outlet (outlet may be null = all outlets); the engine turns them into $1, $2 … in order.
// Department rights decide who sees which reports (see DEPTS).

export const DEPTS = [
  ['frontdesk', 'Front desk', ['reservations.view']],
  ['accounts', 'Accounts', ['finance.view', 'accounts.view']],
  ['stores', 'Stores & inventory', ['inventory.view']],
  ['events', 'Events', ['events.view']],
  ['pos', 'Point of sale (restaurant & bar)', ['reports.view', 'pos.manage']],
  ['wellness', 'Spa & health club', ['amenities.sell', 'amenities.manage']],
  ['hr', 'HR', ['hr.view']],
  ['crm', 'Guests & marketing', ['marketing.manage', 'reservations.view']],
  ['maintenance', 'Maintenance & assets', ['maintenance.report', 'assets.manage']],
  ['management', 'Management', ['reports.view']],
];

// pieces used by several reports
const POS_NET = `((SELECT COALESCE(SUM(l.unit_price*l.qty),0) FROM pos_check_lines l WHERE l.check_id=c.id AND l.status <> 'voided') - c.discount_amount)`;
const POS_GROSS = `(SELECT COALESCE(SUM(l.unit_price*l.qty),0) FROM pos_check_lines l WHERE l.check_id=c.id AND l.status <> 'voided')`;
const GUEST = `trim(g.first_name || ' ' || g.last_name)`;
const OUTLET = `(:outlet::int IS NULL OR c.outlet_id = :outlet::int)`;
const FOLIO_BAL = `(COALESCE((SELECT SUM(amount) FROM folio_charges fc WHERE fc.reservation_id=r.id AND NOT fc.voided),0) - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.reservation_id=r.id AND NOT p.voided),0))`;
const NIGHTS = `(r.departure - r.arrival)`;
const STAY_VALUE = `COALESCE((SELECT SUM(rate) FROM reservation_nights n WHERE n.reservation_id=r.id), r.rate * (r.departure - r.arrival))`;
const RANGE = ['range'];

export const REPORTS = [
  /* ============================ FRONT DESK ============================ */
  { key: 'housekeeping', dept: 'frontdesk', name: 'Housekeeping report', desc: 'Every room now: clean or dirty, who is in it, when they leave, and blocks.', params: [],
    cols: [['room', 'Room', 'text'], ['type', 'Type', 'text'], ['floor', 'Floor', 'text'], ['hk', 'Housekeeping', 'text'], ['guest', 'Guest', 'text'], ['departure', 'Departs', 'date'], ['block', 'Block', 'text']],
    sql: `SELECT rm.number AS room, rt.name AS type, rm.floor, rm.hk_status AS hk, ${GUEST} AS guest, r.departure,
            (SELECT b.kind || ': ' || b.reason FROM room_blocks b WHERE b.room_id=rm.id AND b.released_at IS NULL AND b.date_from <= CURRENT_DATE AND (b.date_to IS NULL OR b.date_to >= CURRENT_DATE) LIMIT 1) AS block
          FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN reservations r ON r.room_id=rm.id AND r.status='in_house' LEFT JOIN guests g ON g.id=r.guest_id
          WHERE rm.active ORDER BY rm.number` },
  { key: 'occupancy', dept: 'frontdesk', name: 'Occupancy & room rates', desc: 'Each night: rooms available, sold, occupancy, room revenue, ADR and RevPAR.', params: RANGE,
    cols: [['night', 'Night', 'date'], ['available', 'Available', 'int'], ['sold', 'Sold', 'int'], ['occ', 'Occupancy', 'pct'], ['revenue', 'Room revenue', 'money'], ['adr', 'ADR', 'money'], ['revpar', 'RevPAR', 'money']], sum: ['sold', 'revenue'],
    sql: `WITH d AS (SELECT generate_series(:from::date, :to::date, '1 day')::date AS night),
          x AS (SELECT d.night,
            (SELECT count(*) FROM rooms WHERE active) - (SELECT count(DISTINCT b.room_id) FROM room_blocks b WHERE b.kind='out_of_order' AND b.date_from <= d.night AND (b.date_to IS NULL OR b.date_to >= d.night) AND (b.released_at IS NULL OR b.released_at::date > d.night)) AS available,
            (SELECT count(*) FROM reservation_nights n JOIN reservations r ON r.id=n.reservation_id WHERE n.night=d.night AND r.status IN ('reserved','in_house','checked_out')) AS sold,
            (SELECT COALESCE(SUM(n.rate),0) FROM reservation_nights n JOIN reservations r ON r.id=n.reservation_id WHERE n.night=d.night AND r.status IN ('reserved','in_house','checked_out')) AS revenue FROM d)
          SELECT night, available, sold, CASE WHEN available > 0 THEN round(100.0*sold/available,1) END AS occ, revenue,
            CASE WHEN sold > 0 THEN round(revenue::numeric/sold) END AS adr, CASE WHEN available > 0 THEN round(revenue::numeric/available) END AS revpar FROM x ORDER BY night` },
  { key: 'pos_transfers', dept: 'frontdesk', name: 'Front desk POS bill transfers', desc: 'Restaurant, bar and spa bills charged to guest rooms.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['bill', 'Bill', 'text'], ['outlet', 'Outlet', 'text'], ['room', 'Room', 'text'], ['guest', 'Guest', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT p.business_date AS date, c.code AS bill, o.name AS outlet, rm.number AS room, ${GUEST} AS guest, p.amount
          FROM pos_payments p JOIN pos_checks c ON c.id=p.check_id JOIN outlets o ON o.id=c.outlet_id JOIN reservations r ON r.id=p.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id
          WHERE p.method='room' AND p.business_date BETWEEN :from AND :to ORDER BY p.business_date, c.code` },
  { key: 'discounts', dept: 'frontdesk', name: 'Discounts report', desc: 'Bookings sold below the room type\'s standard rate.', params: RANGE,
    cols: [['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['arrival', 'Arrival', 'date'], ['type', 'Room type', 'text'], ['rack', 'Standard', 'money'], ['rate', 'Sold at', 'money'], ['disc', 'Discount', 'pct'], ['plan', 'Rate plan', 'text'], ['source', 'Source', 'text']],
    sql: `SELECT r.code, ${GUEST} AS guest, r.arrival, rt.name AS type, rt.base_rate AS rack, r.rate, round(100.0*(rt.base_rate - r.rate)/NULLIF(rt.base_rate,0),1) AS disc, rp.name AS plan, r.source
          FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rate_plans rp ON rp.id=r.rate_plan_id
          WHERE r.arrival BETWEEN :from AND :to AND r.status <> 'cancelled' AND r.rate < rt.base_rate ORDER BY disc DESC` },
  { key: 'rooming_list', dept: 'frontdesk', name: 'Guest rooming list', desc: 'Everyone in the hotel now, by room.', params: [],
    cols: [['room', 'Room', 'text'], ['guest', 'Guest', 'text'], ['arrival', 'Arrived', 'date'], ['departure', 'Departs', 'date'], ['adults', 'Adults', 'int'], ['children', 'Children', 'int'], ['company', 'Company', 'text'], ['nationality', 'Nationality', 'text'], ['phone', 'Phone', 'text']], sum: ['adults', 'children'],
    sql: `SELECT rm.number AS room, ${GUEST} AS guest, r.arrival, r.departure, r.adults, r.children, r.company_name AS company, g.nationality, g.phone
          FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.status='in_house' ORDER BY rm.number` },
  { key: 'checkins', dept: 'frontdesk', name: 'Guest check-in report', desc: 'Guests checked in, with who checked them in and when.', params: RANGE,
    cols: [['at', 'Checked in', 'ts'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['room', 'Room', 'text'], ['departure', 'Departs', 'date'], ['source', 'Source', 'text'], ['rate', 'Rate', 'money']],
    sql: `SELECT r.checked_in_at AS at, r.code, ${GUEST} AS guest, rm.number AS room, r.departure, r.source, r.rate FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id
          WHERE r.checked_in_at::date BETWEEN :from AND :to ORDER BY r.checked_in_at` },
  { key: 'checkouts', dept: 'frontdesk', name: 'Guest check-out report', desc: 'Guests checked out with what they spent.', params: RANGE,
    cols: [['at', 'Checked out', 'ts'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['room', 'Room', 'text'], ['nights', 'Nights', 'int'], ['charges', 'Charges', 'money'], ['balance', 'Balance', 'money']], sum: ['nights', 'charges', 'balance'],
    sql: `SELECT r.checked_out_at AS at, r.code, ${GUEST} AS guest, rm.number AS room, ${NIGHTS} AS nights,
            COALESCE((SELECT SUM(amount) FROM folio_charges fc WHERE fc.reservation_id=r.id AND NOT fc.voided),0) AS charges, ${FOLIO_BAL} AS balance
          FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.checked_out_at::date BETWEEN :from AND :to ORDER BY r.checked_out_at` },
  { key: 'no_shows', dept: 'frontdesk', name: 'No-show report', desc: 'Bookings that never arrived.', params: RANGE,
    cols: [['arrival', 'Arrival', 'date'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['phone', 'Phone', 'text'], ['source', 'Source', 'text'], ['nights', 'Nights', 'int'], ['value', 'Value', 'money']], sum: ['nights', 'value'],
    sql: `SELECT r.arrival, r.code, ${GUEST} AS guest, g.phone, r.source, ${NIGHTS} AS nights, ${STAY_VALUE} AS value FROM reservations r JOIN guests g ON g.id=r.guest_id
          WHERE r.status='no_show' AND r.arrival BETWEEN :from AND :to ORDER BY r.arrival` },
  { key: 'collections', dept: 'frontdesk', name: 'Front desk collections', desc: 'Every payment taken on guest bills, by method and cashier.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['method', 'Method', 'text'], ['reference', 'Reference', 'text'], ['by', 'Taken by', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT p.business_date AS date, r.code, ${GUEST} AS guest, replace(p.method,'_',' ') AS method, p.reference, u.full_name AS by, p.amount
          FROM payments p JOIN reservations r ON r.id=p.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN users u ON u.id=p.posted_by
          WHERE NOT p.voided AND p.method <> 'ota_commission' AND p.business_date BETWEEN :from AND :to ORDER BY p.business_date, p.id` },
  { key: 'company_payments', dept: 'frontdesk', name: 'Client (company) payments', desc: 'Money received from companies against their account.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['number', 'Receipt', 'text'], ['company', 'Company', 'text'], ['account', 'Paid into', 'text'], ['reference', 'Reference', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT a.receipt_date AS date, a.number, c.name AS company, ac.name AS account, a.reference, a.amount FROM ar_receipts a JOIN companies c ON c.id=a.company_id LEFT JOIN accounts ac ON ac.code=a.account_code
          WHERE a.receipt_date BETWEEN :from AND :to ORDER BY a.receipt_date` },
  { key: 'guest_balances', dept: 'frontdesk', name: 'Client financial summary', desc: 'Every open guest bill: charges, payments and what is still owed.', params: [],
    cols: [['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['status', 'Status', 'text'], ['room', 'Room', 'text'], ['departure', 'Departs', 'date'], ['charges', 'Charges', 'money'], ['paid', 'Paid', 'money'], ['balance', 'Balance', 'money']], sum: ['charges', 'paid', 'balance'],
    sql: `SELECT * FROM (SELECT r.code, ${GUEST} AS guest, replace(r.status,'_',' ') AS status, rm.number AS room, r.departure,
            COALESCE((SELECT SUM(amount) FROM folio_charges fc WHERE fc.reservation_id=r.id AND NOT fc.voided),0) AS charges,
            COALESCE((SELECT SUM(amount) FROM payments p WHERE p.reservation_id=r.id AND NOT p.voided),0) AS paid, ${FOLIO_BAL} AS balance
          FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.status IN ('reserved','in_house','checked_out')) x
          WHERE balance <> 0 ORDER BY balance DESC` },
  { key: 'room_sales', dept: 'frontdesk', name: 'Room sales report', desc: 'Room charges posted to guest bills.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['room', 'Room', 'text'], ['description', 'Description', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT fc.business_date AS date, r.code, ${GUEST} AS guest, rm.number AS room, fc.description, fc.amount FROM folio_charges fc JOIN reservations r ON r.id=fc.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id
          WHERE fc.department='rooms' AND NOT fc.voided AND fc.business_date BETWEEN :from AND :to ORDER BY fc.business_date, rm.number` },
  { key: 'day_room_sales', dept: 'frontdesk', name: 'Summarised day room sales', desc: 'Room charges per day: rooms charged and revenue.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['rooms', 'Rooms charged', 'int'], ['revenue', 'Room revenue', 'money'], ['avg', 'Average rate', 'money']], sum: ['rooms', 'revenue'],
    sql: `SELECT fc.business_date AS date, count(*) AS rooms, SUM(fc.amount) AS revenue, round(AVG(fc.amount)) AS avg FROM folio_charges fc
          WHERE fc.department='rooms' AND NOT fc.voided AND fc.business_date BETWEEN :from AND :to GROUP BY fc.business_date ORDER BY fc.business_date` },
  { key: 'electronic_payments', dept: 'frontdesk', name: 'Electronic payments report', desc: 'Card, mobile money and bank payments on guest bills (for reconciling with statements).', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['method', 'Method', 'text'], ['detail', 'Details', 'text'], ['reference', 'Reference', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT p.business_date AS date, r.code, ${GUEST} AS guest, replace(p.method,'_',' ') AS method,
            concat_ws(' ', p.details->>'card_brand', CASE WHEN p.details->>'card_last4' IS NOT NULL THEN '••••' || (p.details->>'card_last4') END, p.details->>'network', p.details->>'momo_number', p.details->>'bank') AS detail, p.reference, p.amount
          FROM payments p JOIN reservations r ON r.id=p.reservation_id JOIN guests g ON g.id=r.guest_id
          WHERE NOT p.voided AND p.method IN ('card','mobile_money','bank_transfer') AND p.business_date BETWEEN :from AND :to ORDER BY p.method, p.business_date` },
  { key: 'additional_services', dept: 'frontdesk', name: 'Additional services sales', desc: 'Everything on guest bills other than the room: food, drinks, spa, events, extras.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['department', 'Department', 'text'], ['description', 'Description', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT fc.business_date AS date, r.code, ${GUEST} AS guest, fc.department, fc.description, fc.amount FROM folio_charges fc JOIN reservations r ON r.id=fc.reservation_id JOIN guests g ON g.id=r.guest_id
          WHERE fc.department <> 'rooms' AND NOT fc.voided AND fc.business_date BETWEEN :from AND :to ORDER BY fc.business_date` },
  { key: 'complimentary_rooms', dept: 'frontdesk', name: 'Complimentary report', desc: 'Stays given free of charge or marked complimentary.', params: RANGE,
    cols: [['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['arrival', 'Arrival', 'date'], ['nights', 'Nights', 'int'], ['type', 'Room type', 'text'], ['value', 'Standard value', 'money'], ['notes', 'Notes', 'text']], sum: ['nights', 'value'],
    sql: `SELECT r.code, ${GUEST} AS guest, r.arrival, ${NIGHTS} AS nights, rt.name AS type, rt.base_rate * ${NIGHTS} AS value, r.notes FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id
          WHERE (r.rate = 0 OR r.market_segment='complimentary') AND r.status <> 'cancelled' AND r.arrival <= :to AND r.departure > :from ORDER BY r.arrival` },
  { key: 'house_use', dept: 'frontdesk', name: 'House use report', desc: 'Rooms used by the hotel itself (staff, owners, inspections).', params: RANGE,
    cols: [['code', 'Booking', 'text'], ['guest', 'Used by', 'text'], ['arrival', 'From', 'date'], ['departure', 'To', 'date'], ['nights', 'Nights', 'int'], ['notes', 'Reason', 'text']], sum: ['nights'],
    sql: `SELECT r.code, ${GUEST} AS guest, r.arrival, r.departure, ${NIGHTS} AS nights, COALESCE(r.notes, r.purpose) AS notes FROM reservations r JOIN guests g ON g.id=r.guest_id
          WHERE (r.source ILIKE '%house%' OR r.notes ILIKE '%house use%') AND r.status <> 'cancelled' AND r.arrival <= :to AND r.departure > :from ORDER BY r.arrival` },
  { key: 'room_occupancy', dept: 'frontdesk', name: 'Room occupancy report', desc: 'Each room: nights sold, occupancy and revenue over the period.', params: RANGE,
    cols: [['room', 'Room', 'text'], ['type', 'Type', 'text'], ['nights', 'Nights sold', 'int'], ['occ', 'Occupancy', 'pct'], ['revenue', 'Revenue', 'money']], sum: ['nights', 'revenue'],
    sql: `SELECT rm.number AS room, rt.name AS type, count(n.night) AS nights, round(100.0*count(n.night)/(:to::date - :from::date + 1),1) AS occ, COALESCE(SUM(n.rate),0) AS revenue
          FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN reservations r ON r.room_id=rm.id AND r.status IN ('in_house','checked_out')
          LEFT JOIN reservation_nights n ON n.reservation_id=r.id AND n.night BETWEEN :from AND :to WHERE rm.active GROUP BY rm.number, rt.name ORDER BY nights DESC, rm.number` },
  { key: 'short_stays', dept: 'frontdesk', name: 'Short stay clients report', desc: 'One-night stays.', params: RANGE,
    cols: [['arrival', 'Night', 'date'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['room', 'Room', 'text'], ['source', 'Source', 'text'], ['rate', 'Rate', 'money']], sum: ['rate'],
    sql: `SELECT r.arrival, r.code, ${GUEST} AS guest, rm.number AS room, r.source, r.rate FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id
          WHERE r.departure - r.arrival = 1 AND r.status IN ('in_house','checked_out') AND r.arrival BETWEEN :from AND :to ORDER BY r.arrival` },
  { key: 'guest_list', dept: 'frontdesk', name: 'Guest list report', desc: 'Every guest who stayed in the period, with contacts.', params: RANGE,
    cols: [['guest', 'Guest', 'text'], ['phone', 'Phone', 'text'], ['email', 'Email', 'text'], ['nationality', 'Nationality', 'text'], ['stays', 'Stays', 'int'], ['last', 'Last arrival', 'date']], sum: ['stays'],
    sql: `SELECT ${GUEST} AS guest, g.phone, g.email, g.nationality, count(r.id) AS stays, max(r.arrival) AS last FROM guests g JOIN reservations r ON r.guest_id=g.id
          WHERE g.erased_at IS NULL AND r.status IN ('in_house','checked_out') AND r.arrival <= :to AND r.departure > :from GROUP BY g.id ORDER BY g.last_name, g.first_name` },
  { key: 'client_list', dept: 'frontdesk', name: 'Client (company) list report', desc: 'Company accounts with contacts, credit and terms.', params: [],
    cols: [['name', 'Company', 'text'], ['industry', 'Industry', 'text'], ['contact', 'Contact', 'text'], ['phone', 'Phone', 'text'], ['email', 'Email', 'text'], ['tin', 'TIN', 'text'], ['limit', 'Credit limit', 'money'], ['terms', 'Terms (days)', 'int'], ['disc', 'Room discount', 'pct']],
    sql: `SELECT name, industry, contact, phone, COALESCE(billing_email, email) AS email, tin, credit_limit AS "limit", terms_days AS terms, discount_pct AS disc FROM companies WHERE active ORDER BY name` },
  { key: 'guest_history', dept: 'frontdesk', name: 'Guest history report', desc: 'Guests ranked by nights and spend over the period.', params: RANGE,
    cols: [['guest', 'Guest', 'text'], ['stays', 'Stays', 'int'], ['nights', 'Nights', 'int'], ['spend', 'Spend', 'money'], ['first', 'First stay', 'date'], ['last', 'Last stay', 'date'], ['vip', 'VIP', 'text']], sum: ['stays', 'nights', 'spend'],
    sql: `SELECT ${GUEST} AS guest, count(r.id) AS stays, SUM(${NIGHTS}) AS nights, SUM(COALESCE((SELECT SUM(amount) FROM folio_charges fc WHERE fc.reservation_id=r.id AND NOT fc.voided),0)) AS spend,
            min(r.arrival) AS first, max(r.arrival) AS last, CASE WHEN g.vip THEN 'VIP' END AS vip
          FROM guests g JOIN reservations r ON r.guest_id=g.id WHERE r.status IN ('in_house','checked_out') AND r.arrival BETWEEN :from AND :to GROUP BY g.id ORDER BY spend DESC LIMIT 500` },
  { key: 'client_history', dept: 'frontdesk', name: 'Client history report', desc: 'What each company booked: stays, nights and value.', params: RANGE,
    cols: [['company', 'Company', 'text'], ['stays', 'Bookings', 'int'], ['nights', 'Nights', 'int'], ['value', 'Room value', 'money'], ['last', 'Last arrival', 'date']], sum: ['stays', 'nights', 'value'],
    sql: `SELECT COALESCE(c.name, r.company_name) AS company, count(*) AS stays, SUM(${NIGHTS}) AS nights, SUM(${STAY_VALUE}) AS value, max(r.arrival) AS last
          FROM reservations r LEFT JOIN companies c ON c.id=r.company_id WHERE COALESCE(c.name, r.company_name) IS NOT NULL AND r.status IN ('reserved','in_house','checked_out') AND r.arrival BETWEEN :from AND :to
          GROUP BY 1 ORDER BY value DESC` },
  { key: 'cancellations', dept: 'frontdesk', name: 'Cancelled reservations report', desc: 'Cancelled bookings with the reason and lost value.', params: RANGE,
    cols: [['arrival', 'Arrival', 'date'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['source', 'Source', 'text'], ['nights', 'Nights', 'int'], ['value', 'Value', 'money'], ['reason', 'Reason', 'text']], sum: ['nights', 'value'],
    sql: `SELECT r.arrival, r.code, ${GUEST} AS guest, r.source, ${NIGHTS} AS nights, ${STAY_VALUE} AS value, r.cancel_reason AS reason FROM reservations r JOIN guests g ON g.id=r.guest_id
          WHERE r.status='cancelled' AND r.arrival BETWEEN :from AND :to ORDER BY r.arrival` },
  { key: 'erased_guests', dept: 'frontdesk', name: 'Deleted guests report', desc: 'Guest records erased on request or merged into another (data protection log).', params: RANGE,
    cols: [['id', 'Guest no.', 'int'], ['what', 'What happened', 'text'], ['at', 'When', 'ts'], ['into', 'Merged into', 'int']],
    sql: `SELECT g.id, CASE WHEN g.erased_at IS NOT NULL THEN 'Erased on request' ELSE 'Merged (duplicate)' END AS what, COALESCE(g.erased_at, g.created_at) AS at, g.merged_into AS into
          FROM guests g WHERE (g.erased_at::date BETWEEN :from AND :to) OR (g.merged_into IS NOT NULL AND g.created_at::date <= :to) ORDER BY at DESC` },
  { key: 'arrivals', dept: 'frontdesk', name: 'Expected arrivals', desc: 'Bookings arriving in the period, with requests and deposits.', params: RANGE,
    cols: [['arrival', 'Arrival', 'date'], ['eta', 'ETA', 'time'], ['code', 'Booking', 'text'], ['guest', 'Guest', 'text'], ['type', 'Room type', 'text'], ['nights', 'Nights', 'int'], ['paid', 'Deposit', 'money'], ['requests', 'Requests', 'text']], sum: ['nights', 'paid'],
    sql: `SELECT r.arrival, r.eta, r.code, ${GUEST} AS guest, rt.name AS type, ${NIGHTS} AS nights, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.reservation_id=r.id AND NOT p.voided),0) AS paid, r.special_requests AS requests
          FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id WHERE r.status='reserved' AND r.arrival BETWEEN :from AND :to ORDER BY r.arrival, r.eta NULLS LAST` },
  { key: 'source_mix', dept: 'frontdesk', name: 'Bookings by source', desc: 'Where bookings came from: count, nights and value.', params: RANGE,
    cols: [['source', 'Source', 'text'], ['bookings', 'Bookings', 'int'], ['nights', 'Nights', 'int'], ['value', 'Value', 'money'], ['share', 'Share of value', 'pct']], sum: ['bookings', 'nights', 'value'],
    sql: `WITH x AS (SELECT COALESCE(r.source,'Unknown') AS source, count(*) AS bookings, SUM(${NIGHTS}) AS nights, SUM(${STAY_VALUE}) AS value FROM reservations r
            WHERE r.status IN ('reserved','in_house','checked_out') AND r.arrival BETWEEN :from AND :to GROUP BY 1)
          SELECT *, round(100.0*value/NULLIF(SUM(value) OVER (),0),1) AS share FROM x ORDER BY value DESC` },
  { key: 'nationality', dept: 'frontdesk', name: 'Guests by nationality', desc: 'Stays and nights by nationality (tourism statistics).', params: RANGE,
    cols: [['nationality', 'Nationality', 'text'], ['guests', 'Guests', 'int'], ['stays', 'Stays', 'int'], ['nights', 'Nights', 'int']], sum: ['guests', 'stays', 'nights'],
    sql: `SELECT COALESCE(NULLIF(g.nationality,''),'Not recorded') AS nationality, count(DISTINCT g.id) AS guests, count(*) AS stays, SUM(${NIGHTS}) AS nights FROM reservations r JOIN guests g ON g.id=r.guest_id
          WHERE r.status IN ('in_house','checked_out') AND r.arrival BETWEEN :from AND :to GROUP BY 1 ORDER BY nights DESC` },

  /* ============================ ACCOUNTS ============================ */
  { key: 'revenue_by_department', dept: 'accounts', name: 'Revenue by department', desc: 'Revenue posted each day to rooms, food & beverage, amenities, events and other (net of VAT).', params: RANGE,
    cols: [['date', 'Date', 'date'], ['rooms', 'Rooms', 'money'], ['fnb', 'Food & beverage', 'money'], ['amenities', 'Amenities', 'money'], ['events', 'Events', 'money'], ['other', 'Other', 'money'], ['total', 'Total', 'money']], sum: ['rooms', 'fnb', 'amenities', 'events', 'other', 'total'],
    sql: `SELECT je.business_date AS date,
            SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code='4000') AS rooms, SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code='4100') AS fnb,
            SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code='4200') AS amenities, SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code='4300') AS events,
            SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code IN ('4900','4920')) AS other, SUM(jl.credit - jl.debit) AS total
          FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code IN ('4000','4100','4200','4300','4900','4920') AND je.business_date BETWEEN :from AND :to
          GROUP BY je.business_date ORDER BY je.business_date` },
  { key: 'payments_by_method', dept: 'accounts', name: 'Takings by payment method', desc: 'All money taken (guest bills, restaurant & bar, spa, club), by method.', params: RANGE,
    cols: [['method', 'Method', 'text'], ['frontdesk', 'Front desk', 'money'], ['pos', 'POS', 'money'], ['wellness', 'Spa & club', 'money'], ['total', 'Total', 'money']], sum: ['frontdesk', 'pos', 'wellness', 'total'],
    sql: `WITH x AS (
            SELECT method, amount AS fd, 0 AS pos, 0 AS wl FROM payments WHERE NOT voided AND method NOT IN ('company_account','ota_commission') AND business_date BETWEEN :from AND :to
            UNION ALL SELECT method, 0, amount, 0 FROM pos_payments WHERE method <> 'room' AND business_date BETWEEN :from AND :to
            UNION ALL SELECT method, 0, 0, amount FROM club_payments WHERE method <> 'room' AND business_date BETWEEN :from AND :to
            UNION ALL SELECT ab.settled_by, 0, 0, ab.qty*ab.unit_price FROM amenity_bookings ab WHERE ab.status='completed' AND ab.settled_by <> 'room' AND ab.completed_at::date BETWEEN :from AND :to)
          SELECT replace(method,'_',' ') AS method, SUM(fd) AS frontdesk, SUM(pos) AS pos, SUM(wl) AS wellness, SUM(fd + pos + wl) AS total FROM x GROUP BY method ORDER BY total DESC` },
  { key: 'voids', dept: 'accounts', name: 'Voids & corrections', desc: 'Every voided charge, payment and POS item, with who and why.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['what', 'What', 'text'], ['ref', 'Reference', 'text'], ['description', 'Description', 'text'], ['amount', 'Amount', 'money'], ['by', 'Voided by', 'text'], ['reason', 'Reason', 'text']], sum: ['amount'],
    sql: `SELECT * FROM (
            SELECT fc.business_date AS date, 'Charge' AS what, r.code AS ref, fc.description, fc.amount, u.full_name AS by, fc.void_reason AS reason FROM folio_charges fc JOIN reservations r ON r.id=fc.reservation_id LEFT JOIN users u ON u.id=fc.voided_by WHERE fc.voided AND fc.business_date BETWEEN :from AND :to
            UNION ALL SELECT p.business_date, 'Payment', r.code, replace(p.method,'_',' '), p.amount, u.full_name, p.void_reason FROM payments p JOIN reservations r ON r.id=p.reservation_id LEFT JOIN users u ON u.id=p.voided_by WHERE p.voided AND p.business_date BETWEEN :from AND :to
            UNION ALL SELECT c.business_date, 'POS item', c.code, l.qty || ' × ' || l.name, l.qty*l.unit_price, u.full_name, l.void_reason FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id LEFT JOIN users u ON u.id=l.voided_by WHERE l.status='voided' AND c.business_date BETWEEN :from AND :to
          ) x ORDER BY date, what` },
  { key: 'company_aging', dept: 'accounts', name: 'Company accounts aging', desc: 'What companies owe on issued invoices, by how overdue.', params: [],
    cols: [['company', 'Company', 'text'], ['current', 'Not yet due', 'money'], ['d30', '1–30 days', 'money'], ['d60', '31–60 days', 'money'], ['d90', '61–90 days', 'money'], ['over', 'Over 90 days', 'money'], ['total', 'Total', 'money']], sum: ['current', 'd30', 'd60', 'd90', 'over', 'total'],
    sql: `WITH o AS (SELECT c.name, i.due_date, i.total - COALESCE((SELECT SUM(a.amount) FROM ar_allocations a WHERE a.invoice_id=i.id),0) AS open FROM invoices i JOIN companies c ON c.id=i.company_id WHERE i.status='issued')
          SELECT name AS company, SUM(open) FILTER (WHERE due_date >= CURRENT_DATE) AS current, SUM(open) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 1 AND 30) AS d30,
            SUM(open) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 31 AND 60) AS d60, SUM(open) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 61 AND 90) AS d90,
            SUM(open) FILTER (WHERE CURRENT_DATE - due_date > 90) AS over, SUM(open) AS total FROM o WHERE open > 0 GROUP BY name ORDER BY total DESC` },
  { key: 'supplier_balances', dept: 'accounts', name: 'Supplier balances', desc: 'Unpaid supplier bills and when they are due.', params: [],
    cols: [['supplier', 'Supplier', 'text'], ['bill', 'Bill', 'text'], ['date', 'Date', 'date'], ['due', 'Due', 'date'], ['total', 'Bill total', 'money'], ['open', 'Still owed', 'money']], sum: ['total', 'open'],
    sql: `SELECT * FROM (SELECT s.name AS supplier, b.bill_number AS bill, b.bill_date AS date, b.due_date AS due, b.total, b.total - COALESCE((SELECT SUM(a.amount) FROM ap_allocations a WHERE a.bill_id=b.id),0) AS open
          FROM supplier_bills b JOIN suppliers s ON s.id=b.supplier_id WHERE b.status <> 'void') x WHERE open > 0 ORDER BY due NULLS LAST` },
  { key: 'expenses', dept: 'accounts', name: 'Expenses by account', desc: 'Expenses paid, by expense account.', params: RANGE,
    cols: [['account', 'Account', 'text'], ['count', 'Entries', 'int'], ['net', 'Net', 'money'], ['vat', 'VAT', 'money'], ['amount', 'Total', 'money']], sum: ['count', 'net', 'vat', 'amount'],
    sql: `SELECT e.account_code || ' ' || a.name AS account, count(*) AS count, SUM(e.amount - e.vat) AS net, SUM(e.vat) AS vat, SUM(e.amount) AS amount FROM expenses e JOIN accounts a ON a.code=e.account_code
          WHERE e.expense_date BETWEEN :from AND :to GROUP BY 1 ORDER BY amount DESC` },
  { key: 'vat', dept: 'accounts', name: 'VAT summary', desc: 'VAT collected on sales and VAT paid on purchases and expenses.', params: RANGE,
    cols: [['month', 'Month', 'text'], ['output', 'VAT on sales', 'money'], ['input', 'VAT on purchases', 'money'], ['net', 'Net payable', 'money']], sum: ['output', 'input', 'net'],
    sql: `SELECT to_char(je.business_date,'YYYY-MM') AS month, SUM(jl.credit) AS output, SUM(jl.debit) AS input, SUM(jl.credit - jl.debit) AS net
          FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='2100' AND je.business_date BETWEEN :from AND :to GROUP BY 1 ORDER BY 1` },
  { key: 'trial_balance', dept: 'accounts', name: 'Trial balance', desc: 'Every account\'s balance at the end of the period.', params: RANGE,
    cols: [['account', 'Account', 'text'], ['type', 'Type', 'text'], ['debit', 'Debit', 'money'], ['credit', 'Credit', 'money']], sum: ['debit', 'credit'],
    sql: `SELECT a.code || ' ' || a.name AS account, a.type, GREATEST(SUM(jl.debit - jl.credit),0) AS debit, GREATEST(SUM(jl.credit - jl.debit),0) AS credit
          FROM accounts a JOIN journal_lines jl ON jl.account_code=a.code JOIN journal_entries je ON je.id=jl.entry_id WHERE je.business_date <= :to
          GROUP BY a.code, a.name, a.type HAVING SUM(jl.debit - jl.credit) <> 0 ORDER BY a.code` },
  { key: 'ota_commission', dept: 'accounts', name: 'OTA commission', desc: 'Commission accrued per channel for the nights in the period.', params: RANGE,
    cols: [['source', 'Channel', 'text'], ['nights', 'Nights', 'int'], ['revenue', 'Room revenue', 'money'], ['commission', 'Commission', 'money']], sum: ['nights', 'revenue', 'commission'],
    sql: `SELECT r.source, count(*) AS nights, SUM(n.rate) AS revenue, round(SUM(n.rate * COALESCE(r.commission_pct,0) / 100)) AS commission FROM reservation_nights n JOIN reservations r ON r.id=n.reservation_id
          WHERE r.channel_id IS NOT NULL AND r.status IN ('in_house','checked_out') AND n.night BETWEEN :from AND :to GROUP BY r.source ORDER BY commission DESC` },
  { key: 'cash_book', dept: 'accounts', name: 'Cash & bank book', desc: 'Money in and out of each cash, mobile money and bank account.', params: RANGE,
    cols: [['account', 'Account', 'text'], ['opening', 'Opening', 'money'], ['in', 'In', 'money'], ['out', 'Out', 'money'], ['closing', 'Closing', 'money']], sum: ['in', 'out'],
    sql: `SELECT a.code || ' ' || a.name AS account,
            COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE je.business_date < :from),0) AS opening,
            COALESCE(SUM(jl.debit) FILTER (WHERE je.business_date BETWEEN :from AND :to),0) AS "in", COALESCE(SUM(jl.credit) FILTER (WHERE je.business_date BETWEEN :from AND :to),0) AS out,
            COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE je.business_date <= :to),0) AS closing
          FROM accounts a LEFT JOIN journal_lines jl ON jl.account_code=a.code LEFT JOIN journal_entries je ON je.id=jl.entry_id WHERE a.is_cash GROUP BY a.code, a.name ORDER BY a.code` },

  /* ============================ STORES ============================ */
  { key: 'stock_on_hand', dept: 'stores', name: 'Stock on hand', desc: 'Quantity and value of every item in every store.', params: [],
    cols: [['item', 'Item', 'text'], ['category', 'Category', 'text'], ['store', 'Store', 'text'], ['qty', 'Quantity', 'num'], ['unit', 'Unit', 'text'], ['cost', 'Avg cost', 'money'], ['value', 'Value', 'money']], sum: ['value'],
    sql: `SELECT i.name AS item, i.category, s.name AS store, b.qty, i.unit, round(i.avg_cost) AS cost, round(b.qty * i.avg_cost) AS value FROM stock_balances b JOIN stock_items i ON i.id=b.item_id JOIN stores s ON s.id=b.store_id
          WHERE b.qty <> 0 ORDER BY s.name, i.category, i.name` },
  { key: 'low_stock', dept: 'stores', name: 'Items running low', desc: 'Items at or below their reorder level across all stores.', params: [],
    cols: [['item', 'Item', 'text'], ['category', 'Category', 'text'], ['qty', 'On hand', 'num'], ['reorder', 'Reorder level', 'num'], ['unit', 'Unit', 'text']],
    sql: `SELECT i.name AS item, i.category, COALESCE(SUM(b.qty),0) AS qty, i.reorder_level AS reorder, i.unit FROM stock_items i LEFT JOIN stock_balances b ON b.item_id=i.id
          WHERE i.active GROUP BY i.id HAVING COALESCE(SUM(b.qty),0) <= i.reorder_level AND i.reorder_level > 0 ORDER BY COALESCE(SUM(b.qty),0) / NULLIF(i.reorder_level,0)` },
  { key: 'stock_movements', dept: 'stores', name: 'Stock movements', desc: 'Every receipt, issue, sale, transfer, count and write-off.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['item', 'Item', 'text'], ['store', 'Store', 'text'], ['kind', 'Movement', 'text'], ['qty', 'Quantity', 'num'], ['value', 'Value', 'money'], ['note', 'Note', 'text'], ['by', 'By', 'text']], sum: ['value'],
    sql: `SELECT m.business_date AS date, i.name AS item, s.name AS store, replace(m.kind,'_',' ') AS kind, m.qty, round(m.qty * m.unit_cost) AS value, m.note, u.full_name AS by
          FROM stock_movements m JOIN stock_items i ON i.id=m.item_id JOIN stores s ON s.id=m.store_id LEFT JOIN users u ON u.id=m.user_id WHERE m.business_date BETWEEN :from AND :to ORDER BY m.id` },
  { key: 'purchases_by_supplier', dept: 'stores', name: 'Purchases by supplier', desc: 'Goods received from each supplier.', params: RANGE,
    cols: [['supplier', 'Supplier', 'text'], ['deliveries', 'Deliveries', 'int'], ['total', 'Value', 'money']], sum: ['deliveries', 'total'],
    sql: `SELECT COALESCE(s.name,'Opening stock') AS supplier, count(*) AS deliveries, SUM(g.total) AS total FROM goods_received g LEFT JOIN suppliers s ON s.id=g.supplier_id
          WHERE g.business_date BETWEEN :from AND :to GROUP BY 1 ORDER BY total DESC` },
  { key: 'purchase_orders', dept: 'stores', name: 'Purchase orders', desc: 'Orders raised, approved, received or late.', params: RANGE,
    cols: [['code', 'Order', 'text'], ['supplier', 'Supplier', 'text'], ['store', 'Store', 'text'], ['status', 'Status', 'text'], ['expected', 'Expected', 'date'], ['value', 'Value', 'money'], ['received', 'Received', 'pct']], sum: ['value'],
    sql: `SELECT po.code, s.name AS supplier, st.name AS store, replace(po.status,'_',' ') AS status, po.expected_date AS expected, round(SUM(l.qty * l.unit_cost)) AS value, round(100 * SUM(l.received_qty) / NULLIF(SUM(l.qty),0)) AS received
          FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN stores st ON st.id=po.store_id LEFT JOIN purchase_order_lines l ON l.po_id=po.id
          WHERE po.created_at::date BETWEEN :from AND :to GROUP BY po.id, s.name, st.name ORDER BY po.id DESC` },
  { key: 'requisitions', dept: 'stores', name: 'Departmental requisitions', desc: 'What each department asked for and was issued.', params: RANGE,
    cols: [['code', 'Requisition', 'text'], ['date', 'Date', 'date'], ['department', 'Department', 'text'], ['status', 'Status', 'text'], ['by', 'Requested by', 'text'], ['cost', 'Issued value', 'money']], sum: ['cost'],
    sql: `SELECT q.code, q.business_date AS date, q.department, q.status, u.full_name AS by, q.total_cost AS cost FROM requisitions q LEFT JOIN users u ON u.id=q.requested_by
          WHERE q.business_date BETWEEN :from AND :to ORDER BY q.id DESC` },
  { key: 'issues_by_department', dept: 'stores', name: 'Issues by department', desc: 'Value of stock issued to each department.', params: RANGE,
    cols: [['department', 'Department', 'text'], ['requisitions', 'Requisitions', 'int'], ['cost', 'Value issued', 'money']], sum: ['requisitions', 'cost'],
    sql: `SELECT department, count(*) AS requisitions, SUM(total_cost) AS cost FROM requisitions WHERE status='issued' AND business_date BETWEEN :from AND :to GROUP BY department ORDER BY cost DESC` },
  { key: 'count_variances', dept: 'stores', name: 'Stock count variances', desc: 'Differences found in stock counts.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['store', 'Store', 'text'], ['item', 'Item', 'text'], ['expected', 'Expected', 'num'], ['counted', 'Counted', 'num'], ['diff', 'Difference', 'num'], ['value', 'Value', 'money']], sum: ['value'],
    sql: `SELECT c.business_date AS date, s.name AS store, i.name AS item, l.expected_qty AS expected, l.counted_qty AS counted, l.counted_qty - l.expected_qty AS diff, round((l.counted_qty - l.expected_qty) * i.avg_cost) AS value
          FROM stock_counts c JOIN stores s ON s.id=c.store_id JOIN stock_count_lines l ON l.count_id=c.id JOIN stock_items i ON i.id=l.item_id
          WHERE c.status='posted' AND c.business_date BETWEEN :from AND :to AND l.counted_qty IS NOT NULL AND l.counted_qty <> l.expected_qty ORDER BY c.business_date, value` },
  { key: 'write_offs', dept: 'stores', name: 'Write-offs & wastage', desc: 'Stock written off, with the reason.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['item', 'Item', 'text'], ['store', 'Store', 'text'], ['qty', 'Quantity', 'num'], ['value', 'Value', 'money'], ['note', 'Reason', 'text']], sum: ['value'],
    sql: `SELECT m.business_date AS date, i.name AS item, s.name AS store, -m.qty AS qty, round(-m.qty * m.unit_cost) AS value, m.note FROM stock_movements m JOIN stock_items i ON i.id=m.item_id JOIN stores s ON s.id=m.store_id
          WHERE m.kind='write_off' AND m.business_date BETWEEN :from AND :to ORDER BY m.business_date` },
  { key: 'consumption', dept: 'stores', name: 'Item consumption', desc: 'How much of each item was used (sold through recipes or issued).', params: RANGE,
    cols: [['item', 'Item', 'text'], ['unit', 'Unit', 'text'], ['sold', 'Used in sales', 'num'], ['issued', 'Issued', 'num'], ['value', 'Value', 'money']], sum: ['value'],
    sql: `SELECT i.name AS item, i.unit, -COALESCE(SUM(m.qty) FILTER (WHERE m.kind='sale'),0) AS sold, -COALESCE(SUM(m.qty) FILTER (WHERE m.kind='issue'),0) AS issued, round(-SUM(m.qty * m.unit_cost)) AS value
          FROM stock_movements m JOIN stock_items i ON i.id=m.item_id WHERE m.kind IN ('sale','issue') AND m.business_date BETWEEN :from AND :to GROUP BY i.id ORDER BY value DESC` },

  /* ============================ EVENTS ============================ */
  { key: 'event_list', dept: 'events', name: 'Events report', desc: 'Every event in the period with its value.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Event', 'text'], ['title', 'Title', 'text'], ['type', 'Type', 'text'], ['room', 'Function room', 'text'], ['pax', 'Guests', 'int'], ['status', 'Status', 'text'], ['value', 'Value', 'money']], sum: ['pax', 'value'],
    sql: `SELECT e.event_date AS date, e.code, e.title, e.event_type AS type, fr.name AS room, e.pax, e.status,
            e.per_person * e.pax + e.room_hire + COALESCE((SELECT SUM(x.qty*x.unit_price) FROM event_extras x WHERE x.event_id=e.id),0) AS value
          FROM events e LEFT JOIN function_rooms fr ON fr.id=e.function_room_id WHERE e.event_date BETWEEN :from AND :to ORDER BY e.event_date, e.start_time` },
  { key: 'event_services', dept: 'events', name: 'Event services', desc: 'Extras sold with events (décor, equipment, printing …).', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Event', 'text'], ['description', 'Service', 'text'], ['qty', 'Qty', 'int'], ['price', 'Price', 'money'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT e.event_date AS date, e.code, x.description, x.qty, x.unit_price AS price, x.qty*x.unit_price AS amount FROM event_extras x JOIN events e ON e.id=x.event_id
          WHERE e.event_date BETWEEN :from AND :to AND e.status <> 'cancelled' ORDER BY e.event_date` },
  { key: 'event_collections', dept: 'events', name: 'Event collections report', desc: 'Deposits and payments received for events.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Event', 'text'], ['title', 'Title', 'text'], ['kind', 'Kind', 'text'], ['account', 'Paid into', 'text'], ['reference', 'Reference', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT p.business_date AS date, e.code, e.title, p.kind, a.name AS account, p.reference, CASE WHEN p.kind='deposit' THEN p.amount ELSE -p.amount END AS amount
          FROM event_payments p JOIN events e ON e.id=p.event_id LEFT JOIN accounts a ON a.code=p.account_code WHERE p.business_date BETWEEN :from AND :to ORDER BY p.business_date` },
  { key: 'event_financial', dept: 'events', name: 'Event financial summary', desc: 'Per event: value, deposits received and balance.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Event', 'text'], ['client', 'Client', 'text'], ['value', 'Value', 'money'], ['deposits', 'Deposits', 'money'], ['balance', 'Balance', 'money'], ['status', 'Status', 'text']], sum: ['value', 'deposits', 'balance'],
    sql: `SELECT date, code, client, value, deposits, value - deposits AS balance, status FROM (SELECT e.event_date AS date, e.code, COALESCE(c.name, e.contact_name) AS client, e.status,
            e.per_person * e.pax + e.room_hire + COALESCE((SELECT SUM(x.qty*x.unit_price) FROM event_extras x WHERE x.event_id=e.id),0) AS value,
            COALESCE((SELECT SUM(CASE WHEN p.kind='deposit' THEN p.amount ELSE -p.amount END) FROM event_payments p WHERE p.event_id=e.id),0) AS deposits
          FROM events e LEFT JOIN companies c ON c.id=e.company_id WHERE e.event_date BETWEEN :from AND :to AND e.status <> 'cancelled') x ORDER BY date` },
  { key: 'cancelled_events', dept: 'events', name: 'Cancelled events report', desc: 'Events cancelled, with the reason.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['code', 'Event', 'text'], ['title', 'Title', 'text'], ['client', 'Client', 'text'], ['pax', 'Guests', 'int'], ['reason', 'Reason', 'text']], sum: ['pax'],
    sql: `SELECT e.event_date AS date, e.code, e.title, COALESCE(c.name, e.contact_name) AS client, e.pax, e.cancel_reason AS reason FROM events e LEFT JOIN companies c ON c.id=e.company_id
          WHERE e.status='cancelled' AND e.event_date BETWEEN :from AND :to ORDER BY e.event_date` },
  { key: 'function_rooms', dept: 'events', name: 'Function room usage', desc: 'How often each function room was used and what it earned.', params: RANGE,
    cols: [['room', 'Function room', 'text'], ['events', 'Events', 'int'], ['days', 'Days used', 'int'], ['pax', 'Guests', 'int'], ['hire', 'Room hire', 'money']], sum: ['events', 'pax', 'hire'],
    sql: `SELECT fr.name AS room, count(e.id) AS events, count(DISTINCT e.event_date) AS days, COALESCE(SUM(e.pax),0) AS pax, COALESCE(SUM(e.room_hire),0) AS hire FROM function_rooms fr
          LEFT JOIN events e ON e.function_room_id=fr.id AND e.status IN ('confirmed','completed') AND e.event_date BETWEEN :from AND :to GROUP BY fr.id ORDER BY events DESC` },
  { key: 'event_clients', dept: 'events', name: 'Event clients report', desc: 'Who books events: number, guests and value.', params: RANGE,
    cols: [['client', 'Client', 'text'], ['events', 'Events', 'int'], ['pax', 'Guests', 'int'], ['value', 'Value', 'money']], sum: ['events', 'pax', 'value'],
    sql: `SELECT COALESCE(c.name, e.contact_name) AS client, count(*) AS events, SUM(e.pax) AS pax, SUM(e.per_person * e.pax + e.room_hire) AS value FROM events e LEFT JOIN companies c ON c.id=e.company_id
          WHERE e.status IN ('confirmed','completed') AND e.event_date BETWEEN :from AND :to GROUP BY 1 ORDER BY value DESC` },

  /* ============================ POINT OF SALE ============================ */
  { key: 'pos_payment_mode', dept: 'pos', name: 'POS payment mode', desc: 'Restaurant, bar, spa and club sales by payment method.', params: RANGE, outlet: true,
    cols: [['method', 'Method', 'text'], ['bills', 'Bills', 'int'], ['amount', 'Amount', 'money']], sum: ['bills', 'amount'],
    sql: `SELECT CASE p.method WHEN 'room' THEN 'charged to room' ELSE replace(p.method,'_',' ') END AS method, count(DISTINCT p.check_id) AS bills, SUM(p.amount) AS amount
          FROM pos_payments p JOIN pos_checks c ON c.id=p.check_id WHERE p.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY 1 ORDER BY amount DESC` },
  { key: 'pos_bill_transfers', dept: 'pos', name: 'POS bill transfers', desc: 'Bills charged to rooms (by room and guest).', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['bill', 'Bill', 'text'], ['outlet', 'Outlet', 'text'], ['room', 'Room', 'text'], ['guest', 'Guest', 'text'], ['waiter', 'Waiter', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT p.business_date AS date, c.code AS bill, o.name AS outlet, rm.number AS room, ${GUEST} AS guest, w.full_name AS waiter, p.amount
          FROM pos_payments p JOIN pos_checks c ON c.id=p.check_id JOIN outlets o ON o.id=c.outlet_id JOIN reservations r ON r.id=p.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN users w ON w.id=c.waiter_id
          WHERE p.method='room' AND p.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY p.business_date, c.code` },
  { key: 'pos_sales_summary', dept: 'pos', name: 'POS sales summary', desc: 'Per outlet per day: bills, covers, sales before and after discounts.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['outlet', 'Outlet', 'text'], ['bills', 'Bills', 'int'], ['covers', 'Covers', 'int'], ['gross', 'Sales', 'money'], ['discount', 'Discounts', 'money'], ['net', 'Net sales', 'money'], ['per_cover', 'Per cover', 'money']], sum: ['bills', 'covers', 'gross', 'discount', 'net'],
    sql: `SELECT c.business_date AS date, o.name AS outlet, count(*) AS bills, SUM(c.covers) AS covers, SUM(${POS_GROSS}) AS gross, SUM(c.discount_amount) AS discount, SUM(${POS_NET}) AS net, round(SUM(${POS_NET})::numeric / NULLIF(SUM(c.covers),0)) AS per_cover
          FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id WHERE c.status='settled' AND c.settle_kind='sale' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY 1, 2 ORDER BY 1, 2` },
  { key: 'item_sales', dept: 'pos', name: 'Item sales report', desc: 'How many of each item sold, and for how much.', params: RANGE, outlet: true,
    cols: [['item', 'Item', 'text'], ['category', 'Category', 'text'], ['qty', 'Qty', 'int'], ['amount', 'Amount', 'money'], ['avg', 'Average price', 'money']], sum: ['qty', 'amount'],
    sql: `SELECT l.name AS item, mc.name AS category, SUM(l.qty) AS qty, SUM(l.qty*l.unit_price) AS amount, round(SUM(l.qty*l.unit_price)::numeric / NULLIF(SUM(l.qty),0)) AS avg
          FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id LEFT JOIN menu_items mi ON mi.id=l.item_id LEFT JOIN menu_categories mc ON mc.id=mi.category_id
          WHERE c.status='settled' AND c.settle_kind='sale' AND l.status <> 'voided' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY l.name, mc.name ORDER BY amount DESC` },
  { key: 'pos_cash_sales', dept: 'pos', name: 'Cash sales report', desc: 'Bills paid in cash, with cashier.', params: RANGE, outlet: true,
    cols: [['at', 'Paid', 'ts'], ['bill', 'Bill', 'text'], ['outlet', 'Outlet', 'text'], ['cashier', 'Cashier', 'text'], ['amount', 'Cash', 'money']], sum: ['amount'],
    sql: `SELECT p.posted_at AS at, c.code AS bill, o.name AS outlet, u.full_name AS cashier, p.amount FROM pos_payments p JOIN pos_checks c ON c.id=p.check_id JOIN outlets o ON o.id=c.outlet_id LEFT JOIN users u ON u.id=p.posted_by
          WHERE p.method='cash' AND p.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY p.posted_at` },
  { key: 'pos_credit_sales', dept: 'pos', name: 'Credit sales', desc: 'Sales not paid at the time: charged to guest rooms (settled at check-out).', params: RANGE, outlet: true,
    cols: [['room', 'Room', 'text'], ['guest', 'Guest', 'text'], ['bills', 'Bills', 'int'], ['amount', 'Amount', 'money'], ['status', 'Stay', 'text']], sum: ['bills', 'amount'],
    sql: `SELECT rm.number AS room, ${GUEST} AS guest, count(*) AS bills, SUM(p.amount) AS amount, replace(r.status,'_',' ') AS status FROM pos_payments p JOIN pos_checks c ON c.id=p.check_id JOIN reservations r ON r.id=p.reservation_id
          JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE p.method='room' AND p.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY rm.number, g.id, r.status ORDER BY amount DESC` },
  { key: 'pos_card_sales', dept: 'pos', name: 'Card & mobile money sales', desc: 'POS payments by card and mobile money, with references.', params: RANGE, outlet: true,
    cols: [['at', 'Paid', 'ts'], ['bill', 'Bill', 'text'], ['outlet', 'Outlet', 'text'], ['method', 'Method', 'text'], ['reference', 'Reference', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT p.posted_at AS at, c.code AS bill, o.name AS outlet, replace(p.method,'_',' ') AS method, p.reference, p.amount FROM pos_payments p JOIN pos_checks c ON c.id=p.check_id JOIN outlets o ON o.id=c.outlet_id
          WHERE p.method IN ('card','mobile_money') AND p.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY p.method, p.posted_at` },
  { key: 'pos_discounts', dept: 'pos', name: 'POS discounts', desc: 'Bills discounted, by whom and why.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['bill', 'Bill', 'text'], ['outlet', 'Outlet', 'text'], ['gross', 'Before discount', 'money'], ['discount', 'Discount', 'money'], ['pct', '%', 'pct'], ['by', 'Given by', 'text'], ['reason', 'Reason', 'text']], sum: ['gross', 'discount'],
    sql: `SELECT c.business_date AS date, c.code AS bill, o.name AS outlet, ${POS_GROSS} AS gross, c.discount_amount AS discount, round(100.0 * c.discount_amount / NULLIF(${POS_GROSS},0),1) AS pct, u.full_name AS by, c.discount_reason AS reason
          FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id LEFT JOIN users u ON u.id=c.discount_by WHERE c.discount_amount > 0 AND c.status='settled' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY c.business_date` },
  { key: 'pos_house_use', dept: 'pos', name: 'POS house use report', desc: 'Food and drink used by the hotel (staff meals, tastings), at selling value and cost.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['bill', 'Bill', 'text'], ['outlet', 'Outlet', 'text'], ['value', 'Selling value', 'money'], ['cost', 'Cost', 'money'], ['by', 'Approved by', 'text'], ['reason', 'Reason', 'text']], sum: ['value', 'cost'],
    sql: `SELECT c.business_date AS date, c.code AS bill, o.name AS outlet, ${POS_GROSS} AS value, c.cost_of_sales AS cost, u.full_name AS by, c.settle_reason AS reason
          FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id LEFT JOIN users u ON u.id=c.settled_by WHERE c.settle_kind='house_use' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY c.business_date` },
  { key: 'pos_complimentary', dept: 'pos', name: 'POS complimentary report', desc: 'Food and drink given free to guests, at selling value and cost.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['bill', 'Bill', 'text'], ['outlet', 'Outlet', 'text'], ['value', 'Selling value', 'money'], ['cost', 'Cost', 'money'], ['by', 'Approved by', 'text'], ['reason', 'Reason', 'text']], sum: ['value', 'cost'],
    sql: `SELECT c.business_date AS date, c.code AS bill, o.name AS outlet, ${POS_GROSS} AS value, c.cost_of_sales AS cost, u.full_name AS by, c.settle_reason AS reason
          FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id LEFT JOIN users u ON u.id=c.settled_by WHERE c.settle_kind='complimentary' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY c.business_date` },
  { key: 'sales_costing', dept: 'pos', name: 'Sales costing report', desc: 'Net sales against recipe cost: food & beverage cost %.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['outlet', 'Outlet', 'text'], ['net', 'Net sales', 'money'], ['cost', 'Cost of sales', 'money'], ['cost_pct', 'Cost %', 'pct'], ['margin', 'Gross margin', 'money']], sum: ['net', 'cost', 'margin'],
    sql: `SELECT c.business_date AS date, o.name AS outlet, SUM(${POS_NET}) AS net, COALESCE(SUM(c.cost_of_sales),0) AS cost, round(100.0*COALESCE(SUM(c.cost_of_sales),0)/NULLIF(SUM(${POS_NET}),0),1) AS cost_pct, SUM(${POS_NET}) - COALESCE(SUM(c.cost_of_sales),0) AS margin
          FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id WHERE c.status='settled' AND c.settle_kind='sale' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY 1, 2 ORDER BY 1, 2` },
  { key: 'pos_close_day', dept: 'pos', name: 'POS close day report', desc: 'The day\'s close per outlet: sales by method, comps, voids and open bills.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['outlet', 'Outlet', 'text'], ['bills', 'Bills', 'int'], ['cash', 'Cash', 'money'], ['card', 'Card', 'money'], ['momo', 'Mobile money', 'money'], ['room', 'To rooms', 'money'], ['comp', 'Comp & house', 'money'], ['voids', 'Voided items', 'money'], ['open', 'Still open', 'int']], sum: ['bills', 'cash', 'card', 'momo', 'room', 'comp', 'voids', 'open'],
    sql: `SELECT c.business_date AS date, o.name AS outlet, count(*) FILTER (WHERE c.status='settled') AS bills,
            COALESCE((SELECT SUM(p.amount) FROM pos_payments p JOIN pos_checks c2 ON c2.id=p.check_id WHERE c2.outlet_id=o.id AND p.business_date=c.business_date AND p.method='cash'),0) AS cash,
            COALESCE((SELECT SUM(p.amount) FROM pos_payments p JOIN pos_checks c2 ON c2.id=p.check_id WHERE c2.outlet_id=o.id AND p.business_date=c.business_date AND p.method='card'),0) AS card,
            COALESCE((SELECT SUM(p.amount) FROM pos_payments p JOIN pos_checks c2 ON c2.id=p.check_id WHERE c2.outlet_id=o.id AND p.business_date=c.business_date AND p.method='mobile_money'),0) AS momo,
            COALESCE((SELECT SUM(p.amount) FROM pos_payments p JOIN pos_checks c2 ON c2.id=p.check_id WHERE c2.outlet_id=o.id AND p.business_date=c.business_date AND p.method='room'),0) AS room,
            COALESCE(SUM(${POS_GROSS}) FILTER (WHERE c.settle_kind <> 'sale'),0) AS comp,
            COALESCE((SELECT SUM(l.qty*l.unit_price) FROM pos_check_lines l JOIN pos_checks c3 ON c3.id=l.check_id WHERE c3.outlet_id=o.id AND c3.business_date=c.business_date AND l.status='voided'),0) AS voids,
            count(*) FILTER (WHERE c.status='open') AS open
          FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id WHERE c.business_date BETWEEN :from AND :to AND c.status IN ('settled','open') AND ${OUTLET} GROUP BY c.business_date, o.id ORDER BY 1, 2` },
  { key: 'cashier_summary', dept: 'pos', name: 'POS cashier daily sales summary', desc: 'Each cashier shift: takings by method, expected and counted cash.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['cashier', 'Cashier', 'text'], ['outlet', 'Outlet', 'text'], ['cash', 'Cash', 'money'], ['card', 'Card', 'money'], ['momo', 'Mobile money', 'money'], ['room', 'To rooms', 'money'], ['expected', 'Expected cash', 'money'], ['counted', 'Counted', 'money'], ['variance', 'Over / short', 'money']], sum: ['cash', 'card', 'momo', 'room', 'variance'],
    sql: `SELECT s.business_date AS date, u.full_name AS cashier, o.name AS outlet,
            COALESCE(SUM(p.amount) FILTER (WHERE p.method='cash'),0) AS cash, COALESCE(SUM(p.amount) FILTER (WHERE p.method='card'),0) AS card,
            COALESCE(SUM(p.amount) FILTER (WHERE p.method='mobile_money'),0) AS momo, COALESCE(SUM(p.amount) FILTER (WHERE p.method='room'),0) AS room,
            s.expected_cash AS expected, s.counted_cash AS counted, s.counted_cash - s.expected_cash AS variance
          FROM pos_shifts s JOIN users u ON u.id=s.user_id JOIN outlets o ON o.id=s.outlet_id LEFT JOIN pos_payments p ON p.shift_id=s.id
          WHERE s.business_date BETWEEN :from AND :to AND (:outlet::int IS NULL OR s.outlet_id = :outlet::int) GROUP BY s.id, u.full_name, o.name ORDER BY s.business_date, u.full_name` },
  { key: 'waiter_summary', dept: 'pos', name: 'POS waiter daily sales summary', desc: 'Each waiter per day: bills, covers and sales.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['waiter', 'Waiter', 'text'], ['bills', 'Bills', 'int'], ['covers', 'Covers', 'int'], ['net', 'Net sales', 'money'], ['avg', 'Average bill', 'money']], sum: ['bills', 'covers', 'net'],
    sql: `SELECT c.business_date AS date, COALESCE(w.full_name,'—') AS waiter, count(*) AS bills, SUM(c.covers) AS covers, SUM(${POS_NET}) AS net, round(AVG(${POS_NET})) AS avg
          FROM pos_checks c LEFT JOIN users w ON w.id=c.waiter_id WHERE c.status='settled' AND c.settle_kind='sale' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY 1, 2 ORDER BY 1, net DESC` },
  { key: 'item_analysis', dept: 'pos', name: 'Item sales analysis (ABC)', desc: 'Items ranked by revenue: the A items earn 80% of sales, C items barely sell.', params: RANGE, outlet: true,
    cols: [['rank', '#', 'int'], ['item', 'Item', 'text'], ['qty', 'Qty', 'int'], ['amount', 'Revenue', 'money'], ['share', 'Share', 'pct'], ['cum', 'Cumulative', 'pct'], ['class', 'Class', 'text']], sum: ['qty', 'amount'],
    sql: `WITH x AS (SELECT l.name AS item, SUM(l.qty) AS qty, SUM(l.qty*l.unit_price) AS amount FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id
              WHERE c.status='settled' AND c.settle_kind='sale' AND l.status <> 'voided' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY l.name),
          y AS (SELECT *, row_number() OVER (ORDER BY amount DESC) AS rank, round(100.0*amount/NULLIF(SUM(amount) OVER (),0),1) AS share,
              round(100.0*SUM(amount) OVER (ORDER BY amount DESC ROWS UNBOUNDED PRECEDING)/NULLIF(SUM(amount) OVER (),0),1) AS cum FROM x)
          SELECT rank, item, qty, amount, share, cum, CASE WHEN cum - share < 80 THEN 'A' WHEN cum - share < 95 THEN 'B' ELSE 'C' END AS class FROM y ORDER BY rank` },
  { key: 'waiter_analysis', dept: 'pos', name: 'Waiters analysis report', desc: 'Waiters compared over the period: sales, covers, average spend and voids.', params: RANGE, outlet: true,
    cols: [['waiter', 'Waiter', 'text'], ['bills', 'Bills', 'int'], ['covers', 'Covers', 'int'], ['net', 'Net sales', 'money'], ['per_cover', 'Per cover', 'money'], ['discounts', 'Discounts', 'money'], ['voids', 'Voided', 'money']], sum: ['bills', 'covers', 'net', 'discounts', 'voids'],
    sql: `SELECT COALESCE(w.full_name,'—') AS waiter, count(*) FILTER (WHERE c.settle_kind='sale') AS bills, SUM(c.covers) FILTER (WHERE c.settle_kind='sale') AS covers, SUM(${POS_NET}) FILTER (WHERE c.settle_kind='sale') AS net,
            round(SUM(${POS_NET}) FILTER (WHERE c.settle_kind='sale')::numeric / NULLIF(SUM(c.covers) FILTER (WHERE c.settle_kind='sale'),0)) AS per_cover, SUM(c.discount_amount) AS discounts,
            COALESCE(SUM((SELECT SUM(l.qty*l.unit_price) FROM pos_check_lines l WHERE l.check_id=c.id AND l.status='voided')),0) AS voids
          FROM pos_checks c LEFT JOIN users w ON w.id=c.waiter_id WHERE c.status='settled' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY 1 ORDER BY net DESC NULLS LAST` },
  { key: 'cashier_analysis', dept: 'pos', name: 'Cashier analysis report', desc: 'Cashiers compared: shifts, takings and cash differences.', params: RANGE, outlet: true,
    cols: [['cashier', 'Cashier', 'text'], ['shifts', 'Shifts', 'int'], ['takings', 'Takings', 'money'], ['over', 'Over', 'money'], ['short', 'Short', 'money']], sum: ['shifts', 'takings', 'over', 'short'],
    sql: `SELECT u.full_name AS cashier, count(DISTINCT s.id) AS shifts, COALESCE((SELECT SUM(p.amount) FROM pos_payments p WHERE p.shift_id = ANY(array_agg(s.id))),0) AS takings,
            COALESCE(SUM(GREATEST(s.counted_cash - s.expected_cash,0)),0) AS over, COALESCE(SUM(GREATEST(s.expected_cash - s.counted_cash,0)),0) AS short
          FROM pos_shifts s JOIN users u ON u.id=s.user_id WHERE s.business_date BETWEEN :from AND :to AND (:outlet::int IS NULL OR s.outlet_id = :outlet::int) GROUP BY u.full_name ORDER BY takings DESC` },
  { key: 'table_analysis', dept: 'pos', name: 'Table sales analysis', desc: 'Which tables earn most: bills, covers and spend.', params: RANGE, outlet: true,
    cols: [['outlet', 'Outlet', 'text'], ['table', 'Table', 'text'], ['bills', 'Bills', 'int'], ['covers', 'Covers', 'int'], ['net', 'Net sales', 'money'], ['avg', 'Average bill', 'money']], sum: ['bills', 'covers', 'net'],
    sql: `SELECT o.name AS outlet, COALESCE(t.name, CASE WHEN c.reservation_id IS NOT NULL THEN 'Room service' ELSE 'Walk-in / takeaway' END) AS "table", count(*) AS bills, SUM(c.covers) AS covers, SUM(${POS_NET}) AS net, round(AVG(${POS_NET})) AS avg
          FROM pos_checks c JOIN outlets o ON o.id=c.outlet_id LEFT JOIN dining_tables t ON t.id=c.table_id WHERE c.status='settled' AND c.settle_kind='sale' AND c.business_date BETWEEN :from AND :to AND ${OUTLET}
          GROUP BY 1, 2 ORDER BY net DESC` },
  { key: 'charge_to_room', dept: 'pos', name: 'Charge to room report', desc: 'Every bill charged to a room, with the guest\'s check-out status.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['bill', 'Bill', 'text'], ['room', 'Room', 'text'], ['guest', 'Guest', 'text'], ['amount', 'Amount', 'money'], ['settled', 'Guest bill', 'text']], sum: ['amount'],
    sql: `SELECT p.business_date AS date, c.code AS bill, rm.number AS room, ${GUEST} AS guest, p.amount, CASE WHEN r.status='checked_out' THEN 'checked out' ELSE replace(r.status,'_',' ') END AS settled
          FROM pos_payments p JOIN pos_checks c ON c.id=p.check_id JOIN reservations r ON r.id=p.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms rm ON rm.id=r.room_id
          WHERE p.method='room' AND p.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY p.business_date` },
  { key: 'pos_voids', dept: 'pos', name: 'POS voids report', desc: 'Items removed after being sent to the kitchen or bar, and voided bills.', params: RANGE, outlet: true,
    cols: [['date', 'Date', 'date'], ['bill', 'Bill', 'text'], ['item', 'Item', 'text'], ['qty', 'Qty', 'int'], ['amount', 'Amount', 'money'], ['by', 'Voided by', 'text'], ['reason', 'Reason', 'text']], sum: ['qty', 'amount'],
    sql: `SELECT c.business_date AS date, c.code AS bill, l.name AS item, l.qty, l.qty*l.unit_price AS amount, u.full_name AS by, l.void_reason AS reason FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id LEFT JOIN users u ON u.id=l.voided_by
          WHERE l.status='voided' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY c.business_date, c.code` },
  { key: 'hourly_sales', dept: 'pos', name: 'Sales by hour', desc: 'When bills are paid: plan staff for the busy hours.', params: RANGE, outlet: true,
    cols: [['hour', 'Hour', 'text'], ['bills', 'Bills', 'int'], ['covers', 'Covers', 'int'], ['net', 'Net sales', 'money']], sum: ['bills', 'covers', 'net'],
    sql: `SELECT to_char(c.settled_at AT TIME ZONE COALESCE((SELECT timezone FROM settings WHERE id=1),'Africa/Kampala'),'HH24":00"') AS hour, count(*) AS bills, SUM(c.covers) AS covers, SUM(${POS_NET}) AS net
          FROM pos_checks c WHERE c.status='settled' AND c.settle_kind='sale' AND c.business_date BETWEEN :from AND :to AND ${OUTLET} GROUP BY 1 ORDER BY 1` },
  { key: 'category_sales', dept: 'pos', name: 'Sales by menu category', desc: 'Food, drinks, treatments …: quantity and revenue per category.', params: RANGE, outlet: true,
    cols: [['category', 'Category', 'text'], ['station', 'Station', 'text'], ['qty', 'Qty', 'int'], ['amount', 'Amount', 'money']], sum: ['qty', 'amount'],
    sql: `SELECT COALESCE(mc.name,'Other') AS category, COALESCE(mc.station,'') AS station, SUM(l.qty) AS qty, SUM(l.qty*l.unit_price) AS amount FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id
          LEFT JOIN menu_items mi ON mi.id=l.item_id LEFT JOIN menu_categories mc ON mc.id=mi.category_id WHERE c.status='settled' AND c.settle_kind='sale' AND l.status <> 'voided' AND c.business_date BETWEEN :from AND :to AND ${OUTLET}
          GROUP BY 1, 2 ORDER BY amount DESC` },
  { key: 'pos_reprints', dept: 'pos', name: 'Bill & receipt reprints', desc: 'Every bill, receipt or kitchen ticket printed more than once (fraud check).', params: RANGE, outlet: true,
    cols: [['at', 'Printed', 'ts'], ['bill', 'Bill', 'text'], ['kind', 'What', 'text'], ['by', 'Printed by', 'text']],
    sql: `SELECT pr.printed_at AS at, c.code AS bill, upper(pr.kind) AS kind, u.full_name AS by FROM pos_prints pr JOIN pos_checks c ON c.id=pr.check_id LEFT JOIN users u ON u.id=pr.printed_by
          WHERE pr.copy AND c.business_date BETWEEN :from AND :to AND ${OUTLET} ORDER BY pr.printed_at` },
  { key: 'happy_hour', dept: 'pos', name: 'Happy hour sales', desc: 'Items sold at the happy-hour price, and how much the discount cost.', params: RANGE, outlet: true,
    cols: [['item', 'Item', 'text'], ['qty', 'Qty', 'int'], ['amount', 'Sold for', 'money'], ['full', 'At full price', 'money'], ['given', 'Happy-hour saving', 'money']], sum: ['qty', 'amount', 'full', 'given'],
    sql: `SELECT l.name AS item, SUM(l.qty) AS qty, SUM(l.qty*l.unit_price) AS amount, SUM(l.qty*mi.price) AS full, SUM(l.qty*(mi.price - l.unit_price)) AS given
          FROM pos_check_lines l JOIN pos_checks c ON c.id=l.check_id JOIN menu_items mi ON mi.id=l.item_id WHERE l.happy AND l.status <> 'voided' AND c.status='settled' AND c.business_date BETWEEN :from AND :to AND ${OUTLET}
          GROUP BY l.name ORDER BY qty DESC` },

  /* ============================ SPA & HEALTH CLUB ============================ */
  { key: 'spa_treatments', dept: 'wellness', name: 'Spa treatments', desc: 'Every treatment booked: time, therapist, room, status and payment.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['time', 'Time', 'text'], ['code', 'Booking', 'text'], ['treatment', 'Treatment', 'text'], ['guest', 'Guest', 'text'], ['therapist', 'Therapist', 'text'], ['room', 'Treatment room', 'text'], ['status', 'Status', 'text'], ['paid', 'Paid by', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT ab.service_date AS date, to_char(ab.start_time,'HH24:MI') AS time, ab.code, a.name AS treatment, ab.guest_name AS guest, COALESCE(t.name, ab.staff) AS therapist, sr.name AS room,
            replace(ab.status,'_',' ') AS status, replace(ab.settled_by,'_',' ') AS paid, ab.qty*ab.unit_price AS amount
          FROM amenity_bookings ab JOIN amenities a ON a.id=ab.amenity_id LEFT JOIN spa_therapists t ON t.id=ab.therapist_id LEFT JOIN spa_rooms sr ON sr.id=ab.spa_room_id
          WHERE a.category='spa' AND ab.service_date BETWEEN :from AND :to ORDER BY ab.service_date, ab.start_time NULLS LAST` },
  { key: 'therapist_performance', dept: 'wellness', name: 'Therapist performance', desc: 'Treatments done, revenue, no-shows and cancellations per therapist.', params: RANGE,
    cols: [['therapist', 'Therapist', 'text'], ['done', 'Treatments', 'int'], ['hours', 'Hours', 'num'], ['revenue', 'Revenue', 'money'], ['no_shows', 'No-shows', 'int'], ['cancelled', 'Cancelled', 'int']], sum: ['done', 'revenue', 'no_shows', 'cancelled'],
    sql: `SELECT COALESCE(t.name, ab.staff, 'Not assigned') AS therapist, count(*) FILTER (WHERE ab.status='completed') AS done,
            round(SUM(COALESCE(a.duration_min,60)) FILTER (WHERE ab.status='completed') / 60.0, 1) AS hours, COALESCE(SUM(ab.qty*ab.unit_price) FILTER (WHERE ab.status='completed'),0) AS revenue,
            count(*) FILTER (WHERE ab.status='no_show') AS no_shows, count(*) FILTER (WHERE ab.status='cancelled') AS cancelled
          FROM amenity_bookings ab JOIN amenities a ON a.id=ab.amenity_id LEFT JOIN spa_therapists t ON t.id=ab.therapist_id WHERE a.category='spa' AND ab.service_date BETWEEN :from AND :to GROUP BY 1 ORDER BY revenue DESC` },
  { key: 'amenity_sales', dept: 'wellness', name: 'Services sold', desc: 'Spa, transport, tours, laundry and other services completed, by service.', params: RANGE,
    cols: [['service', 'Service', 'text'], ['category', 'Category', 'text'], ['count', 'Times', 'int'], ['to_rooms', 'Charged to rooms', 'money'], ['paid', 'Paid at the time', 'money'], ['total', 'Total', 'money']], sum: ['count', 'to_rooms', 'paid', 'total'],
    sql: `SELECT a.name AS service, a.category, count(*) AS count, COALESCE(SUM(ab.qty*ab.unit_price) FILTER (WHERE ab.settled_by='room'),0) AS to_rooms,
            COALESCE(SUM(ab.qty*ab.unit_price) FILTER (WHERE ab.settled_by <> 'room'),0) AS paid, SUM(ab.qty*ab.unit_price) AS total
          FROM amenity_bookings ab JOIN amenities a ON a.id=ab.amenity_id WHERE ab.status='completed' AND ab.completed_at::date BETWEEN :from AND :to GROUP BY a.id ORDER BY total DESC` },
  { key: 'club_members', dept: 'wellness', name: 'Health club members', desc: 'Every member, their plan and when it ends.', params: [],
    cols: [['code', 'Member', 'text'], ['name', 'Name', 'text'], ['phone', 'Phone', 'text'], ['plan', 'Plan', 'text'], ['ends', 'Ends', 'date'], ['state', 'Status', 'text'], ['visits', 'Visits (30 days)', 'int']], sum: ['visits'],
    sql: `SELECT m.code, m.first_name || ' ' || m.last_name AS name, m.phone, p.name AS plan, m.ends_on AS ends,
            CASE WHEN m.status <> 'active' THEN m.status WHEN m.ends_on IS NULL THEN 'not paid' WHEN m.ends_on < CURRENT_DATE THEN 'expired' WHEN m.ends_on <= CURRENT_DATE + 7 THEN 'expiring' ELSE 'active' END AS state,
            (SELECT count(*) FROM club_visits v WHERE v.member_id=m.id AND v.visited_at > now() - interval '30 days') AS visits
          FROM club_members m LEFT JOIN club_plans p ON p.id=m.plan_id ORDER BY m.ends_on NULLS FIRST` },
  { key: 'club_sales', dept: 'wellness', name: 'Membership sales', desc: 'Memberships sold and renewed.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['member', 'Member', 'text'], ['plan', 'Plan', 'text'], ['from', 'From', 'date'], ['to', 'To', 'date'], ['method', 'Paid by', 'text'], ['amount', 'Amount', 'money']], sum: ['amount'],
    sql: `SELECT cp.business_date AS date, m.code || ' ' || m.first_name || ' ' || m.last_name AS member, p.name AS plan, cp.period_from AS "from", cp.period_to AS "to", replace(cp.method,'_',' ') AS method, cp.amount
          FROM club_payments cp JOIN club_members m ON m.id=cp.member_id LEFT JOIN club_plans p ON p.id=cp.plan_id WHERE cp.business_date BETWEEN :from AND :to ORDER BY cp.business_date` },
  { key: 'club_visits', dept: 'wellness', name: 'Health club visits', desc: 'Visits per day: members, hotel guests and day passes.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['members', 'Members', 'int'], ['guests', 'Hotel guests', 'int'], ['day_pass', 'Day passes', 'int'], ['total', 'Total', 'int']], sum: ['members', 'guests', 'day_pass', 'total'],
    sql: `SELECT business_date AS date, count(*) FILTER (WHERE kind='member') AS members, count(*) FILTER (WHERE kind='hotel_guest') AS guests, count(*) FILTER (WHERE kind='day_pass') AS day_pass, count(*) AS total
          FROM club_visits WHERE business_date BETWEEN :from AND :to GROUP BY business_date ORDER BY business_date` },

  /* ============================ HR ============================ */
  { key: 'staff_list', dept: 'hr', name: 'Staff list', desc: 'Everyone employed, by department.', params: [],
    cols: [['no', 'No.', 'text'], ['name', 'Name', 'text'], ['department', 'Department', 'text'], ['title', 'Job title', 'text'], ['type', 'Type', 'text'], ['start', 'Started', 'date'], ['phone', 'Phone', 'text']],
    sql: `SELECT emp_no AS no, first_name || ' ' || last_name AS name, department, job_title AS title, employment_type AS type, start_date AS start, phone FROM employees WHERE status='active' ORDER BY department, last_name` },
  { key: 'headcount', dept: 'hr', name: 'Headcount & payroll cost by department', desc: 'Staff and monthly basic pay per department.', params: [],
    cols: [['department', 'Department', 'text'], ['staff', 'Staff', 'int'], ['basic', 'Basic pay', 'money'], ['allowances', 'Allowances', 'money']], sum: ['staff', 'basic', 'allowances'],
    sql: `SELECT COALESCE(department,'Not set') AS department, count(*) AS staff, SUM(basic_salary) AS basic, SUM(housing_allowance + transport_allowance + other_allowance) AS allowances FROM employees WHERE status='active' GROUP BY 1 ORDER BY staff DESC` },
  { key: 'attendance', dept: 'hr', name: 'Attendance report', desc: 'Clock-in and clock-out times and hours worked.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['name', 'Name', 'text'], ['department', 'Department', 'text'], ['in', 'In', 'ts'], ['out', 'Out', 'ts'], ['hours', 'Hours', 'num']], sum: ['hours'],
    sql: `SELECT a.date, e.first_name || ' ' || e.last_name AS name, e.department, a.clock_in AS "in", a.clock_out AS out, round(EXTRACT(EPOCH FROM (a.clock_out - a.clock_in))/3600.0, 2) AS hours
          FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.date BETWEEN :from AND :to ORDER BY a.date, e.last_name` },
  { key: 'leave', dept: 'hr', name: 'Leave report', desc: 'Leave taken or requested in the period.', params: RANGE,
    cols: [['name', 'Name', 'text'], ['type', 'Type', 'text'], ['from', 'From', 'date'], ['to', 'To', 'date'], ['days', 'Days', 'int'], ['status', 'Status', 'text']], sum: ['days'],
    sql: `SELECT e.first_name || ' ' || e.last_name AS name, l.type, l.from_date AS "from", l.to_date AS "to", l.days, l.status FROM leave_requests l JOIN employees e ON e.id=l.employee_id
          WHERE l.from_date <= :to AND l.to_date >= :from ORDER BY l.from_date` },
  { key: 'payroll_summary', dept: 'hr', name: 'Payroll summary', desc: 'Each payroll: gross, PAYE, NSSF and net pay.', params: [],
    cols: [['period', 'Month', 'text'], ['status', 'Status', 'text'], ['staff', 'Staff', 'int'], ['gross', 'Gross', 'money'], ['paye', 'PAYE', 'money'], ['nssf', 'NSSF (staff)', 'money'], ['nssf_er', 'NSSF (employer)', 'money'], ['net', 'Net pay', 'money']], sum: ['gross', 'paye', 'nssf', 'nssf_er', 'net'],
    sql: `SELECT r.period, r.status, count(l.*) AS staff, SUM(l.gross) AS gross, SUM(l.paye) AS paye, SUM(l.nssf_employee) AS nssf, SUM(l.nssf_employer) AS nssf_er, SUM(l.net) AS net
          FROM payroll_runs r LEFT JOIN payroll_lines l ON l.run_id=r.id GROUP BY r.id ORDER BY r.period DESC LIMIT 36` },

  /* ============================ GUESTS & MARKETING ============================ */
  { key: 'marketing_consent', dept: 'crm', name: 'Guests who agreed to marketing', desc: 'Guests you may send offers to, and when they agreed.', params: [],
    cols: [['guest', 'Guest', 'text'], ['email', 'Email', 'text'], ['phone', 'Phone', 'text'], ['at', 'Agreed', 'ts'], ['source', 'Where', 'text'], ['whatsapp', 'WhatsApp too', 'text']],
    sql: `SELECT ${GUEST} AS guest, g.email, g.phone, g.consent_at AS at, g.consent_source AS source, CASE WHEN g.whatsapp_opt_in THEN 'yes' END AS whatsapp FROM guests g
          WHERE g.marketing_consent AND g.unsubscribed_at IS NULL AND g.erased_at IS NULL ORDER BY g.consent_at DESC NULLS LAST` },
  { key: 'repeat_guests', dept: 'crm', name: 'Repeat guests', desc: 'Guests who stayed two or more times.', params: [],
    cols: [['guest', 'Guest', 'text'], ['stays', 'Stays', 'int'], ['nights', 'Nights', 'int'], ['last', 'Last stay', 'date'], ['phone', 'Phone', 'text'], ['email', 'Email', 'text']], sum: ['stays', 'nights'],
    sql: `SELECT ${GUEST} AS guest, count(*) AS stays, SUM(${NIGHTS}) AS nights, max(r.arrival) AS last, g.phone, g.email FROM guests g JOIN reservations r ON r.guest_id=g.id
          WHERE r.status IN ('in_house','checked_out') AND g.erased_at IS NULL GROUP BY g.id HAVING count(*) >= 2 ORDER BY stays DESC, last DESC` },
  { key: 'birthdays', dept: 'crm', name: 'Guest birthdays & anniversaries', desc: 'Guests with a birthday or anniversary in the period (send a greeting).', params: RANGE,
    cols: [['day', 'Day', 'text'], ['guest', 'Guest', 'text'], ['what', 'Occasion', 'text'], ['phone', 'Phone', 'text'], ['email', 'Email', 'text']],
    sql: `SELECT to_char(d,'DD Mon') AS day, guest, what, phone, email FROM (
            SELECT g.birth_date AS d, ${GUEST} AS guest, 'Birthday' AS what, g.phone, g.email FROM guests g WHERE g.birth_date IS NOT NULL AND g.erased_at IS NULL
            UNION ALL SELECT g.anniversary, ${GUEST}, 'Anniversary', g.phone, g.email FROM guests g WHERE g.anniversary IS NOT NULL AND g.erased_at IS NULL) x
          WHERE to_char(d,'MMDD') BETWEEN to_char(:from::date,'MMDD') AND to_char(:to::date,'MMDD') ORDER BY to_char(d,'MMDD')` },
  { key: 'campaigns', dept: 'crm', name: 'Email campaigns', desc: 'Campaigns sent and how many guests received them.', params: RANGE,
    cols: [['sent', 'Sent', 'ts'], ['name', 'Campaign', 'text'], ['subject', 'Subject', 'text'], ['recipients', 'Recipients', 'int'], ['status', 'Status', 'text']], sum: ['recipients'],
    sql: `SELECT sent_at AS sent, name, subject, recipients, status FROM campaigns WHERE COALESCE(sent_at, created_at)::date BETWEEN :from AND :to ORDER BY COALESCE(sent_at, created_at) DESC` },
  { key: 'whatsapp_leads', dept: 'crm', name: 'WhatsApp leads', desc: 'Conversations showing buying signals, most likely to book first.', params: [],
    cols: [['name', 'Contact', 'text'], ['stage', 'Stage', 'text'], ['score', 'Likely to book', 'pct'], ['last', 'Last message', 'ts'], ['first_signal', 'First asked to book', 'ts']],
    sql: `SELECT COALESCE(${GUEST}, wc.profile_name, wc.wa_id) AS name, replace(wi.stage,'_',' ') AS stage, wi.score, wc.last_message_at AS last, wi.first_purchase_signal_at AS first_signal
          FROM wa_intents wi JOIN wa_conversations wc ON wc.id=wi.conversation_id LEFT JOIN guests g ON g.id=wc.guest_id WHERE wi.stage <> 'explorer' ORDER BY wi.score DESC` },

  /* ============================ MAINTENANCE ============================ */
  { key: 'work_orders', dept: 'maintenance', name: 'Maintenance work orders', desc: 'Repairs and jobs reported, done or still open.', params: RANGE,
    cols: [['code', 'Job', 'text'], ['reported', 'Reported', 'ts'], ['title', 'Problem', 'text'], ['where', 'Where', 'text'], ['priority', 'Priority', 'text'], ['status', 'Status', 'text'], ['assigned', 'Assigned', 'text'], ['completed', 'Done', 'ts'], ['cost', 'Cost', 'money']], sum: ['cost'],
    sql: `SELECT w.code, w.reported_at AS reported, w.title, COALESCE('Room ' || rm.number, w.location) AS "where", w.priority, replace(w.status,'_',' ') AS status, w.assigned_to AS assigned, w.completed_at AS completed, w.cost
          FROM work_orders w LEFT JOIN rooms rm ON rm.id=w.room_id WHERE w.reported_at::date BETWEEN :from AND :to ORDER BY w.reported_at DESC` },
  { key: 'room_blocks', dept: 'maintenance', name: 'Rooms out of order', desc: 'Rooms taken off sale and why, with nights lost.', params: RANGE,
    cols: [['room', 'Room', 'text'], ['kind', 'Kind', 'text'], ['from', 'From', 'date'], ['to', 'To', 'date'], ['category', 'Category', 'text'], ['reason', 'Reason', 'text'], ['nights', 'Nights in period', 'int'], ['released', 'Back on sale', 'ts']], sum: ['nights'],
    sql: `SELECT rm.number AS room, replace(b.kind,'_',' ') AS kind, b.date_from AS "from", b.date_to AS "to", b.category, b.reason,
            GREATEST(0, LEAST(COALESCE(b.date_to, :to::date), COALESCE(b.released_at::date - 1, :to::date), :to::date) - GREATEST(b.date_from, :from::date) + 1) AS nights, b.released_at AS released
          FROM room_blocks b JOIN rooms rm ON rm.id=b.room_id WHERE b.date_from <= :to AND (b.date_to IS NULL OR b.date_to >= :from) ORDER BY b.date_from` },
  { key: 'asset_service', dept: 'maintenance', name: 'Assets due for service', desc: 'Equipment whose service date has passed or comes up in the period.', params: RANGE,
    cols: [['code', 'Asset', 'text'], ['name', 'Name', 'text'], ['location', 'Location', 'text'], ['last', 'Last service', 'date'], ['due', 'Due', 'date']],
    sql: `SELECT code, name, location, last_service_date AS last, (COALESCE(last_service_date, purchase_date) + service_interval_days) AS due FROM assets
          WHERE status <> 'disposed' AND service_interval_days IS NOT NULL AND (COALESCE(last_service_date, purchase_date) + service_interval_days) <= :to ORDER BY due` },
  { key: 'asset_register', dept: 'maintenance', name: 'Asset register', desc: 'Every asset with cost, depreciation and book value.', params: [],
    cols: [['code', 'Asset', 'text'], ['name', 'Name', 'text'], ['category', 'Category', 'text'], ['location', 'Location', 'text'], ['purchased', 'Bought', 'date'], ['cost', 'Cost', 'money'], ['dep', 'Depreciation', 'money'], ['book', 'Book value', 'money'], ['status', 'Status', 'text']], sum: ['cost', 'dep', 'book'],
    sql: `SELECT code, name, category, location, purchase_date AS purchased, cost, accumulated_dep AS dep, cost - accumulated_dep AS book, status FROM assets ORDER BY category, code` },

  /* ============================ MANAGEMENT ============================ */
  { key: 'flash', dept: 'management', name: 'Manager\'s flash report', desc: 'Each day at a glance: occupancy, ADR, RevPAR and revenue by department.', params: RANGE,
    cols: [['date', 'Date', 'date'], ['occ', 'Occupancy', 'pct'], ['adr', 'ADR', 'money'], ['revpar', 'RevPAR', 'money'], ['rooms', 'Rooms', 'money'], ['fnb', 'Food & beverage', 'money'], ['other', 'Spa, events & other', 'money'], ['total', 'Total revenue', 'money']], sum: ['rooms', 'fnb', 'other', 'total'],
    sql: `WITH d AS (SELECT generate_series(:from::date, :to::date, '1 day')::date AS date),
          occ AS (SELECT d.date, (SELECT count(*) FROM rooms WHERE active) AS avail,
              (SELECT count(*) FROM reservation_nights n JOIN reservations r ON r.id=n.reservation_id WHERE n.night=d.date AND r.status IN ('reserved','in_house','checked_out')) AS sold,
              (SELECT COALESCE(SUM(n.rate),0) FROM reservation_nights n JOIN reservations r ON r.id=n.reservation_id WHERE n.night=d.date AND r.status IN ('reserved','in_house','checked_out')) AS roomrev FROM d),
          rev AS (SELECT je.business_date AS date, SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code='4000') AS rooms, SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code='4100') AS fnb,
              SUM(jl.credit - jl.debit) FILTER (WHERE jl.account_code IN ('4200','4300','4900','4920')) AS other FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
              WHERE jl.account_code IN ('4000','4100','4200','4300','4900','4920') AND je.business_date BETWEEN :from AND :to GROUP BY je.business_date)
          SELECT occ.date, round(100.0*sold/NULLIF(avail,0),1) AS occ, round(roomrev::numeric/NULLIF(sold,0)) AS adr, round(roomrev::numeric/NULLIF(avail,0)) AS revpar,
            COALESCE(rev.rooms,0) AS rooms, COALESCE(rev.fnb,0) AS fnb, COALESCE(rev.other,0) AS other, COALESCE(rev.rooms,0) + COALESCE(rev.fnb,0) + COALESCE(rev.other,0) AS total
          FROM occ LEFT JOIN rev ON rev.date=occ.date ORDER BY occ.date` },
  { key: 'department_pnl', dept: 'management', name: 'Profit & loss by month', desc: 'Revenue, cost of sales, payroll, other costs and profit per month.', params: RANGE,
    cols: [['month', 'Month', 'text'], ['revenue', 'Revenue', 'money'], ['cos', 'Cost of sales', 'money'], ['payroll', 'Payroll', 'money'], ['commission', 'OTA commission', 'money'], ['other', 'Other expenses', 'money'], ['profit', 'Profit', 'money'], ['margin', 'Margin', 'pct']], sum: ['revenue', 'cos', 'payroll', 'commission', 'other', 'profit'],
    sql: `WITH x AS (SELECT to_char(je.business_date,'YYYY-MM') AS month, a.type, jl.account_code AS code, jl.credit - jl.debit AS cr FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id JOIN accounts a ON a.code=jl.account_code
              WHERE a.type IN ('revenue','expense') AND je.business_date BETWEEN :from AND :to)
          SELECT month, SUM(cr) FILTER (WHERE type='revenue') AS revenue, -SUM(cr) FILTER (WHERE code IN ('5000','5100','5900')) AS cos, -SUM(cr) FILTER (WHERE code IN ('6000','6010')) AS payroll,
            -SUM(cr) FILTER (WHERE code='5300') AS commission, -SUM(cr) FILTER (WHERE type='expense' AND code NOT IN ('5000','5100','5900','6000','6010','5300')) AS other, SUM(cr) AS profit,
            round(100.0*SUM(cr)/NULLIF(SUM(cr) FILTER (WHERE type='revenue'),0),1) AS margin FROM x GROUP BY month ORDER BY month` },
  { key: 'pickup', dept: 'management', name: 'Forward bookings (on the books)', desc: 'Rooms already sold for each future night: spot quiet nights early.', params: RANGE,
    cols: [['night', 'Night', 'date'], ['sold', 'Rooms sold', 'int'], ['occ', 'Occupancy', 'pct'], ['revenue', 'Revenue on the books', 'money']], sum: ['sold', 'revenue'],
    sql: `WITH d AS (SELECT generate_series(:from::date, :to::date, '1 day')::date AS night)
          SELECT d.night, count(n.reservation_id) AS sold, round(100.0*count(n.reservation_id)/NULLIF((SELECT count(*) FROM rooms WHERE active),0),1) AS occ, COALESCE(SUM(n.rate),0) AS revenue
          FROM d LEFT JOIN reservation_nights n ON n.night=d.night AND EXISTS (SELECT 1 FROM reservations r WHERE r.id=n.reservation_id AND r.status IN ('reserved','in_house','checked_out')) GROUP BY d.night ORDER BY d.night` },
];

/** Who may open a report: any of its department's rights. */
export function canSee(user, dept, can) {
  const d = DEPTS.find(([k]) => k === dept);
  return !!d && d[2].some((p) => can(user, p));
}

/** :from, :to, :outlet → $1, $2 … in the order they first appear. */
export function compile(sql, values) {
  const order = [];
  const text = sql.replace(/:(from|to|outlet)\b/g, (_m, k) => { let i = order.indexOf(k); if (i < 0) { order.push(k); i = order.length - 1; } return `$${i + 1}`; });
  return { text, params: order.map((k) => values[k] ?? null) };
}
