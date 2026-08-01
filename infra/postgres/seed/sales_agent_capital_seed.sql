-- Development seed data for the Sales & Agent Capital vertical slice.
-- Real v4 UUIDs — see infra/postgres/seed/dev_seed.sql's header comment.
--
-- ID reference:
--   Agent AG-0001 (Amaka's counterpart in the field)   3db3020f-f5fd-4eae-bfa9-f7b9a1ad90d4
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

INSERT INTO agent_master (tenant_id, agent_id, agent_code, agent_name, agent_type, plant_id, approved_trading_capital, capital_cap, base_discount_percent)
VALUES (
    'b17d9226-2a43-43eb-8c5e-a923637b23c5', '3db3020f-f5fd-4eae-bfa9-f7b9a1ad90d4',
    'AG-0001', 'Chidi Okafor', 'FIELD_AGENT', 'aba294c3-c28c-43a9-a465-67ced442a487',
    500000.00, 750000.00, 5.00
);
