-- RLS for the new Fleet tables (same pattern as every prior module).
DO $$
DECLARE
    tbl text;
    new_tables text[] := ARRAY[
        'vehicle_class_fuel_norms', 'drivers', 'vehicles',
        'trip_logs', 'fuel_records', 'maintenance_requests'
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

-- Least-privilege role for fleet-service, same rationale as every prior
-- module's *_svc role — see 007_app_role.sql for the full explanation of
-- why the bootstrap `metrock` superuser must never be what a
-- request-serving domain service connects as.
CREATE ROLE fleet_svc WITH LOGIN PASSWORD 'fleet_svc_dev_password';

GRANT CONNECT ON DATABASE metrock_erp TO fleet_svc;
GRANT USAGE ON SCHEMA public TO fleet_svc;
GRANT SELECT ON plants TO fleet_svc;
GRANT SELECT, INSERT, UPDATE ON
    vehicle_class_fuel_norms, drivers, vehicles, trip_logs, fuel_records, maintenance_requests
    TO fleet_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fleet_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U fleet_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM vehicles;"
--   -> must be 0
