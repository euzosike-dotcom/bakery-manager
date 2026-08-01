-- RLS for the new Manufacturing tables (same pattern as migration 006_rls.sql).
DO $$
DECLARE
    tbl text;
    new_tables text[] := ARRAY[
        'product_skus', 'recipes', 'recipe_versions', 'recipe_ingredients',
        'production_batches', 'production_consumption'
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

-- Least-privilege role for manufacturing-service, mirroring
-- 007_app_role.sql's rationale for procurement_svc: the bootstrap `metrock`
-- role is a Postgres superuser and must never be what a request-serving
-- domain service connects as, or RLS is silently a no-op (see 007's
-- comment for the full explanation).
CREATE ROLE manufacturing_svc WITH LOGIN PASSWORD 'manufacturing_svc_dev_password';

GRANT CONNECT ON DATABASE metrock_erp TO manufacturing_svc;
GRANT USAGE ON SCHEMA public TO manufacturing_svc;

-- Recipes/product_skus/recipe_versions/recipe_ingredients are read-mostly
-- master data from this service's perspective in this slice (seeded, not
-- authored via API yet) but SELECT is still needed to validate a batch
-- against its recipe_version.
GRANT SELECT ON product_skus, recipes, recipe_versions, recipe_ingredients TO manufacturing_svc;
GRANT SELECT, INSERT, UPDATE ON production_batches, production_consumption TO manufacturing_svc;

-- Needed for production_batches.sync_seq / production_consumption's
-- implicit PK default — same bigserial gotcha documented in
-- 007_app_role.sql (table INSERT privilege alone does not cover the
-- sequence backing a bigserial column's default).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO manufacturing_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U manufacturing_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM production_batches;"
--   -> must be 0
