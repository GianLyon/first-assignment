-- two-step sign-in for the team, and alerts when a client hotel's system goes down
ALTER TABLE users
  ADD COLUMN totp_secret     TEXT,
  ADD COLUMN totp_pending    TEXT,
  ADD COLUMN totp_enabled_at TIMESTAMPTZ,
  ADD COLUMN totp_last_step  BIGINT,
  ADD COLUMN recovery_codes  TEXT[] NOT NULL DEFAULT '{}';
CREATE TABLE mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts   INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE console_settings (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mfa_required_roles TEXT[] NOT NULL DEFAULT '{}'
);
INSERT INTO console_settings (id) VALUES (1);
