-- Phase 14: fuller bookings, payments, companies and suppliers

ALTER TABLE guests ADD COLUMN title TEXT;   -- Mr, Mrs, Ms, Dr, Prof, Rev, Hon …

ALTER TABLE reservations
  ADD COLUMN eta              TIME,                          -- expected arrival time
  ADD COLUMN market_segment   TEXT CHECK (market_segment IN ('leisure','corporate','government','ngo','group','wholesale','long_stay','complimentary','other')),
  ADD COLUMN guarantee        TEXT NOT NULL DEFAULT 'none' CHECK (guarantee IN ('none','deposit','card','company','prepaid','voucher')),
  ADD COLUMN special_requests TEXT,                          -- what the guest asked for (shown on arrival lists)
  ADD COLUMN booker_reference TEXT,                          -- OTA number, agent voucher or company order number
  ADD COLUMN travel_agent     TEXT,
  ADD COLUMN group_code       TEXT;                          -- the rooms of one booking share it (the first room's code)
CREATE INDEX reservations_group_idx ON reservations(group_code) WHERE group_code IS NOT NULL;

/* how each payment was made: card brand / last 4 / approval code, mobile money network / number / transaction id,
   bank and date, cash tendered and change */
ALTER TABLE payments
  ADD COLUMN payer_name TEXT,
  ADD COLUMN details    JSONB NOT NULL DEFAULT '{}';

ALTER TABLE companies
  ADD COLUMN industry      TEXT,
  ADD COLUMN contact_role  TEXT,
  ADD COLUMN phone2        TEXT,
  ADD COLUMN billing_email TEXT,                             -- where invoices go, if not the contact
  ADD COLUMN website       TEXT,
  ADD COLUMN discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct < 100),  -- negotiated room rate discount
  ADD COLUMN notes         TEXT;

ALTER TABLE suppliers
  ADD COLUMN category          TEXT,
  ADD COLUMN contact_role      TEXT,
  ADD COLUMN phone2            TEXT,
  ADD COLUMN address           TEXT,
  ADD COLUMN terms_days        INT NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 180),
  ADD COLUMN bank_name         TEXT,
  ADD COLUMN bank_branch       TEXT,
  ADD COLUMN bank_account_name TEXT,
  ADD COLUMN bank_account_no   TEXT,
  ADD COLUMN momo_network      TEXT CHECK (momo_network IN ('MTN','Airtel')),
  ADD COLUMN momo_number       TEXT,
  ADD COLUMN notes             TEXT;
