-- RLS for the new Accounting tables (same pattern as every prior module).
DO $$
DECLARE
    tbl text;
    new_tables text[] := ARRAY[
        'vendor_bills', 'vendor_bill_lines', 'vendor_bill_payments',
        'customer_invoices', 'customer_invoice_payments'
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

-- Least-privilege role for accounting-service. Unlike every prior *_svc
-- role, this one also needs write access to journal_entries/journal_lines
-- directly — manual journal entries are the one financial posting in this
-- entire platform NOT mediated by ledger-service's Kafka consumer, since a
-- manual entry has no source domain event to react to; it's operator-
-- initiated. This is a deliberate, narrow exception to "only ledger-service
-- posts to the GL", not a crack in that rule: accounting-service still
-- can't UPDATE or DELETE a posted journal_lines row (the append-only RULEs
-- from migration 005 apply regardless of which role is inserting), and it
-- still can't touch any OTHER module's ability to post automatically.
-- Password from :'accounting_svc_password' — see 007_app_role.sql's
-- comment for why, and docs/RUNBOOK.md's "Secrets in production".
\if :{?accounting_svc_password}
\else
  \set accounting_svc_password 'accounting_svc_dev_password'
\endif
CREATE ROLE accounting_svc WITH LOGIN PASSWORD :'accounting_svc_password';

GRANT CONNECT ON DATABASE metrock_erp TO accounting_svc;
GRANT USAGE ON SCHEMA public TO accounting_svc;

GRANT SELECT ON plants, suppliers, customers, sales_orders, agent_master TO accounting_svc;
GRANT SELECT, INSERT, UPDATE ON
    vendor_bills, vendor_bill_lines, vendor_bill_payments,
    customer_invoices, customer_invoice_payments
    TO accounting_svc;

-- Read access for financial reports (Trial Balance / P&L / Balance Sheet),
-- write access for manual journal entries (see role comment above).
GRANT SELECT ON chart_of_accounts, posting_rules TO accounting_svc;
GRANT SELECT, INSERT ON journal_entries, journal_lines TO accounting_svc;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO accounting_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U accounting_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM vendor_bills;"
--   -> must be 0
