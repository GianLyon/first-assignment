-- Phase 6: HR & payroll

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','front_office','housekeeping','accountant','night_auditor','waiter','kitchen','storekeeper','hr_officer'));

INSERT INTO accounts (code, name, type, system) VALUES
  ('1250', 'Staff advances', 'asset', TRUE),
  ('2400', 'PAYE payable (URA)', 'liability', TRUE),
  ('2410', 'NSSF payable', 'liability', TRUE),
  ('2420', 'Net salaries payable', 'liability', TRUE),
  ('2430', 'Other payroll deductions payable', 'liability', TRUE),
  ('6000', 'Salaries & wages', 'expense', TRUE),
  ('6010', 'Employer NSSF contributions', 'expense', TRUE)
ON CONFLICT (code) DO NOTHING;

CREATE SEQUENCE employee_no_seq START 1001;
CREATE TABLE employees (
  id                  SERIAL PRIMARY KEY,
  emp_no              TEXT NOT NULL UNIQUE DEFAULT ('E' || nextval('employee_no_seq')),
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  gender              TEXT CHECK (gender IN ('female','male')),
  date_of_birth       DATE,
  phone               TEXT,
  email               TEXT,
  nin                 TEXT,          -- national ID number
  tin                 TEXT,          -- URA tax identification number
  nssf_no             TEXT,
  department          TEXT NOT NULL,
  job_title           TEXT NOT NULL,
  employment_type     TEXT NOT NULL DEFAULT 'permanent' CHECK (employment_type IN ('permanent','contract','casual','intern')),
  start_date          DATE NOT NULL,
  end_date            DATE,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
  leaving_reason      TEXT,
  basic_salary        BIGINT NOT NULL CHECK (basic_salary >= 0),   -- per month, UGX
  housing_allowance   BIGINT NOT NULL DEFAULT 0 CHECK (housing_allowance >= 0),
  transport_allowance BIGINT NOT NULL DEFAULT 0 CHECK (transport_allowance >= 0),
  other_allowance     BIGINT NOT NULL DEFAULT 0 CHECK (other_allowance >= 0),
  pay_method          TEXT NOT NULL DEFAULT 'bank' CHECK (pay_method IN ('bank','mobile_money','cash')),
  bank_name           TEXT,
  bank_account        TEXT,
  momo_number         TEXT,
  annual_leave_days   INT NOT NULL DEFAULT 21 CHECK (annual_leave_days BETWEEN 0 AND 60),
  user_id             INT UNIQUE REFERENCES users(id),   -- their sign-in, for self-service
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX employees_dept_idx ON employees(department);

CREATE TABLE shift_templates (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE roster (
  employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  shift_id    INT REFERENCES shift_templates(id),     -- NULL = day off
  PRIMARY KEY (employee_id, date)
);

CREATE TABLE attendance (
  id          SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  clock_in    TIMESTAMPTZ,
  clock_out   TIMESTAMPTZ,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','self')),
  note        TEXT,
  recorded_by INT REFERENCES users(id),
  UNIQUE (employee_id, date),
  CHECK (clock_out IS NULL OR clock_in IS NULL OR clock_out > clock_in)
);

CREATE TABLE leave_types (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  paid         BOOLEAN NOT NULL DEFAULT TRUE,
  uses_balance BOOLEAN NOT NULL DEFAULT FALSE,   -- deducted from the annual entitlement
  sort         INT NOT NULL DEFAULT 0
);
INSERT INTO leave_types (code, name, paid, uses_balance, sort) VALUES
  ('annual', 'Annual leave', TRUE, TRUE, 10),
  ('sick', 'Sick leave', TRUE, FALSE, 20),
  ('maternity', 'Maternity leave', TRUE, FALSE, 30),
  ('paternity', 'Paternity leave', TRUE, FALSE, 40),
  ('compassionate', 'Compassionate leave', TRUE, FALSE, 50),
  ('unpaid', 'Unpaid leave', FALSE, FALSE, 60);

CREATE TABLE leave_requests (
  id            SERIAL PRIMARY KEY,
  employee_id   INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type          TEXT NOT NULL REFERENCES leave_types(code),
  from_date     DATE NOT NULL,
  to_date       DATE NOT NULL,
  days          INT NOT NULL CHECK (days > 0),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by  INT REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  CHECK (to_date >= from_date)
);
CREATE INDEX leave_requests_emp_idx ON leave_requests(employee_id, from_date);

CREATE TABLE staff_advances (
  id               SERIAL PRIMARY KEY,
  employee_id      INT NOT NULL REFERENCES employees(id),
  advance_date     DATE NOT NULL,
  amount           BIGINT NOT NULL CHECK (amount > 0),
  monthly_recovery BIGINT NOT NULL CHECK (monthly_recovery > 0),
  recovered        BIGINT NOT NULL DEFAULT 0 CHECK (recovered >= 0),
  paid_from        TEXT NOT NULL REFERENCES accounts(code),
  reason           TEXT,
  created_by       INT REFERENCES users(id),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  CHECK (recovered <= amount)
);

CREATE TABLE payroll_runs (
  id              SERIAL PRIMARY KEY,
  period          TEXT NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),   -- YYYY-MM
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','posted','paid','void')),
  notes           TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by     INT REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  posted_by       INT REFERENCES users(id),
  posted_at       TIMESTAMPTZ,
  post_entry_id   BIGINT REFERENCES journal_entries(id),
  paid_from       TEXT REFERENCES accounts(code),
  paid_at         TIMESTAMPTZ,
  pay_entry_id    BIGINT REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX one_payroll_per_period ON payroll_runs(period) WHERE status <> 'void';

CREATE TABLE payroll_lines (
  run_id           INT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id      INT NOT NULL REFERENCES employees(id),
  department       TEXT NOT NULL,
  days_worked      INT NOT NULL,          -- days employed in the month
  days_in_month    INT NOT NULL,
  unpaid_days      INT NOT NULL DEFAULT 0,
  basic            BIGINT NOT NULL,       -- after proration and unpaid leave
  allowances       BIGINT NOT NULL,
  overtime_hours   NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0),
  overtime         BIGINT NOT NULL DEFAULT 0,
  other_additions  BIGINT NOT NULL DEFAULT 0 CHECK (other_additions >= 0),
  gross            BIGINT NOT NULL,
  nssf_employee    BIGINT NOT NULL,
  nssf_employer    BIGINT NOT NULL,
  paye             BIGINT NOT NULL,
  advance_recovery BIGINT NOT NULL DEFAULT 0,
  other_deductions BIGINT NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
  net              BIGINT NOT NULL,
  note             TEXT,
  PRIMARY KEY (run_id, employee_id)
);
