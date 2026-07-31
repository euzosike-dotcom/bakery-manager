-- Row-Level Security: the database-level backstop against an application
-- bug forgetting a tenant_id filter (SDD §1.2 "three layers of isolation").
-- `current_tenant_id()` reads the session GUC set per-request by the
-- application's tenant-context middleware via `SET LOCAL app.tenant_id`.
--
-- FORCE ROW LEVEL SECURITY matters here: without it, RLS does not apply to
-- the table owner, and most app connection roles end up being the owner in
-- a naive setup. Forcing it means even a misconfigured connection role is
-- still bound by tenant isolation.

DO $$
DECLARE
    tbl text;
    tenant_tables text[] := ARRAY[
        'plants', 'warehouses', 'roles', 'users', 'approval_matrix',
        'reason_codes', 'audit_log',
        'suppliers', 'purchase_requests', 'purchase_request_lines',
        'purchase_orders', 'purchase_order_lines',
        'goods_receipts', 'goods_receipt_lines',
        'chart_of_accounts', 'posting_rules',
        'journal_entries', 'journal_lines',
        'integration_queue', 'failed_posting_review'
    ];
BEGIN
    FOREACH tbl IN ARRAY tenant_tables LOOP
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

-- Cross-tenant leakage smoke test (run manually / in CI — see docs/RUNBOOK.md):
--   SET LOCAL app.tenant_id = '<tenant-a-uuid>';
--   SELECT * FROM goods_receipts WHERE tenant_id = '<tenant-b-uuid>'; -- must return 0 rows
