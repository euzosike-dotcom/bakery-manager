-- RLS for the new HR/Payroll tables (same pattern as every prior module).
DO $$
DECLARE
    tbl text;
    new_tables text[] := ARRAY[
        'salary_grades', 'employees', 'attendance_logs', 'payroll_runs', 'payroll_records'
    ];
BEGIN
    FOREACH tbl IN ARRAY new_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                USING (tenant_id = current_tenant_id())
                WITH CHECK (tenant_id = current_tenant_id())',
            tbl
        );
    END LOOP;
END $$;

-- Least-privilege role for hr-service, same rationale as every prior
-- module's *_svc role — see 007_app_role.sql for the full explanation of
-- why the bootstrap `metrock` superuser must never be what a
-- request-serving domain service connects as.
-- Password from :'hr_svc_password' — see 007_app_role.sql's comment
-- for why, and docs/RUNBOOK.md's "Secrets in production".
\if :{?hr_svc_password}
\else
  \set hr_svc_password 'hr_svc_dev_password'
\endif
CREATE ROLE hr_svc WITH LOGIN PASSWORD :'hr_svc_password';

GRANT CONNECT ON DATABASE metrock_erp TO hr_svc;
GRANT USAGE ON SCHEMA public TO hr_svc;
GRANT SELECT ON plants TO hr_svc;
GRANT SELECT, INSERT, UPDATE ON
    salary_grades, employees, attendance_logs, payroll_runs, payroll_records
    TO hr_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_svc;

-- Read-only cross-module reuse — Plant Revenue (SDD §3.F formula) is
-- computed off sales-service's confirmed sales_orders, not re-derived
-- from journal_entries: the sales.order_fulfilled.v1 event never carried
-- plant_id through to journal_lines.cost_center_plant_id (that column is
-- NULL for every sales revenue posting so far), so filtering the GL by
-- plant isn't reliable yet. sales_orders.plant_id is, so hr-service reads
-- that table directly instead — same pattern as accounting_svc reading
-- purchase_orders, sales_svc reading customers.
GRANT SELECT ON sales_orders TO hr_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U hr_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM employees;"
--   -> must be 0
