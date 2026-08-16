-- RLS for the new Sales & Agent Capital tables (same pattern as 006/009).
DO $$
DECLARE
    tbl text;
    new_tables text[] := ARRAY[
        'agent_master', 'trading_capital_ledger', 'sales_orders', 'order_lines', 'ncr_collections'
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

-- Least-privilege role for sales-service, same rationale as
-- procurement_svc (007) / manufacturing_svc (009): the bootstrap `metrock`
-- role is a superuser and must never be what a request-serving domain
-- service connects as.
-- Password from :'sales_svc_password' — see 007_app_role.sql's comment
-- for why, and docs/RUNBOOK.md's "Secrets in production".
\if :{?sales_svc_password}
\else
  \set sales_svc_password 'sales_svc_dev_password'
\endif
CREATE ROLE sales_svc WITH LOGIN PASSWORD :'sales_svc_password';

GRANT CONNECT ON DATABASE metrock_erp TO sales_svc;
GRANT USAGE ON SCHEMA public TO sales_svc;

-- sales-service needs to read plants (FK validation) and product_skus
-- (order line SKU picker) from other modules' schemas, in addition to its
-- own tables.
GRANT SELECT ON plants, product_skus TO sales_svc;
GRANT SELECT, INSERT, UPDATE ON agent_master, sales_orders, order_lines, ncr_collections TO sales_svc;
-- trading_capital_ledger is append-only from the application's perspective
-- too (no UPDATE grant) — the DB rules (no_update/no_delete) are the hard
-- backstop, this GRANT is the first layer expressing the same intent.
GRANT SELECT, INSERT ON trading_capital_ledger TO sales_svc;

-- Same bigserial-sequence gotcha as 007/009 — sales_orders.sync_seq and
-- ncr_collections.sync_seq both need it.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sales_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U sales_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM agent_master;"
--   -> must be 0
