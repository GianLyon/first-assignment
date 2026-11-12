-- Phase 10: guest registration details, room moves, letterhead for printing, sample data

/* registration card: who the guest is */
ALTER TABLE guests
  ADD COLUMN gender         TEXT CHECK (gender IN ('female','male','other')),
  ADD COLUMN address        TEXT,
  ADD COLUMN id_issued_by   TEXT,          -- issuing country / authority
  ADD COLUMN id_expiry      DATE;

/* registration card: this stay */
ALTER TABLE reservations
  ADD COLUMN purpose        TEXT CHECK (purpose IN ('business','leisure','conference','transit','other')),
  ADD COLUMN coming_from    TEXT,
  ADD COLUMN going_to       TEXT,
  ADD COLUMN vehicle_reg    TEXT;

/* moving an in-house guest to another room */
CREATE TABLE room_moves (
  id             SERIAL PRIMARY KEY,
  reservation_id INT NOT NULL REFERENCES reservations(id),
  from_room_id   INT NOT NULL REFERENCES rooms(id),
  to_room_id     INT NOT NULL REFERENCES rooms(id),
  reason         TEXT NOT NULL,
  old_rate       BIGINT NOT NULL,
  new_rate       BIGINT NOT NULL,
  business_date  DATE NOT NULL,
  moved_by       INT REFERENCES users(id),
  moved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX room_moves_res_idx ON room_moves(reservation_id);

/* letterhead on printed invoices and reports */
ALTER TABLE settings
  ADD COLUMN legal_name     TEXT,
  ADD COLUMN address        TEXT,          -- may span lines
  ADD COLUMN website        TEXT,
  ADD COLUMN tin            TEXT,
  ADD COLUMN logo           TEXT CHECK (logo IS NULL OR (logo ~ '^data:image/(png|jpeg|webp);base64,' AND length(logo) <= 400000)),
  ADD COLUMN invoice_footer TEXT,          -- e.g. bank details, thank-you note
  ADD COLUMN demo_data      BOOLEAN NOT NULL DEFAULT FALSE;
