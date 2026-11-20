-- Phase 17: buying signals in WhatsApp conversations (worked out from the guest's own messages)
CREATE TABLE wa_intents (
  conversation_id INT PRIMARY KEY REFERENCES wa_conversations(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL CHECK (stage IN ('explorer','interested','buyer','ready')),
  score       INT NOT NULL CHECK (score BETWEEN 0 AND 100),     -- how likely to book
  confidence  INT NOT NULL CHECK (confidence BETWEEN 0 AND 100),-- how sure the reading is (more messages, clearer signals)
  depth       INT NOT NULL CHECK (depth BETWEEN 0 AND 100),     -- how specific: dates, party, room, price, payment, logistics
  signals     JSONB NOT NULL DEFAULT '[]',                       -- [{key, label, weight, quote}]
  first_purchase_signal_at TIMESTAMPTZ,                          -- the first message that showed intent to book
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wa_intents_stage ON wa_intents(stage, score DESC);
