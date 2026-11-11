-- Phase 4: rate plans, rate calendar, website booking engine and channel manager

-- Booking engine settings
ALTER TABLE settings
  ADD COLUMN booking_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN booking_intro        TEXT NOT NULL DEFAULT 'Book direct for our best rate.',
  ADD COLUMN cancellation_policy  TEXT NOT NULL DEFAULT 'Free cancellation until the day before arrival on flexible rates. Non-refundable rates cannot be cancelled.',
  ADD COLUMN check_in_time        TIME NOT NULL DEFAULT '14:00',
  ADD COLUMN booking_horizon_days INT NOT NULL DEFAULT 365 CHECK (booking_horizon_days BETWEEN 7 AND 730),
  ADD COLUMN contact_phone        TEXT,
  ADD COLUMN contact_email        TEXT;

CREATE TABLE rate_plans (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct < 100),
  breakfast    BOOLEAN NOT NULL DEFAULT FALSE,
  refundable   BOOLEAN NOT NULL DEFAULT TRUE,
  min_stay     INT NOT NULL DEFAULT 1 CHECK (min_stay >= 1),
  on_website   BOOLEAN NOT NULL DEFAULT TRUE,
  on_channels  BOOLEAN NOT NULL DEFAULT TRUE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INT NOT NULL DEFAULT 0
);

-- Date-specific prices and restrictions per room type (blank = use the standard rate / no restriction)
CREATE TABLE rate_calendar (
  room_type_id INT NOT NULL REFERENCES room_types(id),
  date         DATE NOT NULL,
  rate         BIGINT CHECK (rate >= 0),
  min_stay     INT CHECK (min_stay >= 1),
  stop_sell    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (room_type_id, date)
);

CREATE TABLE channels (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,30}$'),
  name           TEXT NOT NULL,
  adapter        TEXT NOT NULL CHECK (adapter IN ('simulator','webhook')),
  endpoint_url   TEXT,                       -- where availability & rates are pushed (webhook adapter)
  secret         TEXT NOT NULL,              -- shared secret for signing messages both ways
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct < 100),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  last_push_at   TIMESTAMPTZ,
  last_error     TEXT
);
CREATE TABLE channel_mappings (
  channel_id         INT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  room_type_id       INT NOT NULL REFERENCES room_types(id),
  rate_plan_id       INT NOT NULL REFERENCES rate_plans(id),
  external_room_code TEXT NOT NULL,
  external_rate_code TEXT NOT NULL,
  PRIMARY KEY (channel_id, room_type_id, rate_plan_id),
  UNIQUE (channel_id, external_room_code, external_rate_code)
);
CREATE TABLE channel_log (
  id         BIGSERIAL PRIMARY KEY,
  channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('out','in')),
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('ok','error')),
  summary    TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channel_log_channel_idx ON channel_log(channel_id, id DESC);

-- Availability/rate changes waiting to be pushed to channels
CREATE TABLE ari_outbox (
  id           BIGSERIAL PRIMARY KEY,
  room_type_id INT REFERENCES room_types(id),   -- NULL = all room types
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL,                   -- inclusive
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX ari_outbox_pending_idx ON ari_outbox(id) WHERE processed_at IS NULL;

-- Reservations: rate plan, channel, per-night prices, public lookup
ALTER TABLE reservations
  ADD COLUMN rate_plan_id   INT REFERENCES rate_plans(id),
  ADD COLUMN channel_id     INT REFERENCES channels(id),
  ADD COLUMN external_ref   TEXT,
  ADD COLUMN commission_pct NUMERIC(5,2),
  ADD COLUMN overbooked     BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX reservations_channel_ref ON reservations(channel_id, external_ref) WHERE channel_id IS NOT NULL;

CREATE TABLE reservation_nights (
  reservation_id INT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  night          DATE NOT NULL,
  rate           BIGINT NOT NULL CHECK (rate >= 0),
  PRIMARY KEY (reservation_id, night)
);

CREATE INDEX guests_email_idx ON guests(lower(email));
