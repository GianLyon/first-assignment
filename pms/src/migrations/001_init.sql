-- Hearth & Key PMS: initial schema (one database per property).
-- Money is stored as whole Ugandan shillings in BIGINT (UGX has no minor unit in use).

CREATE TABLE settings (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  property_name  TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'UGX',
  business_date  DATE NOT NULL,
  vat_rate       NUMERIC(5,2) NOT NULL DEFAULT 18.00 CHECK (vat_rate >= 0 AND vat_rate < 100),
  timezone       TEXT NOT NULL DEFAULT 'Africa/Kampala',
  check_out_time TIME NOT NULL DEFAULT '11:00'
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 40),
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','manager','front_office','housekeeping','accountant','night_auditor')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE audit_log (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   INT REFERENCES users(id),
  action    TEXT NOT NULL,
  entity    TEXT,
  entity_id TEXT,
  details   JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log(at DESC);

CREATE TABLE room_types (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  base_rate     BIGINT NOT NULL CHECK (base_rate >= 0),
  max_occupancy INT NOT NULL DEFAULT 2 CHECK (max_occupancy > 0),
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE rooms (
  id           SERIAL PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,
  room_type_id INT NOT NULL REFERENCES room_types(id),
  floor        TEXT,
  hk_status    TEXT NOT NULL DEFAULT 'clean' CHECK (hk_status IN ('clean','dirty','out_of_order')),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes        TEXT
);

CREATE TABLE guests (
  id          SERIAL PRIMARY KEY,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL DEFAULT '',
  phone       TEXT,
  email       TEXT,
  nationality TEXT,
  id_type     TEXT,
  id_number   TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guests_name_idx ON guests(lower(last_name), lower(first_name));

CREATE SEQUENCE reservation_code_seq START 1001;
CREATE TABLE reservations (
  id              SERIAL PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE DEFAULT ('R' || nextval('reservation_code_seq')),
  guest_id        INT NOT NULL REFERENCES guests(id),
  room_type_id    INT NOT NULL REFERENCES room_types(id),
  room_id         INT REFERENCES rooms(id),
  arrival         DATE NOT NULL,
  departure       DATE NOT NULL,
  adults          INT NOT NULL DEFAULT 1 CHECK (adults > 0),
  children        INT NOT NULL DEFAULT 0 CHECK (children >= 0),
  rate            BIGINT NOT NULL CHECK (rate >= 0),
  source          TEXT NOT NULL DEFAULT 'Direct',
  status          TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','in_house','checked_out','cancelled','no_show')),
  company_name    TEXT,
  notes           TEXT,
  cancel_reason   TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_in_at   TIMESTAMPTZ,
  checked_out_at  TIMESTAMPTZ,
  CHECK (departure > arrival)
);
CREATE INDEX reservations_dates_idx ON reservations(arrival, departure);
CREATE INDEX reservations_status_idx ON reservations(status);
-- A room can only hold one in-house reservation at a time.
CREATE UNIQUE INDEX one_guest_per_room ON reservations(room_id) WHERE status = 'in_house';

-- Chart of accounts and double-entry journal
CREATE TABLE accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense'))
);

CREATE TABLE journal_entries (
  id            BIGSERIAL PRIMARY KEY,
  business_date DATE NOT NULL,
  description   TEXT NOT NULL,
  ref_type      TEXT,
  ref_id        TEXT,
  created_by    INT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_date_idx ON journal_entries(business_date);

CREATE TABLE journal_lines (
  id           BIGSERIAL PRIMARY KEY,
  entry_id     BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit        BIGINT NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       BIGINT NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_code);

-- Every journal entry must balance. Checked at commit so multi-line inserts can complete first.
CREATE FUNCTION check_entry_balanced() RETURNS trigger AS $$
DECLARE diff BIGINT;
BEGIN
  SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) INTO diff FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'Journal entry % does not balance (difference %)', NEW.entry_id, diff;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT OR UPDATE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Guest folio: charges and payments against a reservation
CREATE TABLE folio_charges (
  id             BIGSERIAL PRIMARY KEY,
  reservation_id INT NOT NULL REFERENCES reservations(id),
  business_date  DATE NOT NULL,
  description    TEXT NOT NULL,
  department     TEXT NOT NULL CHECK (department IN ('rooms','fnb','amenities','events','other')),
  amount         BIGINT NOT NULL CHECK (amount > 0),
  posted_by      INT REFERENCES users(id),
  posted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided         BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason    TEXT,
  voided_by      INT REFERENCES users(id),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  void_entry_id  BIGINT REFERENCES journal_entries(id)
);
CREATE INDEX folio_charges_res_idx ON folio_charges(reservation_id);
-- Night audit posts at most one room charge per reservation per night.
CREATE UNIQUE INDEX one_room_charge_per_night ON folio_charges(reservation_id, business_date)
  WHERE department = 'rooms' AND description LIKE 'Room charge%' AND NOT voided;

CREATE TABLE payments (
  id             BIGSERIAL PRIMARY KEY,
  reservation_id INT NOT NULL REFERENCES reservations(id),
  business_date  DATE NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('cash','card','mobile_money','bank_transfer','company_account')),
  amount         BIGINT NOT NULL CHECK (amount > 0),
  reference      TEXT,
  posted_by      INT REFERENCES users(id),
  posted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided         BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason    TEXT,
  voided_by      INT REFERENCES users(id),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  void_entry_id  BIGINT REFERENCES journal_entries(id)
);
CREATE INDEX payments_res_idx ON payments(reservation_id);

CREATE TABLE night_audits (
  business_date       DATE PRIMARY KEY,
  run_by              INT REFERENCES users(id),
  run_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  room_charges_posted INT NOT NULL,
  room_revenue        BIGINT NOT NULL,
  no_shows            INT NOT NULL
);

INSERT INTO accounts (code, name, type) VALUES
  ('1000', 'Cash on hand', 'asset'),
  ('1010', 'Card clearing', 'asset'),
  ('1020', 'Mobile money', 'asset'),
  ('1030', 'Bank', 'asset'),
  ('1100', 'Guest ledger', 'asset'),
  ('1200', 'Accounts receivable (company accounts)', 'asset'),
  ('2100', 'VAT payable', 'liability'),
  ('2200', 'Guest deposits', 'liability'),
  ('3000', 'Owner''s equity', 'equity'),
  ('4000', 'Room revenue', 'revenue'),
  ('4100', 'Food & beverage revenue', 'revenue'),
  ('4200', 'Amenities revenue', 'revenue'),
  ('4300', 'Events revenue', 'revenue'),
  ('4900', 'Other revenue', 'revenue');
