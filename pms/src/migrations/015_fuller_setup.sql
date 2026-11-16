-- Phase 15: fuller guest profiles and set-up records (room types, rooms, rate plans, users)

ALTER TABLE guests
  ADD COLUMN phone2        TEXT,
  ADD COLUMN city          TEXT,
  ADD COLUMN country       TEXT,
  ADD COLUMN employer      TEXT,
  ADD COLUMN occupation    TEXT,
  ADD COLUMN language      TEXT,
  ADD COLUMN room_prefs    TEXT[] NOT NULL DEFAULT '{}',   -- high floor, quiet, twin beds … (from a fixed list)
  ADD COLUMN dietary       TEXT,                           -- vegetarian, halal, no pork …
  ADD COLUMN allergies     TEXT,                           -- shown as a warning
  ADD COLUMN anniversary   DATE,
  ADD COLUMN contact_prefs TEXT[] NOT NULL DEFAULT '{}';   -- how they like to be reached: whatsapp, email, sms, phone

ALTER TABLE room_types
  ADD COLUMN description    TEXT,
  ADD COLUMN bed_type       TEXT,
  ADD COLUMN size_sqm       INT CHECK (size_sqm IS NULL OR size_sqm BETWEEN 5 AND 1000),
  ADD COLUMN max_adults     INT CHECK (max_adults IS NULL OR max_adults BETWEEN 1 AND 20),
  ADD COLUMN max_children   INT CHECK (max_children IS NULL OR max_children BETWEEN 0 AND 20),
  ADD COLUMN extra_bed_rate BIGINT CHECK (extra_bed_rate IS NULL OR extra_bed_rate >= 0),
  ADD COLUMN amenities      TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN sort           INT NOT NULL DEFAULT 0;

ALTER TABLE rooms
  ADD COLUMN view        TEXT,
  ADD COLUMN bed_setup   TEXT,
  ADD COLUMN features    TEXT[] NOT NULL DEFAULT '{}',     -- balcony, bathtub, connecting, accessible, smoking …
  ADD COLUMN connects_to TEXT;                             -- the room number of a connecting room

ALTER TABLE rate_plans
  ADD COLUMN meal_plan     TEXT NOT NULL DEFAULT 'room_only' CHECK (meal_plan IN ('room_only','bb','hb','fb','ai')),
  ADD COLUMN cancel_days   INT CHECK (cancel_days IS NULL OR cancel_days BETWEEN 0 AND 365),   -- free cancellation until N days before arrival
  ADD COLUMN deposit_pct   INT NOT NULL DEFAULT 0 CHECK (deposit_pct BETWEEN 0 AND 100),
  ADD COLUMN valid_from    DATE,
  ADD COLUMN valid_to      DATE,
  ADD COLUMN arrival_days  INT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',                         -- weekdays a stay may start (0 = Sunday)
  ADD COLUMN max_stay      INT CHECK (max_stay IS NULL OR max_stay >= 1),
  ADD COLUMN min_advance   INT NOT NULL DEFAULT 0 CHECK (min_advance BETWEEN 0 AND 365);     -- book at least N days ahead
UPDATE rate_plans SET meal_plan = 'bb' WHERE breakfast;
UPDATE rate_plans SET cancel_days = 1 WHERE refundable;

ALTER TABLE users
  ADD COLUMN email      TEXT,
  ADD COLUMN phone      TEXT,
  ADD COLUMN department TEXT,
  ADD COLUMN job_title  TEXT;
