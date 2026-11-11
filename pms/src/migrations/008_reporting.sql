-- Phase 8: scheduled department reports by email, multi-property (group) dashboard

ALTER TABLE settings ADD COLUMN group_token_hash TEXT,          -- lets a group office read this property's summary
                     ADD COLUMN group_token_hint TEXT;          -- last 4 characters, to recognise it

/* Who receives which report, how often */
CREATE TABLE report_subscriptions (
  id          SERIAL PRIMARY KEY,
  report      TEXT NOT NULL CHECK (report IN ('manager','front_office','fnb','stores','finance','hr','events','maintenance')),
  frequency   TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  recipients  TEXT[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 20),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report, frequency)
);

/* One generated report for a period (kept so it can be viewed again) */
CREATE TABLE report_runs (
  id           SERIAL PRIMARY KEY,
  report       TEXT NOT NULL,
  frequency    TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','manual')),
  period_from  DATE NOT NULL,
  period_to    DATE NOT NULL CHECK (period_to >= period_from),
  title        TEXT NOT NULL,
  data         JSONB NOT NULL,
  created_by   INT REFERENCES users(id),              -- NULL when scheduled
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- scheduled reports are produced once per period
CREATE UNIQUE INDEX report_runs_scheduled ON report_runs(report, frequency, period_from) WHERE frequency <> 'manual';

CREATE TABLE email_outbox (
  id              BIGSERIAL PRIMARY KEY,
  run_id          INT REFERENCES report_runs(id),
  to_address      TEXT NOT NULL,
  subject         TEXT NOT NULL,
  html            TEXT NOT NULL,
  text_body       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','test')),
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due ON email_outbox(next_attempt_at) WHERE status = 'queued';

/* Other properties shown on this property's group dashboard */
CREATE TABLE group_properties (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  base_url        TEXT NOT NULL,
  token           TEXT NOT NULL,         -- that property's group read token
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_status     TEXT,
  last_checked_at TIMESTAMPTZ
);
