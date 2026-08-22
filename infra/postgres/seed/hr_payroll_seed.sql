-- Development seed data for the HR & Revenue-Based Payroll vertical slice.
-- Real v4 UUIDs — see infra/postgres/seed/dev_seed.sql's header comment.
--
-- ID reference:
--   Employee EMP-0001 (Ngozi Adeyemi, GRADE_A)  72946db0-8099-4ceb-8d42-0862bf38f2f5
--   Employee EMP-0002 (Tunde Bakare, GRADE_B)    a7db5d71-6f56-42c7-94a5-fe48d3eaf6b0
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

-- 15% of PLT-1's confirmed revenue for a period becomes that period's
-- payroll pool — tenant-configurable, set here directly (no admin UI to
-- change it, same as every other module's "configurable master data"
-- seeded rather than exposed via an endpoint at this stage, e.g. Fleet's
-- vehicle_class_fuel_norms.tolerance_percent).
UPDATE plants SET payroll_ratio = 0.15
WHERE tenant_id = 'b17d9226-2a43-43eb-8c5e-a923637b23c5'
  AND plant_id = 'aba294c3-c28c-43a9-a465-67ced442a487';

INSERT INTO salary_grades (tenant_id, grade_code, grade_name, grade_weight)
VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'GRADE_A', 'Senior Staff', 0.6000),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'GRADE_B', 'Junior Staff', 0.3000);

INSERT INTO employees (tenant_id, employee_id, employee_code, full_name, plant_id, department, grade_code, employment_status)
VALUES
    (
        'b17d9226-2a43-43eb-8c5e-a923637b23c5', '72946db0-8099-4ceb-8d42-0862bf38f2f5',
        'EMP-0001', 'Ngozi Adeyemi', 'aba294c3-c28c-43a9-a465-67ced442a487', 'Production', 'GRADE_A', 'ACTIVE'
    ),
    (
        'b17d9226-2a43-43eb-8c5e-a923637b23c5', 'a7db5d71-6f56-42c7-94a5-fe48d3eaf6b0',
        'EMP-0002', 'Tunde Bakare', 'aba294c3-c28c-43a9-a465-67ced442a487', 'Production', 'GRADE_B', 'ACTIVE'
    );

-- Nigerian PAYE progressive bands (Personal Income Tax Act, as amended by
-- the Finance Act 2020) — ANNUAL thresholds; hr-service annualizes gross
-- monthly pay before applying these, then de-annualizes the result (see
-- payroll-tax.ts). tenant_registry.pension_employee_rate keeps its
-- migration-default 0.08 (8%, Pension Reform Act 2014) — not overridden
-- here, nothing about this tenant needs a non-standard rate.
INSERT INTO payroll_tax_bands (tenant_id, band_order, threshold_min, threshold_max, rate) VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 1,       0.00,  300000.00, 0.07),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 2,  300000.00,  600000.00, 0.11),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 3,  600000.00, 1100000.00, 0.15),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 4, 1100000.00, 1600000.00, 0.19),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 5, 1600000.00, 3200000.00, 0.21),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 6, 3200000.00,       NULL, 0.24);
