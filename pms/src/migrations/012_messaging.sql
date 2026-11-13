-- Phase 12: phone book and WhatsApp messaging (front-desk inbox, message templates, automations)

/* WhatsApp permission per guest. Business-started messages (templates, automations) need it; the guest's
   own message lets staff reply freely for 24 hours whatever this says. */
ALTER TABLE guests
  ADD COLUMN whatsapp_opt_in    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN whatsapp_opt_in_at TIMESTAMPTZ,
  ADD COLUMN whatsapp_opt_out_at TIMESTAMPTZ;

ALTER TABLE settings
  ADD COLUMN phone_country_code TEXT NOT NULL DEFAULT '256' CHECK (phone_country_code ~ '^[1-9][0-9]{0,3}$'),
  ADD COLUMN wa_quiet_from      INT NOT NULL DEFAULT 21 CHECK (wa_quiet_from BETWEEN 0 AND 23),  -- automations wait from this hour…
  ADD COLUMN wa_quiet_to        INT NOT NULL DEFAULT 8  CHECK (wa_quiet_to BETWEEN 0 AND 23);    -- …until this hour (hotel time)

/* Phone book: people who are not guests (suppliers, drivers, tour guides, partners, staff on call) */
CREATE TABLE contacts (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  company    TEXT,
  category   TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('supplier','transport','partner','staff','emergency','other')),
  phone      TEXT,
  phone2     TEXT,
  email      TEXT,
  notes      TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* One conversation per WhatsApp number */
CREATE TABLE wa_conversations (
  id              SERIAL PRIMARY KEY,
  wa_id           TEXT NOT NULL UNIQUE CHECK (wa_id ~ '^[1-9][0-9]{6,14}$'),  -- international number, digits only
  profile_name    TEXT,                                     -- the name the guest uses on WhatsApp
  guest_id        INT REFERENCES guests(id),
  contact_id      INT REFERENCES contacts(id),
  last_inbound_at TIMESTAMPTZ,                              -- opens the 24-hour reply window
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unread          INT NOT NULL DEFAULT 0,
  assigned_to     INT REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  opted_out_at    TIMESTAMPTZ,                              -- the guest sent STOP
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wa_conversations_recent ON wa_conversations(last_message_at DESC);
CREATE INDEX wa_conversations_guest ON wa_conversations(guest_id);

/* Approved message templates (the same name, language and wording as approved in WhatsApp Manager) */
CREATE TABLE wa_templates (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL CHECK (name ~ '^[a-z0-9_]{1,250}$'),
  language   TEXT NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  category   TEXT NOT NULL DEFAULT 'utility' CHECK (category IN ('utility','marketing')),
  body       TEXT NOT NULL,                     -- with {{1}}, {{2}} … as in WhatsApp Manager
  params     TEXT[] NOT NULL DEFAULT '{}',      -- what fills {{1}}, {{2}} …: first_name, arrival, room …
  approved   BOOLEAN NOT NULL DEFAULT FALSE,    -- ticked once WhatsApp Manager shows it as Active
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, language)
);

CREATE TABLE wa_messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','template','media','other')),
  body            TEXT,
  template_id     INT REFERENCES wa_templates(id),
  params          TEXT[],
  wa_message_id   TEXT UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  error           TEXT,
  sent_by         INT REFERENCES users(id),
  automation_id   INT,
  reservation_id  INT REFERENCES reservations(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_at       TIMESTAMPTZ
);
CREATE INDEX wa_messages_conv ON wa_messages(conversation_id, id);
CREATE INDEX wa_messages_queued ON wa_messages(id) WHERE status = 'queued';

/* Automations: a template sent to every opted-in guest at a moment of their stay */
CREATE TABLE wa_automations (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  trigger     TEXT NOT NULL CHECK (trigger IN ('booking_confirmed','pre_arrival','arrival_day','mid_stay','pre_departure','post_stay','birthday')),
  days        INT NOT NULL DEFAULT 0 CHECK (days BETWEEN 0 AND 60),
  template_id INT NOT NULL REFERENCES wa_templates(id),
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at  TIMESTAMPTZ,      -- bookings made before this are not written to (no backlog when switched on)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE wa_messages ADD CONSTRAINT wa_messages_automation_fk FOREIGN KEY (automation_id) REFERENCES wa_automations(id) ON DELETE SET NULL;
-- each automation reaches each stay once (birthday: once per guest per year, keyed by key)
CREATE TABLE wa_automation_runs (
  automation_id INT NOT NULL REFERENCES wa_automations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,            -- 'r:<reservation id>' or 'g:<guest id>:<year>'
  message_id    INT REFERENCES wa_messages(id) ON DELETE SET NULL,
  skipped       TEXT,                     -- why nothing was sent (no number, no permission …)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, key)
);

/* Starter templates: submit the same wording in WhatsApp Manager, then tick "approved" */
INSERT INTO wa_templates (name, language, category, body, params) VALUES
('booking_confirmed', 'en', 'utility', 'Hello {{1}}, your booking {{2}} at {{3}} is confirmed for {{4}} to {{5}}. Reply here if you need anything before you arrive.', '{first_name,code,property,arrival,departure}'),
('pre_arrival', 'en', 'utility', 'Hello {{1}}, we look forward to welcoming you to {{2}} on {{3}}. Check-in is from {{4}}. Would you like an airport transfer or a table booked? Just reply to this message.', '{first_name,property,arrival,check_in_time}'),
('welcome_in_house', 'en', 'utility', 'Welcome to {{1}}, {{2}}! You are in room {{3}}. This is the front desk on WhatsApp: message us any time for housekeeping, room service or help.', '{property,first_name,room}'),
('mid_stay_check', 'en', 'utility', 'Hello {{1}}, how is your stay in room {{2}} so far? If anything can be better, reply here and we will sort it out.', '{first_name,room}'),
('departure_reminder', 'en', 'utility', 'Hello {{1}}, a reminder that check-out is at {{2}} on {{3}}. Would you like a late check-out or help with transport? Reply here.', '{first_name,check_out_time,departure}'),
('thank_you_review', 'en', 'marketing', 'Thank you for staying with us at {{1}}, {{2}}. We would love to hear how it went: {{3}}', '{property,first_name,review_link}'),
('birthday_greeting', 'en', 'marketing', 'Happy birthday, {{1}}! Everyone at {{2}} wishes you a wonderful day.', '{first_name,property}');

INSERT INTO wa_automations (name, trigger, days, template_id) VALUES
('Booking confirmation', 'booking_confirmed', 0, (SELECT id FROM wa_templates WHERE name='booking_confirmed')),
('Before arrival', 'pre_arrival', 2, (SELECT id FROM wa_templates WHERE name='pre_arrival')),
('Welcome on arrival', 'arrival_day', 0, (SELECT id FROM wa_templates WHERE name='welcome_in_house')),
('Mid-stay check', 'mid_stay', 1, (SELECT id FROM wa_templates WHERE name='mid_stay_check')),
('Check-out reminder', 'pre_departure', 0, (SELECT id FROM wa_templates WHERE name='departure_reminder')),
('Thank you and review', 'post_stay', 1, (SELECT id FROM wa_templates WHERE name='thank_you_review')),
('Birthday greeting', 'birthday', 0, (SELECT id FROM wa_templates WHERE name='birthday_greeting'));
