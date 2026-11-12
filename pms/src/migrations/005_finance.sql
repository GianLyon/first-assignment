-- Phase 5: Accounting & finance

-- Chart of accounts: cash/bank flag, active flag, system (protected) accounts
ALTER TABLE accounts ADD COLUMN is_cash BOOLEAN NOT NULL DEFAULT FALSE,
                     ADD COLUMN active  BOOLEAN NOT NULL DEFAULT TRUE,
                     ADD COLUMN system  BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE accounts SET system = TRUE;
UPDATE accounts SET is_cash = TRUE WHERE code IN ('1000','1020','1030');
UPDATE accounts SET name = 'Bank (main account)' WHERE code = '1030';
INSERT INTO accounts (code, name, type, system) VALUES
  ('2300', 'OTA commissions payable', 'liability', TRUE),
  ('3100', 'Retained earnings', 'equity', TRUE),
  ('5300', 'OTA commissions', 'expense', TRUE),
  ('5800', 'Bank & mobile money charges', 'expense', TRUE)
ON CONFLICT (code) DO NOTHING;
INSERT INTO accounts (code, name, type) VALUES
  ('6100', 'Utilities (power, water, internet)', 'expense'),
  ('6200', 'Repairs & maintenance', 'expense'),
  ('6300', 'Marketing & advertising', 'expense'),
  ('6400', 'Rent & rates', 'expense'),
  ('6500', 'Transport & fuel', 'expense'),
  ('6600', 'Professional fees', 'expense'),
  ('6900', 'Other operating expenses', 'expense')
ON CONFLICT (code) DO NOTHING;

-- Books lock: nothing can be posted on or before this date
ALTER TABLE settings ADD COLUMN books_locked_until DATE,
                     ADD COLUMN online_payments    BOOLEAN NOT NULL DEFAULT FALSE,
                     ADD COLUMN payment_provider   TEXT NOT NULL DEFAULT 'simulator';

-- Which journal lines have been ticked off on a bank reconciliation
CREATE TABLE bank_reconciliations (
  id                SERIAL PRIMARY KEY,
  account_code      TEXT NOT NULL REFERENCES accounts(code),
  statement_date    DATE NOT NULL,
  statement_balance BIGINT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finished')),
  created_by        INT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_by       INT REFERENCES users(id),
  finished_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_open_rec_per_account ON bank_reconciliations(account_code) WHERE status = 'open';
ALTER TABLE journal_lines ADD COLUMN reconciliation_id INT REFERENCES bank_reconciliations(id);

/* ---------------- receivables: company accounts ---------------- */
CREATE TABLE companies (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  tin          TEXT,
  contact      TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  credit_limit BIGINT NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),   -- 0 = no limit
  terms_days   INT NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 180),
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
-- existing free-text company names become company records
INSERT INTO companies (name) SELECT DISTINCT trim(company_name) FROM reservations WHERE company_name IS NOT NULL AND trim(company_name) <> '' ON CONFLICT DO NOTHING;
ALTER TABLE reservations ADD COLUMN company_id INT REFERENCES companies(id);
UPDATE reservations r SET company_id = c.id FROM companies c WHERE c.name = trim(r.company_name);
ALTER TABLE payments ADD COLUMN company_id INT REFERENCES companies(id);
UPDATE payments p SET company_id = r.company_id FROM reservations r WHERE r.id = p.reservation_id AND p.method = 'company_account';

CREATE SEQUENCE invoice_no_seq START 1001;
CREATE TABLE invoices (
  id               SERIAL PRIMARY KEY,
  number           TEXT NOT NULL UNIQUE DEFAULT ('INV' || nextval('invoice_no_seq')),
  company_id       INT NOT NULL REFERENCES companies(id),
  invoice_date     DATE NOT NULL,
  due_date         DATE NOT NULL,
  total            BIGINT NOT NULL CHECK (total > 0),
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id),   -- only for extra charges billed directly
  void_reason      TEXT
);
CREATE TABLE invoice_lines (
  id          SERIAL PRIMARY KEY,
  invoice_id  INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payment_id  BIGINT REFERENCES payments(id),          -- a guest bill moved to the company account
  department  TEXT CHECK (department IN ('rooms','fnb','amenities','events','other')),  -- extra charge
  description TEXT NOT NULL,
  amount      BIGINT NOT NULL CHECK (amount > 0)
);
CREATE UNIQUE INDEX invoice_lines_payment ON invoice_lines(payment_id) WHERE payment_id IS NOT NULL;

CREATE SEQUENCE receipt_no_seq START 1001;
CREATE TABLE ar_receipts (
  id               SERIAL PRIMARY KEY,
  number           TEXT NOT NULL UNIQUE DEFAULT ('RCT' || nextval('receipt_no_seq')),
  company_id       INT NOT NULL REFERENCES companies(id),
  receipt_date     DATE NOT NULL,
  account_code     TEXT NOT NULL REFERENCES accounts(code),   -- cash / bank / mobile money received into
  amount           BIGINT NOT NULL CHECK (amount > 0),
  reference        TEXT,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id)
);
CREATE TABLE ar_allocations (
  receipt_id INT NOT NULL REFERENCES ar_receipts(id),
  invoice_id INT NOT NULL REFERENCES invoices(id),
  amount     BIGINT NOT NULL CHECK (amount > 0),
  PRIMARY KEY (receipt_id, invoice_id)
);

/* ---------------- payables: supplier bills & payments ---------------- */
CREATE TABLE supplier_bills (
  id               SERIAL PRIMARY KEY,
  supplier_id      INT NOT NULL REFERENCES suppliers(id),
  bill_number      TEXT NOT NULL,                 -- the supplier's invoice number
  bill_date        DATE NOT NULL,
  due_date         DATE NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('stock','expense')),
  total            BIGINT NOT NULL CHECK (total > 0),
  vat              BIGINT NOT NULL DEFAULT 0 CHECK (vat >= 0),
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  UNIQUE (supplier_id, bill_number)
);
CREATE TABLE bill_grns (
  bill_id INT NOT NULL REFERENCES supplier_bills(id) ON DELETE CASCADE,
  grn_id  INT NOT NULL UNIQUE REFERENCES goods_received(id),
  PRIMARY KEY (bill_id, grn_id)
);
CREATE TABLE bill_lines (
  id           SERIAL PRIMARY KEY,
  bill_id      INT NOT NULL REFERENCES supplier_bills(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  description  TEXT NOT NULL,
  amount       BIGINT NOT NULL CHECK (amount > 0),   -- before VAT
  vat          BIGINT NOT NULL DEFAULT 0 CHECK (vat >= 0)
);

CREATE SEQUENCE supplier_payment_seq START 1001;
CREATE TABLE supplier_payments (
  id               SERIAL PRIMARY KEY,
  number           TEXT NOT NULL UNIQUE DEFAULT ('PAY' || nextval('supplier_payment_seq')),
  supplier_id      INT NOT NULL REFERENCES suppliers(id),
  payment_date     DATE NOT NULL,
  account_code     TEXT NOT NULL REFERENCES accounts(code),   -- paid from
  amount           BIGINT NOT NULL CHECK (amount > 0),
  reference        TEXT,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id)
);
CREATE TABLE ap_allocations (
  payment_id INT NOT NULL REFERENCES supplier_payments(id),
  bill_id    INT NOT NULL REFERENCES supplier_bills(id),
  amount     BIGINT NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, bill_id)
);

/* ---------------- money out, transfers, manual journals ---------------- */
CREATE TABLE expenses (
  id               SERIAL PRIMARY KEY,
  expense_date     DATE NOT NULL,
  account_code     TEXT NOT NULL REFERENCES accounts(code),   -- what it was for (expense or liability)
  paid_from        TEXT NOT NULL REFERENCES accounts(code),   -- cash / bank / mobile money
  amount           BIGINT NOT NULL CHECK (amount > 0),        -- total paid
  vat              BIGINT NOT NULL DEFAULT 0 CHECK (vat >= 0),
  payee            TEXT NOT NULL,
  description      TEXT NOT NULL,
  reference        TEXT,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id)
);
CREATE TABLE transfers (
  id               SERIAL PRIMARY KEY,
  transfer_date    DATE NOT NULL,
  from_account     TEXT NOT NULL REFERENCES accounts(code),
  to_account       TEXT NOT NULL REFERENCES accounts(code),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  fee              BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
  description      TEXT,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  CHECK (from_account <> to_account), CHECK (fee < amount)
);

/* ---------------- online payments (booking engine) ---------------- */
CREATE TABLE payment_intents (
  id             SERIAL PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,
  reservation_id INT NOT NULL REFERENCES reservations(id),
  amount         BIGINT NOT NULL CHECK (amount > 0),
  provider       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired')),
  provider_ref   TEXT,
  method         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ,
  payment_id     BIGINT REFERENCES payments(id)
);
CREATE UNIQUE INDEX payment_intents_provider_ref ON payment_intents(provider, provider_ref) WHERE provider_ref IS NOT NULL;
