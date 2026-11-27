-- Phase 23: fuller HR. Staff records (contract, probation, next of kin, documents), public holidays, editable leave types,
-- staff loans, disciplinary cases, appraisals, Local Service Tax and service charge in payroll.

ALTER TABLE employees
  ADD COLUMN address                TEXT,
  ADD COLUMN marital_status         TEXT CHECK (marital_status IS NULL OR marital_status IN ('single','married','divorced','widowed')),
  ADD COLUMN next_of_kin_name       TEXT,
  ADD COLUMN next_of_kin_relation   TEXT,
  ADD COLUMN next_of_kin_phone      TEXT,
  ADD COLUMN emergency_name         TEXT,
  ADD COLUMN emergency_phone        TEXT,
  ADD COLUMN probation_end          DATE,
  ADD COLUMN contract_end           DATE,
  ADD COLUMN id_expiry              DATE,
  ADD COLUMN leave_carry_forward    INT NOT NULL DEFAULT 0 CHECK (leave_carry_forward BETWEEN 0 AND 60),
  ADD COLUMN service_charge_share   BOOLEAN NOT NULL DEFAULT TRUE,   -- shares in the monthly service charge
  ADD COLUMN lst_exempt             BOOLEAN NOT NULL DEFAULT FALSE;  -- e.g. already paying LST elsewhere

CREATE TABLE employee_documents (
  id           SERIAL PRIMARY KEY,
  employee_id  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('national_id','passport','cv','contract','certificate','medical','letter','other')),
  title        TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INT NOT NULL CHECK (size > 0 AND size <= 3145728),
  data         BYTEA NOT NULL,
  expires_on   DATE,
  uploaded_by  INT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX employee_documents_emp_idx ON employee_documents(employee_id);

CREATE TABLE public_holidays (
  date DATE PRIMARY KEY,
  name TEXT NOT NULL
);
-- Uganda public holidays (fixed dates; Eid and Easter move: check and add them each year)
INSERT INTO public_holidays (date, name) VALUES
  ('2026-01-01','New Year''s Day'), ('2026-01-26','NRM Liberation Day'), ('2026-02-16','Archbishop Janani Luwum Day'), ('2026-03-08','International Women''s Day'),
  ('2026-04-03','Good Friday'), ('2026-04-06','Easter Monday'), ('2026-05-01','Labour Day'), ('2026-06-03','Martyrs'' Day'), ('2026-06-09','National Heroes'' Day'),
  ('2026-10-09','Independence Day'), ('2026-12-25','Christmas Day'), ('2026-12-26','Boxing Day'),
  ('2027-01-01','New Year''s Day'), ('2027-01-26','NRM Liberation Day'), ('2027-02-16','Archbishop Janani Luwum Day'), ('2027-03-08','International Women''s Day'),
  ('2027-03-26','Good Friday'), ('2027-03-29','Easter Monday'), ('2027-05-01','Labour Day'), ('2027-06-03','Martyrs'' Day'), ('2027-06-09','National Heroes'' Day'),
  ('2027-10-09','Independence Day'), ('2027-12-25','Christmas Day'), ('2027-12-26','Boxing Day')
ON CONFLICT DO NOTHING;

ALTER TABLE leave_types
  ADD COLUMN max_days_year INT CHECK (max_days_year IS NULL OR max_days_year BETWEEN 1 AND 365),  -- cap for types without a balance (e.g. sick leave)
  ADD COLUMN active        BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE leave_types SET max_days_year = 60 WHERE code = 'maternity';
UPDATE leave_types SET max_days_year = 4 WHERE code = 'paternity';

-- loans: same recovery as advances, with a purpose and a number of instalments
ALTER TABLE staff_advances
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'advance' CHECK (kind IN ('advance','loan'));

CREATE TABLE disciplinary_cases (
  id           SERIAL PRIMARY KEY,
  employee_id  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  case_date    DATE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('verbal_warning','written_warning','final_warning','suspension','dismissal','counselling','other')),
  subject      TEXT NOT NULL,
  details      TEXT,
  action_taken TEXT,
  expires_on   DATE,                       -- when a warning stops counting
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  recorded_by  INT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX disciplinary_cases_emp_idx ON disciplinary_cases(employee_id, case_date DESC);

CREATE TABLE appraisals (
  id               SERIAL PRIMARY KEY,
  employee_id      INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period           TEXT NOT NULL,                       -- e.g. "2026 H2", "Probation review"
  review_date      DATE NOT NULL,
  reviewer_id      INT REFERENCES users(id),
  scores           JSONB NOT NULL DEFAULT '{}',         -- { quality: 1..5, guest_service: 1..5, ... }
  overall          NUMERIC(3,2),
  strengths        TEXT,
  improvements     TEXT,
  goals            TEXT,
  recommendation   TEXT CHECK (recommendation IS NULL OR recommendation IN ('confirm','extend_probation','increment','promotion','training','pip','none')),
  employee_comment TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared','acknowledged')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appraisals_emp_idx ON appraisals(employee_id, review_date DESC);

-- payroll: Local Service Tax and the shared service charge
ALTER TABLE payroll_runs ADD COLUMN service_charge_pool BIGINT NOT NULL DEFAULT 0 CHECK (service_charge_pool >= 0);
ALTER TABLE payroll_lines
  ADD COLUMN service_charge BIGINT NOT NULL DEFAULT 0 CHECK (service_charge >= 0),
  ADD COLUMN lst            BIGINT NOT NULL DEFAULT 0 CHECK (lst >= 0);
ALTER TABLE settings ADD COLUMN lst_enabled BOOLEAN NOT NULL DEFAULT TRUE;
INSERT INTO accounts (code, name, type, system) VALUES ('2440', 'Local Service Tax payable', 'liability', TRUE) ON CONFLICT (code) DO NOTHING;
