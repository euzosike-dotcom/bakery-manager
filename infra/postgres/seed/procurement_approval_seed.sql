-- Additional Procurement seed data for exercising approval_matrix
-- enforcement (docs/RUNBOOK.md's "Approval-matrix enforcement" section):
-- two fresh PENDING purchase orders straddling the two threshold bands
-- seeded in governance_seed.sql (below 500,000 -> Procurement Manager;
-- at/above 500,000 -> Finance Controller), distinct from dev_seed.sql's
-- PO-2026-00001 which is already APPROVED and unsuitable for proving the
-- approve/reject flow from a clean PENDING state.
--
-- Reuses tenant/plant/supplier IDs from dev_seed.sql's ID reference
-- comment. Real RFC-4122 v4 UUIDs throughout (see dev_seed.sql's comment
-- on why cosmetic placeholders fail class-validator's @IsUUID()).
--
-- ID reference (new in this file):
--   PO PO-2026-00002 (below threshold, 320,000) f8c88668-95f3-41d7-8a5f-4c90db2a73ce
--   PO line (Sugar)                             dc9d6570-dada-4b36-a447-a55f336f303a
--   PO PO-2026-00003 (above threshold, 750,000) b1649aa4-1d05-4bba-92db-584322a37e94
--   PO line (Cocoa Butter)                      1ab7dc01-242d-4b41-99cf-39930f2eb104
--   PO PO-2026-00004 (below threshold, 200,000) 1462090d-c234-43c3-bee4-35ce0043e84a
--   PO line (Cocoa Powder)                      211ca5d1-8f09-4952-8060-18c2ff59f5a4
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

INSERT INTO purchase_orders (tenant_id, po_id, po_number, supplier_id, plant_id, po_date, currency, approval_status, po_status, total_po_value)
VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'f8c88668-95f3-41d7-8a5f-4c90db2a73ce', 'PO-2026-00002', 'cb6e3879-86db-482e-a602-8a696d2b5a40', 'aba294c3-c28c-43a9-a465-67ced442a487', current_date, 'NGN', 'PENDING', 'OPEN', 320000.00),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'b1649aa4-1d05-4bba-92db-584322a37e94', 'PO-2026-00003', 'cb6e3879-86db-482e-a602-8a696d2b5a40', 'aba294c3-c28c-43a9-a465-67ced442a487', current_date, 'NGN', 'PENDING', 'OPEN', 750000.00),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '1462090d-c234-43c3-bee4-35ce0043e84a', 'PO-2026-00004', 'cb6e3879-86db-482e-a602-8a696d2b5a40', 'aba294c3-c28c-43a9-a465-67ced442a487', current_date, 'NGN', 'PENDING', 'OPEN', 200000.00);

INSERT INTO purchase_order_lines (tenant_id, po_line_id, po_id, sku_description, ordered_qty, uom, unit_cost)
VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'dc9d6570-dada-4b36-a447-a55f336f303a', 'f8c88668-95f3-41d7-8a5f-4c90db2a73ce', 'Sugar — 50kg bags', 800, 'KG', 400.00),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '1ab7dc01-242d-4b41-99cf-39930f2eb104', 'b1649aa4-1d05-4bba-92db-584322a37e94', 'Cocoa Butter — 25kg blocks', 500, 'KG', 1500.00),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '211ca5d1-8f09-4952-8060-18c2ff59f5a4', '1462090d-c234-43c3-bee4-35ce0043e84a', 'Cocoa Powder — 25kg bags', 400, 'KG', 500.00);
