-- Phase 2: Restaurant / POS

-- New staff roles for food & beverage
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','front_office','housekeeping','accountant','night_auditor','waiter','kitchen'));

CREATE TABLE outlets (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  kind   TEXT NOT NULL DEFAULT 'restaurant' CHECK (kind IN ('restaurant','bar','room_service','other')),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE menu_categories (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  station TEXT NOT NULL DEFAULT 'kitchen' CHECK (station IN ('kitchen','bar')),  -- where its order tickets go
  sort    INT NOT NULL DEFAULT 0,
  active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE menu_items (
  id          SERIAL PRIMARY KEY,
  category_id INT NOT NULL REFERENCES menu_categories(id),
  name        TEXT NOT NULL,
  price       BIGINT NOT NULL CHECK (price >= 0),   -- VAT-inclusive, whole UGX
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (category_id, name)
);

CREATE TABLE dining_tables (
  id        SERIAL PRIMARY KEY,
  outlet_id INT NOT NULL REFERENCES outlets(id),
  name      TEXT NOT NULL,
  seats     INT NOT NULL DEFAULT 4 CHECK (seats > 0),
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (outlet_id, name)
);

-- Cashier shifts: opening float, then a cash count at close
CREATE TABLE pos_shifts (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  outlet_id     INT NOT NULL REFERENCES outlets(id),
  business_date DATE NOT NULL,
  opening_float BIGINT NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  expected_cash BIGINT,
  counted_cash  BIGINT CHECK (counted_cash >= 0),
  notes         TEXT
);
CREATE UNIQUE INDEX one_open_shift_per_user ON pos_shifts(user_id) WHERE closed_at IS NULL;

CREATE SEQUENCE pos_check_seq START 1001;
CREATE TABLE pos_checks (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE DEFAULT ('C' || nextval('pos_check_seq')),
  outlet_id      INT NOT NULL REFERENCES outlets(id),
  table_id       INT REFERENCES dining_tables(id),
  reservation_id INT REFERENCES reservations(id),       -- room service: the guest's stay
  covers         INT NOT NULL DEFAULT 1 CHECK (covers > 0),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','voided')),
  business_date  DATE NOT NULL,
  shift_id       INT REFERENCES pos_shifts(id),
  opened_by      INT REFERENCES users(id),
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_by     INT REFERENCES users(id),
  settled_at     TIMESTAMPTZ,
  void_reason    TEXT,
  notes          TEXT
);
CREATE INDEX pos_checks_status_idx ON pos_checks(status, outlet_id);
CREATE INDEX pos_checks_date_idx ON pos_checks(business_date);
-- One open bill per table
CREATE UNIQUE INDEX one_open_check_per_table ON pos_checks(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

CREATE TABLE kitchen_tickets (
  id         SERIAL PRIMARY KEY,
  check_id   INT NOT NULL REFERENCES pos_checks(id),
  station    TEXT NOT NULL CHECK (station IN ('kitchen','bar')),
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ready','served')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at   TIMESTAMPTZ,
  served_at  TIMESTAMPTZ
);
CREATE INDEX kitchen_tickets_station_idx ON kitchen_tickets(station, status);

CREATE TABLE pos_check_lines (
  id          BIGSERIAL PRIMARY KEY,
  check_id    INT NOT NULL REFERENCES pos_checks(id),
  item_id     INT REFERENCES menu_items(id),
  name        TEXT NOT NULL,              -- copied so later menu edits do not change past bills
  unit_price  BIGINT NOT NULL CHECK (unit_price >= 0),
  qty         INT NOT NULL CHECK (qty > 0),
  note        TEXT,
  station     TEXT NOT NULL CHECK (station IN ('kitchen','bar')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','voided')),
  ticket_id   INT REFERENCES kitchen_tickets(id),
  added_by    INT REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_by   INT REFERENCES users(id),
  void_reason TEXT
);
CREATE INDEX pos_check_lines_check_idx ON pos_check_lines(check_id);

CREATE TABLE pos_payments (
  id               BIGSERIAL PRIMARY KEY,
  check_id         INT NOT NULL REFERENCES pos_checks(id),
  method           TEXT NOT NULL CHECK (method IN ('cash','card','mobile_money','room')),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  reservation_id   INT REFERENCES reservations(id),
  folio_charge_id  BIGINT REFERENCES folio_charges(id),
  reference        TEXT,
  business_date    DATE NOT NULL,
  shift_id         INT REFERENCES pos_shifts(id),
  posted_by        INT REFERENCES users(id),
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  CHECK ((method = 'room') = (reservation_id IS NOT NULL))
);
CREATE INDEX pos_payments_check_idx ON pos_payments(check_id);
CREATE INDEX pos_payments_date_idx ON pos_payments(business_date);
