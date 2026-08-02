-- HR & Revenue-Based Payroll module (docs/SDD.md §3.F) — the fifth of the
-- original 15 PRD/FRS modules to get a real vertical slice (after
-- Procurement, Manufacturing, Sales, Logistics/Fleet).
--
-- Scope decisions, stated up front rather than discovered later:
--   - `leave_requests` (named in the SDD's data-model list) is NOT built
--     in this slice — the SDD itself says attendance clock-in/out is "the
--     ONLY meaningfully offline-relevant surface in this module", and
--     leave requests feed neither the offline-sync pattern nor the
--     revenue-based payroll calculation this slice exists to prove.
--   - `salary_structures` (also named) is implemented as `salary_grades`
--     below — a per-grade `grade_weight` is all the documented formula
--     actually needs (Employee Salary = Payroll Pool x Grade Weight); a
--     separate fixed-base-salary table would contradict "revenue-based"
--     payroll, which computes salary FROM the pool, not from a stored
--     structure.
--   - `payroll_ratio` is tenant-configurable PER PLANT (added directly to
--     `plants`, not a new one-row-per-plant config table) since Plant
--     Revenue and the resulting pool are both plant-scoped per the SDD
--     formula.

ALTER TABLE plants ADD COLUMN payroll_ratio numeric(5,4) NOT NULL DEFAULT 0;

CREATE TABLE salary_grades (
    tenant_id    uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    grade_code   text NOT NULL,
    grade_name   text NOT NULL,
    grade_weight numeric(6,4) NOT NULL,
    PRIMARY KEY (tenant_id, grade_code)
);

CREATE TABLE employees (
    tenant_id         uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    employee_id       uuid NOT NULL DEFAULT gen_random_uuid(),
    employee_code     text NOT NULL,
    full_name         text NOT NULL,
    plant_id          uuid NOT NULL,
    department        text, -- free text, same as users.department (003_governance.sql) — no departments table exists yet
    grade_code        text NOT NULL,
    employment_status text NOT NULL DEFAULT 'ACTIVE'
                          CHECK (employment_status IN ('ACTIVE', 'INACTIVE', 'TERMINATED')),
    hire_date         date NOT NULL DEFAULT current_date,
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, employee_id),
    UNIQUE (tenant_id, employee_code),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id),
    FOREIGN KEY (tenant_id, grade_code) REFERENCES salary_grades(tenant_id, grade_code)
);

-- The one offline-capturable surface in this module (SDD §3.F). Dedupe
-- has TWO independent layers: the standard client_event_id idempotency
-- (an exact retry of the same request) AND Matrix Scenario #8's
-- (employee_id, event_type, time_bucket) dedupe (a genuinely different
-- event — different client_event_id, different device — representing the
-- same real-world clock-in, e.g. a phone and a plant kiosk both firing
-- for one employee). `time_bucket` buckets to the hour as a stand-in for
-- "same shift window" — a real system would derive this from configured
-- shift start times, not a fixed calendar-hour truncation; not required
-- to prove the dedupe pattern itself.
--
-- `time_bucket` is a plain column, computed and supplied by
-- hr-service at insert time (floor(event_time) to the hour, in UTC) —
-- NOT a `GENERATED ALWAYS AS (date_trunc(...)) STORED` column: Postgres
-- rejects `date_trunc(text, timestamptz)` in a generated column because
-- it depends on the session's TimeZone setting and so isn't IMMUTABLE.
-- Computing it in application code sidesteps that entirely and is no
-- less correct, since hr-service is the only writer of this table.
CREATE TABLE attendance_logs (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    attendance_log_id uuid NOT NULL DEFAULT gen_random_uuid(),
    employee_id     uuid NOT NULL,
    event_type      text NOT NULL CHECK (event_type IN ('CLOCK_IN', 'CLOCK_OUT')),
    event_time      timestamptz NOT NULL DEFAULT now(),
    time_bucket     timestamptz NOT NULL,
    client_event_id uuid NOT NULL,
    device_id       uuid,
    created_offline boolean NOT NULL DEFAULT false,
    sync_seq        bigserial,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, attendance_log_id),
    UNIQUE (tenant_id, client_event_id),
    UNIQUE (tenant_id, employee_id, event_type, time_bucket), -- Matrix Scenario #8
    FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id)
);

-- One run per plant per period. Deliberately single-shot: "calculate"
-- (this row + payroll_records, below) and "post to books" are two
-- separate online-only actions (see hr-service's PayrollService doc
-- comment), but there's no earlier DRAFT phase before calculation itself
-- — same "single-shot capture, not a stateful multi-step workflow"
-- simplification as every other module's aggregate root in this platform.
-- The calculation/posting split IS real, though, matching the SDD's
-- explicit requirement that payroll posting is "online-only, finance-
-- gated" — never executed offline, never queued.
CREATE TABLE payroll_runs (
    tenant_id          uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    payroll_run_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    plant_id           uuid NOT NULL,
    payroll_period     text NOT NULL, -- 'YYYY-MM'
    payroll_status     text NOT NULL DEFAULT 'CALCULATED'
                           CHECK (payroll_status IN ('CALCULATED', 'POSTED')),
    posted_to_books_flag boolean NOT NULL DEFAULT false,
    plant_revenue      numeric(14,2) NOT NULL,
    payroll_ratio_used numeric(5,4) NOT NULL, -- snapshot of plants.payroll_ratio at calc time
    total_payroll_pool numeric(14,2) NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, payroll_run_id),
    UNIQUE (tenant_id, plant_id, payroll_period),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE payroll_records (
    tenant_id         uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    payroll_record_id uuid NOT NULL DEFAULT gen_random_uuid(),
    payroll_run_id    uuid NOT NULL,
    employee_id       uuid NOT NULL,
    grade_weight_used numeric(6,4) NOT NULL, -- snapshot of salary_grades.grade_weight at calc time
    gross_salary      numeric(14,2) NOT NULL,
    total_deductions  numeric(14,2) NOT NULL DEFAULT 0, -- no statutory deduction engine (tax/pension) in this slice
    net_salary        numeric(14,2) NOT NULL,
    PRIMARY KEY (tenant_id, payroll_record_id),
    UNIQUE (tenant_id, payroll_run_id, employee_id),
    FOREIGN KEY (tenant_id, payroll_run_id) REFERENCES payroll_runs(tenant_id, payroll_run_id),
    FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id)
);

CREATE INDEX idx_attendance_logs_sync ON attendance_logs (tenant_id, sync_seq);
CREATE INDEX idx_payroll_records_run ON payroll_records (tenant_id, payroll_run_id);

-- New GL accounts this module introduces.
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type)
SELECT tenant_id, '5340', 'Salary/Wages Expense', 'EXPENSE' FROM tenant_registry
UNION ALL
SELECT tenant_id, '2130', 'Payroll Payable', 'LIABILITY' FROM tenant_registry;

-- Posting rule (SDD §3.F "Financial Trigger" table):
--   payroll.run_posted.v1 -> Dr Salary/Wages Expense (5340) / Cr Payroll Payable (2130)
-- Amount = Σ payroll_records.net_salary for the run, published as
-- `net_salary_total` in the event payload (this posting engine's
-- amount_expression is just a top-level payload field name, same
-- convention as every other module since Slice #1).
INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
SELECT tenant_id, 'payroll.run_posted.v1', '5340', '2130', 'net_salary_total' FROM tenant_registry;
