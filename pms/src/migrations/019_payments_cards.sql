-- Phase 18: website booking widget, Pesapal payments, OTA virtual cards.

-- booking engine: the hotel's own colour, and whether guests must pay online to keep the booking
ALTER TABLE settings
  ADD COLUMN booking_accent TEXT NOT NULL DEFAULT '#1f5fd1' CHECK (booking_accent ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN online_payment_mode TEXT NOT NULL DEFAULT 'optional' CHECK (online_payment_mode IN ('optional', 'required')),
  ADD COLUMN payment_hold_minutes INT NOT NULL DEFAULT 30 CHECK (payment_hold_minutes BETWEEN 10 AND 1440),
  -- Pesapal: the IPN (payment notification) id registered for this hotel's address
  ADD COLUMN pesapal_ipn_id TEXT,
  ADD COLUMN pesapal_ipn_url TEXT;

-- a website booking that must be paid online is released if not paid by this time
ALTER TABLE reservations
  ADD COLUMN pay_by TIMESTAMPTZ,
  ADD COLUMN booked_from TEXT;
CREATE INDEX reservations_pay_by ON reservations(pay_by) WHERE pay_by IS NOT NULL;

ALTER TABLE payment_intents
  ADD COLUMN checked_at TIMESTAMPTZ,
  ADD COLUMN currency TEXT,
  ADD COLUMN note TEXT;

-- the part of an OTA-collected booking the OTA keeps: settles the guest bill against commission payable (2300)
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('cash','card','mobile_money','bank_transfer','company_account','ota_commission'));

-- Card facts from OTA bookings. NEVER the card number or security code: only what staff need to find and charge
-- the card in the secure card store (last 4 digits, type, dates, amount) and the store's token.
CREATE TABLE ota_cards (
  reservation_id  INT PRIMARY KEY REFERENCES reservations(id) ON DELETE CASCADE,
  channel_id      INT REFERENCES channels(id),
  ota             TEXT,
  ota_ref         TEXT,
  collect         TEXT NOT NULL DEFAULT 'unknown' CHECK (collect IN ('ota', 'property', 'unknown')),
  is_virtual      BOOLEAN NOT NULL DEFAULT false,
  card_type       TEXT,
  last4           TEXT CHECK (last4 ~ '^[0-9]{4}$'),
  expiry          TEXT,
  holder          TEXT,
  charge_from     DATE,
  charge_until    DATE,
  amount          NUMERIC(14,2),
  currency        TEXT,
  token           TEXT,
  status          TEXT NOT NULL DEFAULT 'to_charge' CHECK (status IN ('to_charge', 'charged', 'failed', 'not_needed')),
  charged_amount  BIGINT,
  payment_id      BIGINT REFERENCES payments(id),
  note            TEXT,
  updated_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ota_cards_status ON ota_cards(status);
