# Hearth & Key PMS

The hotel property management system offered to Hearth & Key marketing partners.
Built so far: **Phase 1 (foundation and front office)**, **Phase 2 (restaurant / POS)** and **Phase 3 (inventory, purchasing and requisitions)**. It is a real system with a database, staff accounts and accounting. It is not a demo.
The clickable sales demo lives separately in `../pms-demo/`.

## What it does

| Area | Features |
|---|---|
| Staff accounts | Individual sign-in, nine roles (admin, manager, front office, night auditor, housekeeping, accountant, waiter/cashier, kitchen/bar, storekeeper), password change/reset, account disable, sign-in lockout after 5 failed attempts |
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

Money is stored in whole Ugandan shillings. Each property gets its own database.

## Run it

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

## Tests

```bash
createdb hk_pms_test
TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/hk_pms_test npm test
```

The test suite wipes and rebuilds the **test** database. It covers sign-in and lockout, role permissions, overbooking including simultaneous bookings, check-in rules, VAT postings, voids, payments, check-out, the night audit, stay changes, balanced books and the audit trail, plus the POS (bills, kitchen/bar tickets, notes, item and bill voids, split payments, charge to room, shift cash-up, F&B reports) and inventory (opening stock, purchase-order approval and part deliveries, weighted average cost, requisition approval and issue, recipe deduction on POS sales, write-offs, stock counts and reports).

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
| 4. Booking engine & channel manager | Public booking page with online payment (card / mobile money), OTA connectivity via a channel-manager partner API |
| 5. Accounting & finance | Company (city ledger) invoicing, supplier invoices and payments (accounts payable from Phase 3 deliveries), bank reconciliation, P&L and balance sheet, EFRIS e-invoicing |
| 6. HR & payroll | Staff records, rosters, attendance, leave, payroll with PAYE/NSSF |
| 7. Events, assets & amenities | Function rooms and BEOs, asset register and maintenance, spa/transfer/tour sales |
| 8. Automated reporting | Scheduled department reports by email, multi-property dashboards |
