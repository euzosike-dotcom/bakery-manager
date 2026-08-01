-- Development seed data for the Logistics/Fleet vertical slice.
-- Real v4 UUIDs — see infra/postgres/seed/dev_seed.sql's header comment.
--
-- ID reference:
--   Driver DRV-0001 (Emeka Nwosu)              1c6fb419-9523-4b1d-b27f-295d625c5609
--   Vehicle VEH-0001 (Delivery Van, LAG-442-XY) 7bc7e468-5f58-4a8a-857f-e1cc46a281f4
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

INSERT INTO vehicle_class_fuel_norms (tenant_id, vehicle_class, litres_per_km, tolerance_percent)
VALUES (
    'b17d9226-2a43-43eb-8c5e-a923637b23c5', 'DELIVERY_VAN', 0.12, 15.00
);

INSERT INTO drivers (tenant_id, driver_id, driver_code, driver_name, phone, license_number, plant_id, driver_status)
VALUES (
    'b17d9226-2a43-43eb-8c5e-a923637b23c5', '1c6fb419-9523-4b1d-b27f-295d625c5609',
    'DRV-0001', 'Emeka Nwosu', '08023456789', 'LIC-LAG-00123',
    'aba294c3-c28c-43a9-a465-67ced442a487', 'ACTIVE'
);

INSERT INTO vehicles (
    tenant_id, vehicle_id, vehicle_code, plate_number, vehicle_class, plant_id,
    service_threshold_km, current_mileage, assigned_driver_id, vehicle_status
)
VALUES (
    'b17d9226-2a43-43eb-8c5e-a923637b23c5', '7bc7e468-5f58-4a8a-857f-e1cc46a281f4',
    'VEH-0001', 'LAG-442-XY', 'DELIVERY_VAN', 'aba294c3-c28c-43a9-a465-67ced442a487',
    10000.00, 9850.00, '1c6fb419-9523-4b1d-b27f-295d625c5609', 'ACTIVE'
);
