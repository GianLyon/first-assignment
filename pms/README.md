# Hearth & Key PMS

The hotel property management system offered to Hearth & Key marketing partners.
This is **Phase 1: the foundation and front office**. It is a real system with a database, staff accounts and accounting. It is not a demo.
The clickable sales demo lives separately in `../pms-demo/`.

## What Phase 1 does

| Area | Features |
|---|---|
| Staff accounts | Individual sign-in, six roles (admin, manager, front office, night auditor, housekeeping, accountant), password change/reset, account disable, sign-in lockout after 5 failed attempts |
| Front office | Dashboard, room board, reservations (create, edit, cancel, search), availability grid, check-in with room assignment and ID capture, check-out, walk-in via same-day booking |
| Overbooking protection | Availability is checked inside a locked transaction, so two receptionists cannot sell the last room at the same moment. The database also prevents two in-house guests in one room |
| Guest bills (folios) | Charges by department (rooms, F&B, amenities, events, other), payments (cash, card, mobile money, bank transfer, company account), voids with a reason (manager/accountant only), printable invoice |
| Housekeeping | Clean / dirty / out of order; rooms go dirty at check-out and nightly for stayovers |
| Night audit | Blocks until due-out guests are handled, posts one room charge per in-house guest (never twice), marks no-shows, advances the business date |
| Accounting core | Every charge, payment and void posts a balanced double entry automatically, with VAT (18% by default) split out of VAT-inclusive prices. The database refuses any unbalanced entry. Trial balance and journal views |
| Reports | Daily manager's report: occupancy, ADR, RevPAR, revenue by department, collections by method |
| Audit trail | Every sign-in, booking change, charge, payment, void, room change and night audit is logged with who and when |

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

`npm run seed` creates the property, an `admin` account and a starter set of room types and rooms (edit them under **Settings**). It does nothing if the property already exists. Without `ADMIN_PASSWORD` it generates one and prints it once.

Database migrations run automatically on start (`npm run migrate` runs them on their own).

## Tests

```bash
createdb hk_pms_test
TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/hk_pms_test npm test
```

The test suite wipes and rebuilds the **test** database. It covers sign-in and lockout, role permissions, overbooking including simultaneous bookings, check-in rules, VAT postings, voids, payments, check-out, the night audit, stay changes, balanced books and the audit trail.

## Going live checklist

- Host behind HTTPS (set `NODE_ENV=production` so cookies are marked Secure).
- Use a managed PostgreSQL with daily backups.
- Change the admin password and create one account per staff member.
- Confirm VAT and any statutory rates with your accountant before relying on reports.

## Roadmap

| Phase | Scope |
|---|---|
| **1. Foundation & front office** (this) | Accounts & roles, reservations, check-in/out, folios, payments, night audit, accounting core, daily report, audit log |
| 2. Restaurant / POS | Outlets, menus, table orders, kitchen/bar tickets, charge to room, cash-up, recipe stock deduction |
| 3. Inventory & requisitions | Stores, suppliers, purchase orders, goods received, departmental requisitions with approvals, stock counts |
| 4. Booking engine & channel manager | Public booking page with online payment (card / mobile money), OTA connectivity via a channel-manager partner API |
| 5. Accounting & finance | Company (city ledger) invoicing, supplier payments, bank reconciliation, P&L and balance sheet, EFRIS e-invoicing |
| 6. HR & payroll | Staff records, rosters, attendance, leave, payroll with PAYE/NSSF |
| 7. Events, assets & amenities | Function rooms and BEOs, asset register and maintenance, spa/transfer/tour sales |
| 8. Automated reporting | Scheduled department reports by email, multi-property dashboards |
