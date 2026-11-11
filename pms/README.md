# Azeli PMS (Azeli Property Management Software)

The hotel property management system offered to Azeli Technologies marketing partners.
Built so far: Phase 1 (foundation and front office), Phase 2 (restaurant / POS), Phase 3 (inventory, purchasing and requisitions), Phase 4 (booking engine and channel manager), Phase 5 (accounting & finance), Phase 6 (HR & payroll), Phase 7 (events & banqueting, assets & maintenance, amenity sales), Phase 8 (automated department reports by email and a multi-property group dashboard) and Phase 9 (guest CRM & marketing). It is a real system with a database, staff accounts and accounting. It is not a demo.
The clickable sales demo lives separately in `../pms-demo/`.

## What it does

| Area | Features |
|---|---|
| Staff accounts | Individual sign-in, ten roles (admin, manager, front office, night auditor, housekeeping, accountant, waiter/cashier, kitchen/bar, storekeeper, HR officer, maintenance), password change/reset, account disable, sign-in lockout after 5 failed attempts |
| Front office | Dashboard, room board, reservations (create, edit, cancel, search), availability grid, check-in with room assignment and ID capture, check-out, walk-in via same-day booking |
| Overbooking protection | Availability is checked inside a locked transaction, so two receptionists cannot sell the last room at the same moment. The database also prevents two in-house guests in one room |
| Guest bills (folios) | Charges by department (rooms, F&B, amenities, events, other), payments (cash, card, mobile money, bank transfer, company account), voids with a reason (manager/accountant only), printable invoice |
| Housekeeping | Clean / dirty / out of order; rooms go dirty at check-out and nightly for stayovers |
| Night audit | Blocks until due-out guests are handled, posts one room charge per in-house guest (never twice), marks no-shows, advances the business date |
| Accounting core | Every charge, payment and void posts a balanced double entry automatically, with VAT (18% by default) split out of VAT-inclusive prices. The database refuses any unbalanced entry. Trial balance and journal views |
| Reports | Daily manager's report: occupancy, ADR, RevPAR, revenue by department, collections by method |
| Audit trail | Every sign-in, booking change, charge, payment, void, room change and night audit is logged with who and when |
| **Restaurant / POS** (Phase 2) | Outlets (restaurant, bar, room service), menu categories and items, tables. Waiters open a bill per table, for a walk-in or for room service, add items with notes and send them to the kitchen or bar |
| Kitchen & bar screen | Live tickets per station (auto-refresh), marked ready and served |
| POS payments | Cash (with change calculation), card, mobile money and charge to an in-house guest's room, including split payments. Every sale posts to the accounts with VAT; room charges land on the guest's bill |
| POS controls | Items already sent can only be removed by a manager, with a reason. Cashier shifts with opening float and a counted-cash close showing any difference. Open bills block shift close, guest check-out (room service) and the night audit |
| F&B reports | Sales by outlet, payment method and item, voids, and shift cash-ups; restaurant takings feed the daily manager's report |
| **Stores & stock** (Phase 3) | Several stores (main store, kitchen, bar, housekeeping, maintenance), stock items with re-order levels, stock on hand per store valued at weighted average cost, full movement history per item |
| Purchasing | Suppliers, purchase orders approved by someone other than the person who raised them, deliveries (goods received) against orders including part deliveries, deliveries without an order, and opening stock for go-live. Deliveries post Dr Inventory / Cr Accounts payable |
| Requisitions | Departments request stock; a manager approves (never their own request) and can reduce quantities; the storekeeper issues it either into the department's store (transfer) or as a department expense. Issuing more than the store holds is refused |
| Recipes | Ingredients per portion for each menu item, costed with cost % against the price before VAT. When the POS settles a bill, ingredients come out of the outlet's store and cost of sales is posted. Sales are never blocked by stock levels; items that go below zero are flagged |
| Stock counts & write-offs | Count a store, save progress, post: differences adjust stock and post to Stock variances. Write-offs need a reason |
| Inventory reports | Stock value by store, F&B cost % for any period, consumption by department, items to re-order, items below zero |
| **Rates & rate plans** (Phase 4) | Rate plans (e.g. flexible, non-refundable, long stay) as a discount on the standard price, with breakfast, cancellation, minimum stay and where they are sold. A rate calendar sets date-specific prices, minimum stays and stop-sells per room type. Each booked night keeps its own price and the night audit charges exactly that |
| Website booking engine | Public page at `/book/` (no sign-in): search dates, see room types and plans with prices, book with name/email/phone, get a booking code; look up and cancel online within the rate's rules. Protected against double-selling the last room, bots (honeypot) and floods (rate limits). Guests pay at the hotel |
| **Company accounts** (Phase 5) | Companies with TIN, credit limit and payment terms. Front desk moves guest bills to a company account (credit limit enforced); accounts invoice those stays plus any extra charges (posted with VAT), record receipts against invoices, and see aging (not invoiced, current, 30/60/90/90+) and each company's statement |
| Suppliers & bills | Supplier invoices matched to deliveries (stock), or expense bills (utilities, repairs…) with input VAT; supplier payments allocated to bills; supplier aging including deliveries not yet billed |
| Expenses & transfers | Direct payments (petty cash, fuel, VAT to URA, OTA commission…) with VAT; transfers between cash, bank, mobile money and card clearing, with fees to bank charges |
| Books | Editable chart of accounts with cash/bank flags; manual journals (never to the system-kept ledgers: guest ledger, company accounts, inventory, suppliers); closing the books up to a date (only an administrator can reopen); bank reconciliation that must reach zero difference |
| Financial statements | Profit & loss, balance sheet (checked to balance), general ledger with running balances, VAT summary (output, input, net, paid to URA) |
| OTA commission | Accrued every night for channel bookings (Dr OTA commissions, Cr commissions payable) |
| Online payment | Booking-engine guests can pay online: non-refundable rates in full, other rates the first night. Provider-neutral; a built-in test checkout is included for trying it out. Connect a real provider (e.g. Flutterwave, Pesapal) before switching it on for guests |
| **Employees** (Phase 6) | Staff records with NIN, TIN, NSSF number, department, job, contract type, salary and allowances, bank or mobile money details, and an optional link to their sign-in. Leavers are paid up to their last day and their sign-in is switched off |
| Rosters & attendance | Shift templates and a weekly roster per department (copy last week; approved leave shows automatically). Sign-in/out recorded by a supervisor or by staff themselves; late (>10 min), absent and hours worked, including night shifts |
| Leave | Annual (with balance), sick, maternity, paternity, compassionate and unpaid leave; requested by staff or HR, approved by a manager who is not the requester. Unpaid leave is deducted in payroll |
| Payroll | Monthly payroll: pro-rata for joiners/leavers, unpaid leave, allowances, overtime at 1.5×, other additions/deductions, NSSF 5% + 10%, PAYE on the Uganda monthly bands, staff advance recovery. Prepared → approved by someone else → posted to the accounts → paid. Payslips, PAYE and NSSF schedules, payment list and wage cost by department |
| Self-service | “My HR” for every staff member: sign in/out, this week's shifts, leave balance and requests, payslips |
| **Amenities & services** (Phase 7) | Price list of spa treatments, transfers, tours, laundry and day passes. Bookings by day with time and staff (the same therapist or driver cannot be double-booked). When delivered, charge to an in-house guest's room or take cash, card or mobile money; posts to Amenities revenue with VAT |
| Events & banqueting | Function rooms with capacity and half/full-day hire, packages priced per guest. Events move enquiry → tentative → confirmed → completed. Tentative and confirmed events hold the room (no overlapping bookings; capacity checked). Quote = package × guests + room hire + extras. Deposits are held as a liability and confirm the booking. Printable banquet event order (BEO) with instructions for kitchen, service, bar, housekeeping, technical and front office. Complete & bill applies deposits; the balance is paid on the spot or invoiced to the client's company account. Cancelling needs the deposit refunded or kept as forfeited-deposit income |
| Assets | Fixed asset register (cost, residual value, useful life, location, serial, supplier). New assets post to Property, plant & equipment from cash/bank or as an opening balance. Monthly straight-line depreciation posted once per month. Disposal or sale books the gain or loss. Book value and service history per asset |
| Maintenance | Any staff member reports a fault (room, asset or place, with priority). Reporting can take a vacant room out of order; when the job is done the room goes back to housekeeping as dirty. Assets with a fault show as under repair. Technicians assign, update, cost and close jobs. Assets with a service interval get preventive jobs created when due |
| **Department reports** (Phase 8) | Eight reports built from live data: general manager, front office, F&B, stores & purchasing, finance, HR, events & amenities, maintenance. Run any of them on screen for any period (print-ready), or schedule them daily, weekly (Mon–Sun) or monthly to any email addresses. Each report only shows to staff who can already see that area |
| Report emails | Produced automatically once the night audit closes the period (never twice). Sent through your SMTP provider with retries and back-off; failures are listed and can be retried. Without email settings the system runs in test mode and keeps the emails for viewing |
| Group dashboard | Every property runs its own Azeli PMS; an administrator issues a group access key, and the group office links each property by address and key. The dashboard shows occupancy, ADR, RevPAR, revenue by department, expenses, collections, cash, receivables and urgent maintenance per property and as a group total. The key reads totals only, never guest details, and can be revoked at any time |
| **Guest CRM** (Phase 9) | One profile per guest: returning guests are matched by email from the front desk, the website and channels; possible duplicates (same name, email or phone) are flagged and can be merged. Stays, nights, spend, last and next stay, VIP flag, tags, birthday, preferences and notes. Search and filter by VIP, tag, stays, spend, last stay, source, nationality, birthday month and consent |
| Marketing consent | Opt-in only: an unticked box on the booking engine, or recorded by the front desk, with date and source. One-click unsubscribe page for guests. A withdrawal on any merged profile wins. Under Uganda's Data Protection and Privacy Act, a guest's data can be exported, or erased while the financial records are kept |
| Campaigns | Email offers to a segment of past guests, personalised with {first_name} and similar placeholders. Only guests who agreed receive them; every email carries an unsubscribe link; check the audience and send a test first; each guest gets a campaign once. Delivered, failed and unsubscribed counts per campaign |
| Automatic guest emails | A pre-arrival email (sell transfers, spa and dinner before the guest arrives) and a post-stay thank-you with your Google/TripAdvisor review link, each sent once per stay after the night audit |
| Channel manager | Channels with their own room/rate codes and commission. Every change to availability, prices or restrictions is queued and pushed automatically (every 20 s by default) as a signed message; full re-sync on demand. Bookings, changes and cancellations from channels arrive at `/api/channels/<code>/inbound`, are signature-checked, never duplicated, and are accepted even when sold out (flagged as overbooked on the dashboard). Every message is logged |

Money is stored in whole Ugandan shillings. Each property gets its own database.

## Run it

**Hosting:** see [../docs/GO-LIVE.md](../docs/GO-LIVE.md) for the recommended setup (Render, Frankfurt) and email. Production settings: `NODE_ENV=production`, `TRUST_PROXY=1` behind a hosting load balancer, `AUTO_SEED=1` with `PROPERTY_NAME` and `ADMIN_PASSWORD` to set up the property on the first start. `/healthz` reports whether the app and its database are up.

Requirements: Node.js 20+ and PostgreSQL 14+.

```bash
cd pms
npm install
createdb hk_pms                     # or create the database in your hosting panel
export DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/hk_pms
PROPERTY_NAME="Amaya Hotel & Luxury Suites" ADMIN_PASSWORD="choose-a-strong-one" npm run seed
npm start                            # http://localhost:3000
```

`npm run seed` creates the property, an `admin` account, a starter set of room types and rooms (edit them under **Settings**) a starter restaurant, bar and room-service menu with tables (edit them under **Menu & tables**), and starter stores, stock items, suppliers and recipes (edit them under **Items & recipes**). Then record what is already on your shelves under **Purchasing → Opening stock**. Running it on an existing property only adds parts that are missing, so it is safe after upgrading. It does nothing if the property already exists. Without `ADMIN_PASSWORD` it generates one and prints it once.

Database migrations run automatically on start (`npm run migrate` runs them on their own).

**Report emails.** Set `EMAIL_TRANSPORT=smtp`, `SMTP_URL` (e.g. `smtps://user:pass@smtp.provider.com:465`) and `EMAIL_FROM` to send scheduled reports (any SMTP provider works: Google Workspace, Microsoft 365, Zoho, Mailgun, Brevo…). Without them, reports are still produced and kept under **Department reports → Emails** in test mode. The server checks for due reports and sends queued email every minute (`REPORT_CHECK_SECONDS`).

**Several properties.** Each property runs its own Azeli PMS and database. On each one an administrator opens **Group dashboard** and creates a group access key; on the head-office installation, link each property with its address and key.

## Connecting a real channel (Booking.com, Expedia, Airbnb…)

OTAs only connect through certified channel-manager partners. Add the partner as a **Webhook** channel under **Channels (OTAs)**:

1. Create the channel with the partner's endpoint URL (https). The secret is shown once: give it to the partner.
2. Map each room type and rate plan to the partner's room and rate codes, then run **Full re-sync**.
3. The partner posts bookings to `https://<your-pms>/api/channels/<code>/inbound`.

Messages in both directions are JSON signed with `X-Azeli-Signature: sha256=<HMAC-SHA256 of the raw body, keyed with the channel secret>`.
Outgoing: `{ event: "ari.update" | "ari.full_sync", currency, items: [{ room_code, rate_code, date, available, rate, min_stay, closed }] }`.
Incoming: `{ event: "booking.created" | "booking.modified" | "booking.cancelled", booking: { id, room_code, rate_code, arrival, departure, adults, guest: { first_name, last_name, email, phone }, nightly: [{ date, rate }] } }`.
If the partner uses a different format, a small bridge service can translate. The built-in **simulator** channel lets you try all of this first.

Settings: `ARI_PUSH_SECONDS` (default 20, 0 = off), `PUBLIC_WRITE_LIMIT` / `PUBLIC_READ_LIMIT` (booking-page requests per visitor per minute, default 10 / 60).

## Tests

```bash
createdb hk_pms_test
TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/hk_pms_test npm test
```

The test suite wipes and rebuilds the **test** database. It covers sign-in and lockout, role permissions, overbooking including simultaneous bookings, check-in rules, VAT postings, voids, payments, check-out, the night audit, stay changes, balanced books and the audit trail, plus HR & payroll (PAYE bands, permissions, leave balances and approvals, rosters, attendance including night shifts, pro-rata and unpaid-leave pay, overtime, advances, approval by someone else, postings, payslip privacy, leavers) and finance (company accounts, credit limits, invoices with VAT, receipts, aging, supplier bills with input VAT, supplier payments, expenses, transfers with fees, chart of accounts, manual journals, books lock, statements, VAT, bank reconciliation, OTA commission, online prepayment), the booking engine and channel manager (pricing, calendar restrictions, online booking/lookup/cancel, simultaneous last-room bookings, rate limiting, nightly charges, signed pushes to a test provider endpoint, failures, signed inbound bookings, duplicates, changes, cancellations, overbooking) and the POS (bills, kitchen/bar tickets, notes, item and bill voids, split payments, charge to room, shift cash-up, F&B reports) and inventory (opening stock, purchase-order approval and part deliveries, weighted average cost, requisition approval and issue, recipe deduction on POS sales, write-offs, stock counts and reports).

## Going live checklist

- Host behind HTTPS (set `NODE_ENV=production` so cookies are marked Secure).
- Use a managed PostgreSQL with daily backups.
- Change the admin password and create one account per staff member.
- Confirm VAT and any statutory rates with your accountant before relying on reports.

## Roadmap

| Phase | Scope |
|---|---|
| **1. Foundation & front office** (done) | Accounts & roles, reservations, check-in/out, folios, payments, night audit, accounting core, daily report, audit log |
| **2. Restaurant / POS** (done) | Outlets, menus, table orders, kitchen/bar tickets, charge to room, split payments, shift cash-up, F&B reports |
| **3. Inventory & requisitions** (done) | Stores, suppliers, purchase orders, goods received, departmental requisitions with approvals, recipes and POS stock deduction, stock counts, write-offs, reports |
| **4. Booking engine & channel manager** (done) | Rate plans and calendar, public booking page, channel manager with signed push/receive, ready for a certified partner. Online payment follows with Phase 5 |
| **5. Accounting & finance** (done) | Company accounts and invoicing, supplier bills and payments, expenses, transfers, chart of accounts, manual journals, closing the books, bank reconciliation, P&L, balance sheet, ledger, VAT summary, OTA commission, online payment (provider-neutral). Still to come: a live payment provider and URA EFRIS e-invoicing, both needing accounts with those services |
| **6. HR & payroll** (done) | Employees, rosters, attendance, leave, staff advances, payroll with PAYE/NSSF posted to the accounts, payslips and statutory schedules, staff self-service |
| **7. Events, assets & amenities** (done) | Function rooms, packages, event bookings with deposits, BEOs and billing; asset register with depreciation and disposals; maintenance work orders and preventive schedules; spa/transfer/tour/laundry sales with charge to room |
| **8. Automated reporting & group** (done) | Department reports on screen and by scheduled email, email outbox with retries, multi-property group dashboard with revocable access keys |
| **9. Guest CRM & marketing** (done) | Guest profiles and history, duplicate merging, consent and unsubscribe, segments, email campaigns, pre-arrival and review-request emails, data export and erasure |
