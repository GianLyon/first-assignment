-- Phase 21: checking the WhatsApp and AI connections from inside the PMS.
-- when Meta last delivered a signed webhook call (proves the webhook address and app secret are right)
ALTER TABLE settings ADD COLUMN wa_last_webhook_at TIMESTAMPTZ;
-- connection tests are logged with the other AI usage
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_kind_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_kind_check CHECK (kind IN ('chat', 'whatsapp_draft', 'test'));
