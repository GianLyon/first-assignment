-- Phase 19: beta. What staff report from inside the app, and errors seen by the app or the server.
CREATE TABLE feedback (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('problem', 'idea', 'question')),
  message     TEXT NOT NULL CHECK (length(message) BETWEEN 3 AND 4000),
  page        TEXT,
  version     TEXT,
  user_agent  TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'done')),
  reply       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feedback_status ON feedback(status, id DESC);

-- the same error is kept once and counted, so a loop cannot fill the database
CREATE TABLE app_errors (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('client', 'server')),
  fingerprint  TEXT NOT NULL UNIQUE,
  message      TEXT NOT NULL,
  source       TEXT,
  stack        TEXT,
  page         TEXT,
  version      TEXT,
  user_id      INT REFERENCES users(id) ON DELETE SET NULL,
  user_agent   TEXT,
  count        INT NOT NULL DEFAULT 1,
  first_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_errors_last ON app_errors(last_at DESC);

-- feedback can be forwarded to Azeli support by email
ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check CHECK (kind IN ('report', 'campaign', 'pre_arrival', 'post_stay', 'test', 'support'));
