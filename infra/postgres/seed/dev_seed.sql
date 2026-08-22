-- Development seed data for the Procurement GRN vertical slice.
--
-- Uses real RFC-4122 v4 UUIDs (crypto.randomUUID()), not cosmetic
-- sequential placeholders (00000000-...-000601) — the latter fail
-- class-validator's @IsUUID() checks in procurement-service's DTOs because
-- their version/variant nibbles aren't valid, which only surfaces once
-- something actually POSTs a body containing one. Learned that the hard way
-- wiring this up; keeping this comment so nobody "cleans up" these IDs back
-- into readable-but-invalid placeholders.
--
-- ID reference (also see docs/RUNBOOK.md, which uses these same values):
--   tenant (METROCK)         b17d9226-2a43-43eb-8c5e-a923637b23c5
--   role: stores clerk       2986c576-6beb-4916-a5c1-239aee7a1957
--   role: procurement mgr    1a946225-e283-4bbe-9c05-939dff09a1cf
--   role: finance controller 5ee22c8f-d7fa-4f40-9814-744412c5fcde
--   plant PLT-1              aba294c3-c28c-43a9-a465-67ced442a487
--   warehouse WH-PLT1-RM     7840f37a-13eb-4779-aa16-84bf10f7d351
--   user (Amaka Obi)         b5875910-4707-4a3a-952d-3f2cde434d4e
--   user (Chidinma Eze)      3e8fa1cb-96d1-4e93-b36b-80699a5a937f
--   user (Tunde Bakare)      c23f62b6-f975-48c4-b8ae-5dbdc6fb8e47
--   supplier SUP-001         cb6e3879-86db-482e-a602-8a696d2b5a40
--   PO PO-2026-00001         46778dc9-e4dc-4d00-9f53-3a2b476a0f64
--   PO line (Flour)          db94681e-d781-4c12-ad1c-4d7d7204f480
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

INSERT INTO tenant_registry (tenant_id, tenant_code, tenant_name, isolation_tier, default_currency, finance_connector_type)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'METROCK', 'Metrock Enterprises', 'POOL', 'NGN', 'CUSTOM_MODULE');

INSERT INTO roles (tenant_id, role_id, role_code, role_name, role_category, can_approve, can_post, can_override)
VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '2986c576-6beb-4916-a5c1-239aee7a1957', 'STORES_CLERK', 'Stores Clerk', 'OPERATIONS', false, false, false),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '1a946225-e283-4bbe-9c05-939dff09a1cf', 'PROCUREMENT_MGR', 'Procurement Manager', 'PROCUREMENT', true, true, false),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '5ee22c8f-d7fa-4f40-9814-744412c5fcde', 'FINANCE_CONTROLLER', 'Finance Controller', 'FINANCE', true, true, true);

INSERT INTO plants (tenant_id, plant_id, plant_code, plant_name, plant_type, plant_status, supports_production)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'aba294c3-c28c-43a9-a465-67ced442a487', 'PLT-1', 'Metrock Plant 1 — Lagos', 'MANUFACTURING', 'ACTIVE', true);

INSERT INTO warehouses (tenant_id, warehouse_id, warehouse_code, warehouse_name, plant_id, warehouse_type)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '7840f37a-13eb-4779-aa16-84bf10f7d351', 'WH-PLT1-RM', 'Plant 1 Raw Materials Store', 'aba294c3-c28c-43a9-a465-67ced442a487', 'RAW_MATERIAL');

-- Chidinma Eze (PROCUREMENT_MGR) and Tunde Bakare (FINANCE_CONTROLLER) exist
-- to exercise approval_matrix's two threshold tiers end-to-end (see
-- procurement_approval_seed.sql's PENDING test POs and docs/RUNBOOK.md's
-- "Approval-matrix enforcement" section) — a single STORES_CLERK
-- (can_approve=false) isn't enough to prove tier-specific routing.
INSERT INTO users (tenant_id, user_id, employee_code, full_name, email, role_id, plant_id)
VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'b5875910-4707-4a3a-952d-3f2cde434d4e', 'EMP-0001', 'Amaka Obi', 'amaka.obi@metrock.dev', '2986c576-6beb-4916-a5c1-239aee7a1957', 'aba294c3-c28c-43a9-a465-67ced442a487'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '3e8fa1cb-96d1-4e93-b36b-80699a5a937f', 'EMP-0002', 'Chidinma Eze', 'chidinma.eze@metrock.dev', '1a946225-e283-4bbe-9c05-939dff09a1cf', 'aba294c3-c28c-43a9-a465-67ced442a487'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'c23f62b6-f975-48c4-b8ae-5dbdc6fb8e47', 'EMP-0003', 'Tunde Bakare', 'tunde.bakare@metrock.dev', '5ee22c8f-d7fa-4f40-9814-744412c5fcde', 'aba294c3-c28c-43a9-a465-67ced442a487');

INSERT INTO suppliers (tenant_id, supplier_id, supplier_code, supplier_name, payment_terms, default_currency)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'cb6e3879-86db-482e-a602-8a696d2b5a40', 'SUP-001', 'Golden Wheat Millers Ltd', 'NET_30', 'NGN');

-- Minimal chart of accounts needed to post GRN journal entries (SDD §3.B)
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type) VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '1310', 'Raw Material Inventory', 'ASSET'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '2110', 'Accounts Payable', 'LIABILITY');

-- Posting rule: grn.posted.v1 -> Dr Raw Material Inventory / Cr Accounts Payable
INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'grn.posted.v1', '1310', '2110', 'accepted_value');

INSERT INTO purchase_orders (tenant_id, po_id, po_number, supplier_id, plant_id, po_date, currency, approval_status, po_status, total_po_value)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '46778dc9-e4dc-4d00-9f53-3a2b476a0f64', 'PO-2026-00001', 'cb6e3879-86db-482e-a602-8a696d2b5a40', 'aba294c3-c28c-43a9-a465-67ced442a487', current_date, 'NGN', 'APPROVED', 'OPEN', 480000.00);

INSERT INTO purchase_order_lines (tenant_id, po_line_id, po_id, sku_description, ordered_qty, uom, unit_cost)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'db94681e-d781-4c12-ad1c-4d7d7204f480', '46778dc9-e4dc-4d00-9f53-3a2b476a0f64', 'Flour — 50kg bags', 1000, 'KG', 480.00);
