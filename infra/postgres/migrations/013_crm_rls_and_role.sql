-- RLS for the new CRM tables (same pattern as every prior module).
DO $$
DECLARE
    tbl text;
    new_tables text[] := ARRAY['customers', 'opportunities', 'activities'];
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

-- Least-privilege role for crm-service, same rationale as every prior
-- module's *_svc role — see 007_app_role.sql for the full explanation of
-- why the bootstrap `metrock` superuser must never be what a
-- request-serving domain service connects as.
CREATE ROLE crm_svc WITH LOGIN PASSWORD 'crm_svc_dev_password';

GRANT CONNECT ON DATABASE metrock_erp TO crm_svc;
GRANT USAGE ON SCHEMA public TO crm_svc;
GRANT SELECT ON plants TO crm_svc;
GRANT SELECT, INSERT, UPDATE ON customers, opportunities, activities TO crm_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_svc;

-- sales-service now needs to read `customers` too (to validate an optional
-- customerId on order creation, same pattern as its existing agentId
-- validation) — granted here rather than in 011_sales_rls_and_role.sql
-- since `customers` didn't exist yet at that point.
GRANT SELECT ON customers TO sales_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U crm_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM customers;"
--   -> must be 0
