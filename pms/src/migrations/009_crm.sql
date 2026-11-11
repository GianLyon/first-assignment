-- Phase 9: guest CRM & marketing

ALTER TABLE guests
  ADD COLUMN birth_date        DATE,
  ADD COLUMN vip               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN tags              TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN preferences       TEXT,
  ADD COLUMN marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN consent_at        TIMESTAMPTZ,
  ADD COLUMN consent_source    TEXT,
  ADD COLUMN unsubscribed_at   TIMESTAMPTZ,
  ADD COLUMN unsubscribe_token TEXT UNIQUE DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  ADD COLUMN merged_into       INT REFERENCES guests(id),
  ADD COLUMN erased_at         TIMESTAMPTZ;
UPDATE guests SET unsubscribe_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE unsubscribe_token IS NULL;

ALTER TABLE settings ADD COLUMN public_url TEXT,   -- web address guests use (unsubscribe links)
                     ADD COLUMN review_url TEXT;   -- e.g. Google or TripAdvisor review page

/* Automatic guest emails */
CREATE TABLE guest_email_templates (
  key      TEXT PRIMARY KEY CHECK (key IN ('pre_arrival','post_stay')),
  enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  days     INT NOT NULL CHECK (days BETWEEN 0 AND 30),
  subject  TEXT NOT NULL,
  body     TEXT NOT NULL
);
INSERT INTO guest_email_templates (key, enabled, days, subject, body) VALUES
('pre_arrival', FALSE, 2, 'See you soon at {property}',
'Dear {first_name},

We look forward to welcoming you on {arrival} (booking {code}).

Check-in is from {check_in_time}. If you would like an airport transfer, a spa treatment or a table at our restaurant, simply reply to this email and we will arrange it.

Warm regards,
{property}'),
('post_stay', FALSE, 1, 'Thank you for staying with us, {first_name}',
'Dear {first_name},

Thank you for choosing {property}. We hope you enjoyed your stay.

Would you take a minute to share your experience? It helps other travellers and means a great deal to our team:
{review_link}

We hope to welcome you back soon.
{property}');

/* Marketing campaigns */
CREATE TABLE campaigns (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  segment     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  recipients  INT,
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by     INT REFERENCES users(id),
  sent_at     TIMESTAMPTZ
);

/* the email outbox now carries guest emails too */
ALTER TABLE email_outbox
  ADD COLUMN kind           TEXT NOT NULL DEFAULT 'report' CHECK (kind IN ('report','campaign','pre_arrival','post_stay','test')),
  ADD COLUMN guest_id       INT REFERENCES guests(id),
  ADD COLUMN campaign_id    INT REFERENCES campaigns(id),
  ADD COLUMN reservation_id INT REFERENCES reservations(id);
-- one automatic email of each kind per stay; one campaign email per guest
CREATE UNIQUE INDEX email_outbox_stay_once ON email_outbox(kind, reservation_id) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX email_outbox_campaign_once ON email_outbox(campaign_id, guest_id) WHERE campaign_id IS NOT NULL;
