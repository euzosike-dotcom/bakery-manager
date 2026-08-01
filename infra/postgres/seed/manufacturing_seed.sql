-- Development seed data for the Manufacturing & Yield vertical slice.
-- Real v4 UUIDs throughout — see infra/postgres/seed/dev_seed.sql's header
-- comment for why cosmetic placeholder UUIDs are not used (they fail
-- class-validator's @IsUUID() checks).
--
-- ID reference:
--   SKU BRD-500G (finished good, standard white bread)  8558cee8-8acd-4d5a-a334-3b3dc4088512
--   SKU FLR-001 (raw material, flour)                    39db8695-0360-4ae3-9d28-85472f5b270e
--   SKU SGR-001 (raw material, sugar)                    d48dfceb-22ad-414b-a053-fde5ed84332f
--   SKU YST-001 (raw material, yeast)                    7f7a9932-dd76-44b9-8e0a-43f4ff30d5e7
--   SKU SLT-001 (raw material, salt)                      97efb0b1-9c5f-418c-a805-b6e1c0f7c316
--   Recipe "Standard White Bread"                         aa5feda0-73c5-444c-80c4-947a8d1ae503
--   Recipe Version 1 (approved)                            103f648b-d180-4be8-951c-ba011a7d8725
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

INSERT INTO product_skus (tenant_id, sku_id, sku_code, sku_name, sku_category, unit_of_measure, standard_weight_kg) VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '8558cee8-8acd-4d5a-a334-3b3dc4088512', 'BRD-500G', 'Standard White Bread 500g', 'FINISHED_GOOD', 'UNIT', 0.5),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '39db8695-0360-4ae3-9d28-85472f5b270e', 'FLR-001', 'Wheat Flour', 'RAW_MATERIAL', 'KG', NULL),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'd48dfceb-22ad-414b-a053-fde5ed84332f', 'SGR-001', 'Granulated Sugar', 'RAW_MATERIAL', 'KG', NULL),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '7f7a9932-dd76-44b9-8e0a-43f4ff30d5e7', 'YST-001', 'Baker''s Yeast', 'RAW_MATERIAL', 'KG', NULL),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '97efb0b1-9c5f-418c-a805-b6e1c0f7c316', 'SLT-001', 'Salt', 'RAW_MATERIAL', 'KG', NULL);

INSERT INTO recipes (tenant_id, recipe_id, sku_id, recipe_name, recipe_status)
VALUES ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'aa5feda0-73c5-444c-80c4-947a8d1ae503', '8558cee8-8acd-4d5a-a334-3b3dc4088512', 'Standard White Bread', 'ACTIVE');

INSERT INTO recipe_versions (
    tenant_id, recipe_version_id, recipe_id, version_no, approved_by_lab, approved_by_finance, approved_by_executive,
    standard_batch_size, standard_yield_qty, standard_cost, yield_threshold_percent, approval_status
) VALUES (
    'b17d9226-2a43-43eb-8c5e-a923637b23c5', '103f648b-d180-4be8-951c-ba011a7d8725', 'aa5feda0-73c5-444c-80c4-947a8d1ae503', 1,
    true, true, true, 343.000, 900.000, 190.00, 90.00, 'APPROVED'
);

UPDATE recipes SET current_active_version_id = '103f648b-d180-4be8-951c-ba011a7d8725'
    WHERE tenant_id = 'b17d9226-2a43-43eb-8c5e-a923637b23c5' AND recipe_id = 'aa5feda0-73c5-444c-80c4-947a8d1ae503';

-- Ingredient costs deliberately match the flour cost already established in
-- dev_seed.sql's PO-2026-00001 (480/kg) so the two modules stay internally
-- consistent for anyone cross-checking numbers.
INSERT INTO recipe_ingredients (tenant_id, recipe_ingredient_id, recipe_version_id, ingredient_sku_id, quantity_per_batch, unit_of_measure, unit_cost) VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '8447c200-784b-4093-aeee-42ab703b1fb9', '103f648b-d180-4be8-951c-ba011a7d8725', '39db8695-0360-4ae3-9d28-85472f5b270e', 300.000, 'KG', 480.00),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'fb6df3e5-7478-4839-b048-e3f05c45ae01', '103f648b-d180-4be8-951c-ba011a7d8725', 'd48dfceb-22ad-414b-a053-fde5ed84332f', 30.000, 'KG', 650.00),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '3430e941-01a6-4f21-aa61-feb7f178b0ed', '103f648b-d180-4be8-951c-ba011a7d8725', '7f7a9932-dd76-44b9-8e0a-43f4ff30d5e7', 5.000, 'KG', 1200.00),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', '330bf0c0-33f8-430f-8e95-7b0ef67c243f', '103f648b-d180-4be8-951c-ba011a7d8725', '97efb0b1-9c5f-418c-a805-b6e1c0f7c316', 8.000, 'KG', 150.00);
