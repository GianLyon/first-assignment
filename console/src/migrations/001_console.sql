-- Azeli Console: team, website enquiries, website content, client hotels

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','editor','sales')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* enquiries from the website's contact / free-audit form */
CREATE SEQUENCE lead_no_seq START 1001;
CREATE TABLE leads (
  id          SERIAL PRIMARY KEY,
  ref         TEXT NOT NULL UNIQUE DEFAULT ('L' || nextval('lead_no_seq')),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  business    TEXT NOT NULL,
  business_type TEXT,
  services    TEXT[] NOT NULL DEFAULT '{}',
  message     TEXT,
  package     TEXT,
  page        TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','proposal','won','lost')),
  assigned_to INT REFERENCES users(id),
  value_ugx   BIGINT CHECK (value_ugx >= 0),           -- expected monthly fee
  next_action_date DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_status_idx ON leads(status, created_at DESC);
CREATE TABLE lead_notes (
  id         SERIAL PRIMARY KEY,
  lead_id    INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INT REFERENCES users(id),
  note       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* editable website content: a draft that becomes live when published */
CREATE TABLE site_content (
  section      TEXT PRIMARY KEY,
  draft        JSONB NOT NULL,
  published    JSONB,
  updated_by   INT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE TABLE publishes (
  id         SERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  sections   TEXT[] NOT NULL,
  deploy     TEXT NOT NULL,          -- 'triggered', 'no_hook', or the error
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* hotels running Azeli PMS */
CREATE TABLE clients (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  pms_url        TEXT NOT NULL,
  group_token    TEXT,                -- the hotel's group access key (reads totals only)
  contact_name   TEXT,
  contact_email  TEXT,
  contact_phone  TEXT,
  package        TEXT CHECK (package IN ('Essentials','Growth','Signature','PMS only','Other')),
  monthly_fee_ugx BIGINT CHECK (monthly_fee_ugx >= 0),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('setup','active','paused','ended')),
  started_on     DATE,
  notes          TEXT,
  lead_id        INT REFERENCES leads(id),
  last_check_at  TIMESTAMPTZ,
  last_status    TEXT,                 -- 'online', or why not
  last_summary   JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
