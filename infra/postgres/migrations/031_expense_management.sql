-- Expense Management (explicit user request): expense requests, approval-
-- matrix routing, booking to the chart of accounts, and configurable
-- expense categories. Lives in accounting-service, not a new service —
-- this is the same "propose an amount, get it tier-approved, post it to
-- the ledger" shape bills/invoices/journal entries already have, and
-- expense_requests' own posting is a direct write into journal_entries/
-- journal_lines exactly like a manual journal entry (migration 022), not
-- an async Kafka-event posting — there's no natural domain event, this IS
-- the operator-initiated request.

-- Tenant-configurable list of categories an expense request may be filed
-- under, each mapped to the EXPENSE account it books to — same
-- "configurable master data owned by the domain service that uses it"
-- shape as payroll_tax_bands (migration 027), not governance-service's
-- reason_codes: this is accounting-specific configuration tied directly
-- to this tenant's own chart_of_accounts, not a generic cross-module
-- audit-trail registry.
CREATE TABLE expense_categories (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    category_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    category_name   text NOT NULL,
    gl_account_code text NOT NULL,
    is_active       boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, category_id),
    UNIQUE (tenant_id, category_name),
    FOREIGN KEY (tenant_id, gl_account_code) REFERENCES chart_of_accounts (tenant_id, account_code)
);

-- The request itself. Same PENDING_APPROVAL/POSTED/REJECTED + current_
-- approval_stage/pending_approver_role_id shape as journal_entries
-- (migration 022) — creation calls no authority check at all, only
-- approve/reject do, via checkApprovalAuthority, and reject requires the
-- identical tier-check as approve (the same rule every approval_matrix
-- module in this platform follows). journal_entry_id is populated only
-- once approved — the real, auditable link to whatever got booked, not a
-- second description of it.
CREATE TABLE expense_requests (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    expense_request_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    category_id             uuid NOT NULL,
    amount                  numeric(14,2) NOT NULL CHECK (amount > 0),
    description             text,
    submitted_by_user_id    uuid,
    status                  text NOT NULL DEFAULT 'PENDING_APPROVAL'
                                CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED')),
    current_approval_stage  int NOT NULL DEFAULT 1,
    pending_approver_role_id uuid,
    journal_entry_id        uuid,
    created_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, expense_request_id),
    FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories (tenant_id, category_id)
);

DO $$
BEGIN
    EXECUTE 'ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE expense_categories FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY tenant_isolation ON expense_categories
                USING (tenant_id = current_tenant_id())
                WITH CHECK (tenant_id = current_tenant_id())';

    EXECUTE 'ALTER TABLE expense_requests ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE expense_requests FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY tenant_isolation ON expense_requests
                USING (tenant_id = current_tenant_id())
                WITH CHECK (tenant_id = current_tenant_id())';
END $$;

GRANT SELECT, INSERT, UPDATE ON expense_categories TO accounting_svc;
GRANT SELECT, INSERT, UPDATE ON expense_requests TO accounting_svc;

-- Approval routing (docs/SDD.md §4.2) itself is NOT seeded here — unlike
-- chart_of_accounts/expense_categories below, an approval_matrix row
-- needs a real role_id foreign key, which only exists in the 3-user dev
-- dataset (dev_seed.sql), not in every environment this migration runs
-- against (e.g. CI's clean-schema-only database). Same reasoning
-- migrations 022/023/024 already follow: they never insert approval_
-- matrix rows themselves either — that seed data lives in
-- infra/postgres/seed/governance_seed.sql, alongside the equivalent
-- Procurement/Accounting/Fleet/Manufacturing bands.

-- A first, real, usable category out of the box — Office Supplies against
-- a new EXPENSE account (no existing account fit; Vehicle Fuel/Maintenance
-- and Salary/Wages are all module-specific, and reusing one for a
-- general-purpose category would blur two unrelated postings together in
-- every report that reads it). More categories are ordinary application
-- data from here — added via POST /expense-categories, not another
-- migration. Both inserts use the dynamic SELECT ... FROM tenant_registry
-- form every other migration's chart_of_accounts seeding uses (008, 010,
-- 017, 019, 028, 029) rather than a literal tenant_id — neither needs a
-- role_id, so unlike approval_matrix above there's no reason this can't
-- work generically for however many tenants actually exist (zero rows
-- inserted, not an error, when none do).
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type)
SELECT tenant_id, '5350', 'Office Supplies Expense', 'EXPENSE' FROM tenant_registry;

INSERT INTO expense_categories (tenant_id, category_name, gl_account_code)
SELECT tenant_id, 'Office Supplies', '5350' FROM tenant_registry;
