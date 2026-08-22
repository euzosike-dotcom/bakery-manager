-- Sales Agent Onboarding (explicit user request): initiation, approval
-- with customizable levels and assigned roles per level, and provisioning
-- of the real agent. Lives in sales-service — it owns agent_master
-- (010_sales_agent_capital.sql), and there has never been a create-agent
-- pathway at all before this (agents.controller.ts is list/capital-status
-- only; every agent_master row so far has come from a seed file).
--
-- "Customizable levels and assigned roles for approval" is exactly what
-- approval_matrix's approval_level_1/2/3_role_id columns and
-- checkApprovalAuthority's stage parameter already support (docs/SDD.md
-- §4.2) — every module that has used this mechanism so far
-- (Procurement/Accounting/Fleet/Expense) has only ever populated
-- approval_level_1_role_id, one required role per band. This is the
-- first module to populate a SECOND level on a real band (see
-- governance_seed.sql) — a request above a tenant-configurable capital
-- threshold requires two sequential sign-offs, not one; approve() below
-- is unchanged from every other module's approve() (it already handled
-- `hasNextStage` generically, just never had a seeded band that used it).
CREATE TABLE agent_onboarding_requests (
    tenant_id                uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    onboarding_request_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    agent_code               text NOT NULL,
    agent_name               text NOT NULL,
    agent_type               text NOT NULL DEFAULT 'FIELD_AGENT',
    plant_id                 uuid NOT NULL,
    requested_trading_capital numeric(14,2) NOT NULL CHECK (requested_trading_capital > 0),
    capital_cap              numeric(14,2),
    base_discount_percent    numeric(5,2) NOT NULL DEFAULT 0,
    status                   text NOT NULL DEFAULT 'PENDING_APPROVAL'
                                 CHECK (status IN ('PENDING_APPROVAL', 'PROVISIONED', 'REJECTED')),
    current_approval_stage   int NOT NULL DEFAULT 1,
    pending_approver_role_id uuid,
    agent_id                 uuid,
    submitted_by_user_id     uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, onboarding_request_id),
    UNIQUE (tenant_id, agent_code),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants (tenant_id, plant_id),
    FOREIGN KEY (tenant_id, agent_id) REFERENCES agent_master (tenant_id, agent_id)
);

DO $$
BEGIN
    EXECUTE 'ALTER TABLE agent_onboarding_requests ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE agent_onboarding_requests FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY tenant_isolation ON agent_onboarding_requests
                USING (tenant_id = current_tenant_id())
                WITH CHECK (tenant_id = current_tenant_id())';
END $$;

-- sales_svc already has SELECT/INSERT/UPDATE on agent_master itself
-- (011_sales_rls_and_role.sql) — provisioning INSERTs into that table
-- needed no new grant, only this new table does.
GRANT SELECT, INSERT, UPDATE ON agent_onboarding_requests TO sales_svc;

-- approval_matrix seed rows for module SALES / transaction_type
-- AGENT_ONBOARDING deliberately live in governance_seed.sql, not here —
-- same reasoning migration 031's own header comment gives: a real
-- role_id foreign key only exists in the 3-user dev seed, not in every
-- environment this migration runs against (e.g. CI's clean-schema-only
-- database).
