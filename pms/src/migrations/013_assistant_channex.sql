-- Phase 13: front-desk assistant, Channex channel manager connection (Booking.com, Expedia, Agoda …)

/* What the AI assistant was used for, to keep its cost visible and limited */
CREATE TABLE ai_usage (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INT REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('chat','whatsapp_draft')),
  model         TEXT NOT NULL,
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cached_tokens INT NOT NULL DEFAULT 0,
  ok            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_time ON ai_usage(user_id, created_at DESC);

/* Channex: a channel manager with an open API that is certified with Booking.com, Expedia, Agoda, Airbnb and others */
ALTER TABLE channels DROP CONSTRAINT channels_adapter_check;
ALTER TABLE channels ADD CONSTRAINT channels_adapter_check CHECK (adapter IN ('simulator','webhook','channex'));
ALTER TABLE channels
  ADD COLUMN external_property_id TEXT,      -- the hotel's property id in the channel manager
  ADD COLUMN last_pull_at         TIMESTAMPTZ;
