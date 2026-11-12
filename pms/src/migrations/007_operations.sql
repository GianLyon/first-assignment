-- Phase 7: amenities, events & banqueting, assets & maintenance

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','front_office','housekeeping','accountant','night_auditor','waiter','kitchen','storekeeper','hr_officer','maintenance'));

INSERT INTO accounts (code, name, type, system) VALUES
  ('1500', 'Property, plant & equipment', 'asset', TRUE),
  ('1590', 'Accumulated depreciation', 'asset', TRUE),
  ('6800', 'Depreciation', 'expense', TRUE),
  ('6810', 'Loss on disposal of assets', 'expense', TRUE),
  ('4910', 'Gain on disposal of assets', 'revenue', TRUE),
  ('4920', 'Forfeited deposits', 'revenue', TRUE)
ON CONFLICT (code) DO NOTHING;

/* ---------------- amenities ---------------- */
CREATE TABLE amenities (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  category     TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('spa','transport','tour','laundry','leisure','other')),
  price        BIGINT NOT NULL CHECK (price >= 0),        -- VAT-inclusive, per unit
  duration_min INT CHECK (duration_min > 0),               -- for scheduled services
  description  TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE SEQUENCE amenity_booking_seq START 1001;
CREATE TABLE amenity_bookings (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE DEFAULT ('A' || nextval('amenity_booking_seq')),
  amenity_id     INT NOT NULL REFERENCES amenities(id),
  service_date   DATE NOT NULL,
  start_time     TIME,
  qty            INT NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price     BIGINT NOT NULL CHECK (unit_price >= 0),
  reservation_id INT REFERENCES reservations(id),         -- in-house guest
  guest_name     TEXT NOT NULL,
  phone          TEXT,
  staff          TEXT,                                    -- therapist, driver, guide…
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled','no_show')),
  settled_by     TEXT CHECK (settled_by IN ('room','cash','card','mobile_money')),
  folio_charge_id BIGINT REFERENCES folio_charges(id),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX amenity_bookings_date_idx ON amenity_bookings(service_date);

/* ---------------- events & banqueting ---------------- */
CREATE TABLE function_rooms (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  capacity      INT NOT NULL CHECK (capacity > 0),
  hire_full_day BIGINT NOT NULL DEFAULT 0 CHECK (hire_full_day >= 0),
  hire_half_day BIGINT NOT NULL DEFAULT 0 CHECK (hire_half_day >= 0),
  active        BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE event_packages (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  per_person  BIGINT NOT NULL CHECK (per_person >= 0),
  includes    TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE SEQUENCE event_code_seq START 1001;
CREATE TABLE events (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE DEFAULT ('EV' || nextval('event_code_seq')),
  title            TEXT NOT NULL,
  event_type       TEXT NOT NULL DEFAULT 'conference' CHECK (event_type IN ('conference','meeting','wedding','party','workshop','other')),
  status           TEXT NOT NULL DEFAULT 'enquiry' CHECK (status IN ('enquiry','tentative','confirmed','completed','cancelled')),
  event_date       DATE NOT NULL,
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  function_room_id INT NOT NULL REFERENCES function_rooms(id),
  company_id       INT REFERENCES companies(id),
  contact_name     TEXT NOT NULL,
  contact_phone    TEXT,
  contact_email    TEXT,
  pax              INT NOT NULL CHECK (pax > 0),
  package_id       INT REFERENCES event_packages(id),
  per_person       BIGINT NOT NULL DEFAULT 0 CHECK (per_person >= 0),  -- agreed package price
  hire_type        TEXT NOT NULL DEFAULT 'none' CHECK (hire_type IN ('none','half_day','full_day')),
  room_hire        BIGINT NOT NULL DEFAULT 0 CHECK (room_hire >= 0),
  setup_style      TEXT,                       -- theatre, classroom, banquet, U-shape, cocktail
  beo_notes        JSONB NOT NULL DEFAULT '{}', -- instructions per department
  notes            TEXT,
  cancel_reason    TEXT,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  invoice_id       INT REFERENCES invoices(id),
  CHECK (end_time > start_time)
);
CREATE INDEX events_date_idx ON events(event_date);
CREATE TABLE event_extras (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty         INT NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price  BIGINT NOT NULL CHECK (unit_price >= 0)
);
CREATE TABLE event_payments (
  id               SERIAL PRIMARY KEY,
  event_id         INT NOT NULL REFERENCES events(id),
  kind             TEXT NOT NULL CHECK (kind IN ('deposit','refund')),
  account_code     TEXT NOT NULL REFERENCES accounts(code),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  reference        TEXT,
  business_date    DATE NOT NULL,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id)
);

/* ---------------- assets & maintenance ---------------- */
CREATE SEQUENCE asset_code_seq START 1001;
CREATE TABLE assets (
  id                    SERIAL PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE DEFAULT ('AS' || nextval('asset_code_seq')),
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'equipment' CHECK (category IN ('building','furniture','equipment','kitchen','vehicle','it','other')),
  location              TEXT,
  serial_no             TEXT,
  supplier              TEXT,
  purchase_date         DATE NOT NULL,
  cost                  BIGINT NOT NULL CHECK (cost >= 0),
  residual_value        BIGINT NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  useful_life_months    INT NOT NULL CHECK (useful_life_months > 0),
  accumulated_dep       BIGINT NOT NULL DEFAULT 0 CHECK (accumulated_dep >= 0),
  status                TEXT NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use','under_repair','disposed')),
  service_interval_days INT CHECK (service_interval_days > 0),
  last_service_date     DATE,
  disposed_date         DATE,
  disposal_proceeds     BIGINT,
  notes                 TEXT,
  created_by            INT REFERENCES users(id),
  journal_entry_id      BIGINT REFERENCES journal_entries(id),
  CHECK (residual_value <= cost), CHECK (accumulated_dep <= cost)
);
CREATE TABLE depreciation_runs (
  period           TEXT PRIMARY KEY CHECK (period ~ '^\d{4}-\d{2}$'),
  total            BIGINT NOT NULL,
  assets           INT NOT NULL,
  run_by           INT REFERENCES users(id),
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id)
);

CREATE SEQUENCE work_order_seq START 1001;
CREATE TABLE work_orders (
  id                SERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE DEFAULT ('WO' || nextval('work_order_seq')),
  title             TEXT NOT NULL,
  description       TEXT,
  kind              TEXT NOT NULL DEFAULT 'repair' CHECK (kind IN ('repair','preventive','inspection')),
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','on_hold','done','cancelled')),
  asset_id          INT REFERENCES assets(id),
  room_id           INT REFERENCES rooms(id),
  location          TEXT,
  room_out_of_order BOOLEAN NOT NULL DEFAULT FALSE,   -- this job took the room out of order
  assigned_to       TEXT,
  due_date          DATE,
  cost              BIGINT NOT NULL DEFAULT 0 CHECK (cost >= 0),
  completion_notes  TEXT,
  reported_by       INT REFERENCES users(id),
  reported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by      INT REFERENCES users(id),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX work_orders_status_idx ON work_orders(status);
