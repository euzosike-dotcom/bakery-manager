-- Development seed data for the CRM vertical slice.
-- Real v4 UUIDs — see infra/postgres/seed/dev_seed.sql's header comment.
--
-- ID reference:
--   Customer CUST-0001 (Sunrise Retail Stores)   674feb2e-c9f5-47dd-9dd0-29c56b990c7d
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

INSERT INTO customers (tenant_id, customer_id, customer_code, customer_name, customer_type, plant_id, customer_status)
VALUES (
    'b17d9226-2a43-43eb-8c5e-a923637b23c5', '674feb2e-c9f5-47dd-9dd0-29c56b990c7d',
    'CUST-0001', 'Sunrise Retail Stores', 'WHOLESALE', 'aba294c3-c28c-43a9-a465-67ced442a487', 'ACTIVE'
);
