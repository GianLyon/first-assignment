-- Phase 11: two-step sign-in (authenticator app codes) and backups

ALTER TABLE users
  ADD COLUMN totp_secret     TEXT,                 -- base32, set once confirmed
  ADD COLUMN totp_pending    TEXT,                 -- while setting up, before the first code is confirmed
  ADD COLUMN totp_enabled_at TIMESTAMPTZ,
  ADD COLUMN totp_last_step  BIGINT,               -- the last 30-second step used: a code works only once
  ADD COLUMN recovery_codes  TEXT[] NOT NULL DEFAULT '{}';  -- sha256 of each unused one-time code

-- roles that must use two-step sign-in (set by an administrator)
ALTER TABLE settings ADD COLUMN mfa_required_roles TEXT[] NOT NULL DEFAULT '{}';

-- after a correct password, the code is asked for within 5 minutes
CREATE TABLE mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts   INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE backup_runs (
  id          SERIAL PRIMARY KEY,
  trigger     TEXT NOT NULL CHECK (trigger IN ('scheduled','manual','download')),
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  object_key  TEXT,
  size_bytes  BIGINT,
  tables      INT,
  rows        BIGINT,
  error       TEXT,
  started_by  INT REFERENCES users(id),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
