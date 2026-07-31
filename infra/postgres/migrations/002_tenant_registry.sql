-- Root of the tenant hierarchy. Every other table's tenant_id references this.
CREATE TABLE tenant_registry (
    tenant_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_code         text UNIQUE NOT NULL,
    tenant_name         text NOT NULL,
    isolation_tier      text NOT NULL DEFAULT 'POOL'
                            CHECK (isolation_tier IN ('POOL', 'BRIDGE', 'SILO')),
    region              text NOT NULL DEFAULT 'default',
    default_currency    text NOT NULL DEFAULT 'NGN',
    finance_connector_type text NOT NULL DEFAULT 'NONE'
                            CHECK (finance_connector_type IN ('NONE', 'ZOHO_BOOKS', 'QUICKBOOKS', 'XERO', 'SAP')),
    status              text NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED')),
    provisioned_at      timestamptz NOT NULL DEFAULT now()
);

-- Helper used by every RLS policy below: the current request's tenant_id,
-- set per-transaction via `SET LOCAL app.tenant_id = '<uuid>'` by the
-- application's tenant-context middleware (see procurement-service).
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
