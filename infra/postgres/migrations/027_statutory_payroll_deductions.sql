-- Statutory payroll deductions (README "Known gaps" —
-- payroll_records.total_deductions has been hardcoded to 0 since the
-- HR/Payroll slice shipped, migration 019's own comment says so). Models
-- the two deductions every Nigerian private-sector employer of this
-- platform's size is universally subject to: PAYE income tax (Personal
-- Income Tax Act, as amended by the Finance Act 2020) and pension
-- (Pension Reform Act 2014, 8% employee contribution). NHF (National
-- Housing Fund) is deliberately NOT modeled here — inconsistently
-- enforced in practice, a separate judgment call this pass doesn't try
-- to make.

-- Single flat rate, tenant-configurable — same shape as
-- finance_connector_type (002_tenant_registry.sql): one column on the
-- tenant's own row, not a separate one-row config table, since there's
-- only ever one rate per tenant. 0.08 is the statutory default (Pension
-- Reform Act 2014); a tenant in a different jurisdiction, or a future
-- change in Nigerian pension law, overrides this per-tenant, not in code.
ALTER TABLE tenant_registry ADD COLUMN pension_employee_rate numeric(5,4) NOT NULL DEFAULT 0.08;

-- Progressive PAYE bands, tenant-configurable — the exact same threshold-
-- band shape as approval_matrix (003_governance.sql), reused here for tax
-- instead of approval routing: order + an inclusive lower bound + an
-- exclusive upper bound (NULL = "and above", the top band). The band
-- RATES are data; the surrounding CRA relief formula (see
-- payroll-tax.ts) is Nigeria-specific application logic, not data — a
-- real multi-country deployment would need to generalize that part too,
-- a known gap this pass doesn't solve.
CREATE TABLE payroll_tax_bands (
    tenant_id      uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    band_id        uuid NOT NULL DEFAULT gen_random_uuid(),
    band_order     int NOT NULL,
    threshold_min  numeric(14,2) NOT NULL,
    threshold_max  numeric(14,2),
    rate           numeric(5,4) NOT NULL,
    PRIMARY KEY (tenant_id, band_id),
    UNIQUE (tenant_id, band_order)
);

DO $$
BEGIN
    EXECUTE 'ALTER TABLE payroll_tax_bands ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE payroll_tax_bands FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY tenant_isolation ON payroll_tax_bands
                USING (tenant_id = current_tenant_id())
                WITH CHECK (tenant_id = current_tenant_id())';
END $$;

-- Auditable snapshot of the computation, alongside the existing
-- total_deductions sum (unchanged in meaning/type — nothing downstream
-- reads a breakdown, the GL posting rule sums net_salary, not this) —
-- same "don't just compute a hidden number" precedent as grade_weight_
-- used/payroll_ratio_used already snapshot their own inputs.
ALTER TABLE payroll_records ADD COLUMN deductions_breakdown jsonb;

-- hr_svc needs read access to both new configuration sources; no new
-- grant needed for payroll_records.deductions_breakdown itself — hr_svc
-- already has table-wide UPDATE (020_hr_rls_and_role.sql), which covers
-- a new column automatically.
GRANT SELECT ON tenant_registry TO hr_svc;
GRANT SELECT ON payroll_tax_bands TO hr_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U hr_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM payroll_tax_bands;"
--   -> must be 0
