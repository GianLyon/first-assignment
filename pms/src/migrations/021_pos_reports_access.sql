-- Phase 20: deeper POS (restaurant, bar, spa, health club), printing, hotel-network-only access.

/* ---------- outlets ---------- */
ALTER TABLE outlets DROP CONSTRAINT IF EXISTS outlets_kind_check;
ALTER TABLE outlets ADD CONSTRAINT outlets_kind_check CHECK (kind IN ('restaurant','bar','room_service','spa','health_club','pool_bar','other'));
ALTER TABLE outlets
  ADD COLUMN happy_from     TIME,                       -- happy hour: items with a happy-hour price sell at it between these times
  ADD COLUMN happy_to       TIME,
  ADD COLUMN receipt_footer TEXT,                       -- e.g. "Thank you. Wi-Fi: Amaya-Guest"
  ADD COLUMN discount_limit_pct INT NOT NULL DEFAULT 10 CHECK (discount_limit_pct BETWEEN 0 AND 100); -- above this a manager approves

/* ---------- menu ---------- */
ALTER TABLE menu_categories DROP CONSTRAINT IF EXISTS menu_categories_station_check;
ALTER TABLE menu_categories ADD CONSTRAINT menu_categories_station_check CHECK (station IN ('kitchen','bar','none'));
ALTER TABLE menu_categories ADD COLUMN outlet_ids INT[] NOT NULL DEFAULT '{}';   -- empty = sold in every outlet
ALTER TABLE menu_items
  ADD COLUMN happy_price  BIGINT CHECK (happy_price >= 0),
  ADD COLUMN options      TEXT[] NOT NULL DEFAULT '{}',  -- choices the waiter must pick from: Rare / Medium / Well done
  ADD COLUMN duration_min INT CHECK (duration_min > 0),  -- spa treatments
  ADD COLUMN course       INT NOT NULL DEFAULT 1 CHECK (course BETWEEN 1 AND 4);  -- 1 starters/drinks, 2 mains, 3 desserts

/* ---------- bills ---------- */
ALTER TABLE pos_check_lines DROP CONSTRAINT IF EXISTS pos_check_lines_station_check;
ALTER TABLE pos_check_lines ADD CONSTRAINT pos_check_lines_station_check CHECK (station IN ('kitchen','bar','none'));
ALTER TABLE pos_check_lines
  ADD COLUMN option TEXT,
  ADD COLUMN course INT NOT NULL DEFAULT 1,
  ADD COLUMN held   BOOLEAN NOT NULL DEFAULT false,      -- waits until the waiter "fires" the course
  ADD COLUMN happy  BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE pos_checks DROP CONSTRAINT IF EXISTS pos_checks_status_check;
ALTER TABLE pos_checks ADD CONSTRAINT pos_checks_status_check CHECK (status IN ('open','settled','voided','merged'));
ALTER TABLE pos_checks
  ADD COLUMN waiter_id       INT REFERENCES users(id),
  ADD COLUMN discount_amount BIGINT NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN discount_reason TEXT,
  ADD COLUMN discount_by     INT REFERENCES users(id),
  ADD COLUMN settle_kind     TEXT NOT NULL DEFAULT 'sale' CHECK (settle_kind IN ('sale','complimentary','house_use')),
  ADD COLUMN settle_reason   TEXT,
  ADD COLUMN parent_id       INT REFERENCES pos_checks(id),   -- split from this bill
  ADD COLUMN guest_name      TEXT,
  ADD COLUMN bill_prints     INT NOT NULL DEFAULT 0,
  ADD COLUMN receipt_prints  INT NOT NULL DEFAULT 0;
UPDATE pos_checks SET waiter_id = opened_by WHERE waiter_id IS NULL;
-- a table may hold a split bill next to its main bill
DROP INDEX IF EXISTS one_open_check_per_table;
CREATE UNIQUE INDEX one_open_check_per_table ON pos_checks(table_id) WHERE status = 'open' AND table_id IS NOT NULL AND parent_id IS NULL;

ALTER TABLE kitchen_tickets ADD COLUMN course INT NOT NULL DEFAULT 1, ADD COLUMN printed_at TIMESTAMPTZ, ADD COLUMN prints INT NOT NULL DEFAULT 0;

-- every KOT, bill and receipt printed: reprints are marked COPY and counted
CREATE TABLE pos_prints (
  id         BIGSERIAL PRIMARY KEY,
  check_id   INT REFERENCES pos_checks(id),
  ticket_id  INT REFERENCES kitchen_tickets(id),
  kind       TEXT NOT NULL CHECK (kind IN ('kot','bill','receipt')),
  copy       BOOLEAN NOT NULL DEFAULT false,
  printed_by INT REFERENCES users(id),
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pos_prints_check ON pos_prints(check_id);

/* ---------- spa ---------- */
CREATE TABLE spa_therapists (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  skills  TEXT,
  user_id INT REFERENCES users(id),
  active  BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE spa_rooms (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  beds   INT NOT NULL DEFAULT 1 CHECK (beds > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE amenity_bookings
  ADD COLUMN therapist_id  INT REFERENCES spa_therapists(id),
  ADD COLUMN spa_room_id   INT REFERENCES spa_rooms(id),
  ADD COLUMN end_time      TIME,
  ADD COLUMN arrived_at    TIMESTAMPTZ;
ALTER TABLE amenity_bookings DROP CONSTRAINT IF EXISTS amenity_bookings_status_check;
ALTER TABLE amenity_bookings ADD CONSTRAINT amenity_bookings_status_check CHECK (status IN ('booked','arrived','in_progress','completed','cancelled','no_show'));
ALTER TABLE amenities DROP CONSTRAINT IF EXISTS amenities_category_check;
ALTER TABLE amenities ADD CONSTRAINT amenities_category_check CHECK (category IN ('spa','fitness','transport','tour','laundry','leisure','other'));

/* ---------- health club ---------- */
CREATE TABLE club_plans (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  months   INT NOT NULL CHECK (months BETWEEN 1 AND 36),
  price    BIGINT NOT NULL CHECK (price >= 0),
  includes TEXT,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE SEQUENCE club_member_seq START 1001;
CREATE TABLE club_members (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE DEFAULT ('M' || nextval('club_member_seq')),
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  guest_id   INT REFERENCES guests(id),
  plan_id    INT REFERENCES club_plans(id),
  starts_on  DATE,
  ends_on    DATE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','cancelled')),
  emergency_contact TEXT,
  health_notes TEXT,
  notes      TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE club_payments (
  id               SERIAL PRIMARY KEY,
  member_id        INT NOT NULL REFERENCES club_members(id),
  plan_id          INT REFERENCES club_plans(id),
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  amount           BIGINT NOT NULL CHECK (amount >= 0),
  method           TEXT NOT NULL CHECK (method IN ('cash','card','mobile_money','bank_transfer','room')),
  reference        TEXT,
  business_date    DATE NOT NULL,
  folio_charge_id  BIGINT REFERENCES folio_charges(id),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE club_visits (
  id         BIGSERIAL PRIMARY KEY,
  member_id  INT REFERENCES club_members(id),
  guest_name TEXT,                                    -- day pass or hotel guest without membership
  reservation_id INT REFERENCES reservations(id),
  kind       TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member','hotel_guest','day_pass')),
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_date DATE NOT NULL,
  recorded_by INT REFERENCES users(id)
);
CREATE INDEX club_visits_date ON club_visits(business_date);

/* ---------- hotel network only ---------- */
ALTER TABLE settings
  ADD COLUMN network_lock         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN allowed_networks     TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN network_exempt_roles TEXT[] NOT NULL DEFAULT '{admin,general_manager,finance_manager}';
ALTER TABLE users ADD COLUMN network_exempt BOOLEAN NOT NULL DEFAULT false;
