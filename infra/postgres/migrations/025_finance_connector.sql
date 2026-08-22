-- Consumer side of integration_queue (005_finance.sql) — the "Finance
-- Connector Framework" the SDD originally scoped against Zoho Books /
-- QuickBooks / Xero / SAP. Metrock (Tenant Zero) runs its own custom-built
-- module instead of any of those, so this adds 'CUSTOM_MODULE' as a new,
-- additional option rather than replacing the existing ones — a real
-- resold tenant on this platform may still genuinely want a Zoho/QuickBooks
-- connector later, and the CHECK constraint should keep room for that.
ALTER TABLE tenant_registry DROP CONSTRAINT tenant_registry_finance_connector_type_check;
ALTER TABLE tenant_registry ADD CONSTRAINT tenant_registry_finance_connector_type_check
    CHECK (finance_connector_type IN ('NONE', 'CUSTOM_MODULE', 'ZOHO_BOOKS', 'QUICKBOOKS', 'XERO', 'SAP'));

-- What "our own custom module" actually receives and stores — a durable,
-- queryable record that a real downstream system got each posting, kept
-- separate from journal_entries/journal_lines (which remain the Unified
-- Ledger's own system of record — this table is the RECEIVING side of the
-- sync, not a second copy of the source of truth). One row per synced
-- integration_queue row; lines_json snapshots that journal entry's full
-- set of GL lines at sync time (account_code/debit/credit/plant), since a
-- real external system's own ledger mirror wouldn't stay live-joined to
-- journal_lines after ingesting a posting.
CREATE TABLE external_ledger_postings (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    external_posting_id uuid NOT NULL DEFAULT gen_random_uuid(),
    queue_id             uuid NOT NULL,
    source_module         text NOT NULL,
    transaction_type      text NOT NULL,
    journal_entry_id      uuid NOT NULL,
    lines_json             jsonb NOT NULL,
    posted_external_id    text NOT NULL,
    received_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, external_posting_id),
    -- Idempotency backstop: if the connector crashes after this insert but
    -- before marking the integration_queue row POSTED, a retry must not
    -- double-post — the unique violation on retry is caught and treated as
    -- "already synced, just finish marking the queue row" rather than a
    -- real failure. Same idempotency shape as journal_entries.source_event_id
    -- (005_finance.sql) and activities.client_event_id (012_crm.sql).
    UNIQUE (tenant_id, queue_id),
    FOREIGN KEY (tenant_id, queue_id) REFERENCES integration_queue(tenant_id, queue_id)
);

DO $$
BEGIN
    EXECUTE 'ALTER TABLE external_ledger_postings ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE external_ledger_postings FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY tenant_isolation ON external_ledger_postings
                USING (tenant_id = current_tenant_id())
                WITH CHECK (tenant_id = current_tenant_id())';
END $$;

-- Least-privilege role for finance-connector-service, same rationale as
-- every prior module's *_svc role (007_app_role.sql). Unlike every other
-- domain service, this one is a background poller with no user-triggered
-- writes into anyone else's tables — it only ever reads journal_entries/
-- journal_lines (to build the posting it syncs out) and updates the two
-- tables that already exist specifically to track sync state
-- (integration_queue, failed_posting_review, both from 005_finance.sql).
-- No SELECT on chart_of_accounts/posting_rules — this service never
-- resolves or validates account codes itself, only relays whatever the
-- Unified Ledger already posted.
\if :{?finance_connector_svc_password}
\else
  \set finance_connector_svc_password 'finance_connector_svc_dev_password'
\endif
CREATE ROLE finance_connector_svc WITH LOGIN PASSWORD :'finance_connector_svc_password';

GRANT CONNECT ON DATABASE metrock_erp TO finance_connector_svc;
GRANT USAGE ON SCHEMA public TO finance_connector_svc;
GRANT SELECT ON tenant_registry TO finance_connector_svc;
GRANT SELECT ON journal_entries, journal_lines TO finance_connector_svc;
GRANT SELECT, UPDATE ON integration_queue TO finance_connector_svc;
GRANT SELECT, INSERT ON failed_posting_review TO finance_connector_svc;
GRANT SELECT, INSERT ON external_ledger_postings TO finance_connector_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO finance_connector_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U finance_connector_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM external_ledger_postings;"
--   -> must be 0
