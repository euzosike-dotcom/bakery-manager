-- Logistics, Fleet & Fuel Management module (docs/SDD.md §3.E) — the fourth
-- of the original 15 PRD/FRS modules to get a real vertical slice (after
-- Procurement, Manufacturing, Sales), picking up where Accounting/CRM (the
-- two platform extensions) left off.

CREATE TABLE vehicle_class_fuel_norms (
    tenant_id         uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    vehicle_class     text NOT NULL,
    litres_per_km     numeric(8,4) NOT NULL,
    -- Configurable tolerance band (SDD §3.E "Fuel Variance"): a variance
    -- inside this band is normal driving-condition noise, not investigated.
    tolerance_percent numeric(5,2) NOT NULL DEFAULT 15.00,
    PRIMARY KEY (tenant_id, vehicle_class)
);

CREATE TABLE drivers (
    tenant_id      uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    driver_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    driver_code    text NOT NULL,
    driver_name    text NOT NULL,
    phone          text,
    license_number text,
    plant_id       uuid,
    driver_status  text NOT NULL DEFAULT 'ACTIVE' CHECK (driver_status IN ('ACTIVE', 'INACTIVE')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, driver_id),
    UNIQUE (tenant_id, driver_code),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE vehicles (
    tenant_id            uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    vehicle_id           uuid NOT NULL DEFAULT gen_random_uuid(),
    vehicle_code         text NOT NULL,
    plate_number         text NOT NULL,
    vehicle_class        text NOT NULL, -- keys into vehicle_class_fuel_norms
    plant_id             uuid NOT NULL,
    service_threshold_km numeric(10,2) NOT NULL,
    current_mileage      numeric(10,2) NOT NULL DEFAULT 0,
    assigned_driver_id   uuid,
    vehicle_status       text NOT NULL DEFAULT 'ACTIVE'
                             CHECK (vehicle_status IN ('ACTIVE', 'IN_MAINTENANCE', 'RETIRED')),
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, vehicle_id),
    UNIQUE (tenant_id, vehicle_code),
    FOREIGN KEY (tenant_id, vehicle_class) REFERENCES vehicle_class_fuel_norms(tenant_id, vehicle_class),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id),
    FOREIGN KEY (tenant_id, assigned_driver_id) REFERENCES drivers(tenant_id, driver_id)
);

-- Single-shot trip capture (a completed trip logged after the fact,
-- start_mileage + end_mileage together) rather than a start/then/end
-- two-phase workflow — same "one POST, not a stateful multi-step flow"
-- simplification every other offline-capturable entity in this platform
-- already uses (GRN, batch close, sales order, NCR, activity). Not
-- required to prove the offline-sync pattern; a real dispatch app might
-- want start/end as separate actions.
CREATE TABLE trip_logs (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    trip_log_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    vehicle_id      uuid NOT NULL,
    driver_id       uuid NOT NULL,
    trip_date       timestamptz NOT NULL DEFAULT now(),
    start_mileage   numeric(10,2) NOT NULL,
    end_mileage     numeric(10,2) NOT NULL,
    trip_status     text NOT NULL DEFAULT 'COMPLETED'
                        CHECK (trip_status IN ('COMPLETED', 'CANCELLED')),
    destination_note text,
    client_event_id uuid NOT NULL,
    device_id       uuid,
    created_offline boolean NOT NULL DEFAULT false,
    sync_seq        bigserial,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, trip_log_id),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles(tenant_id, vehicle_id),
    FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, driver_id),
    CONSTRAINT end_mileage_not_before_start CHECK (end_mileage >= start_mileage)
);

-- The shared review queue Fuel Variance and the mileage service-threshold
-- both feed into (SDD §3.E: "routes both possibilities into the same
-- review queue rather than assuming one root cause"). Completion is an
-- online-only back-office action (mirrors NCR verification, Slice #3) —
-- only completion posts to the GL; auto-creation never does.
CREATE TABLE maintenance_requests (
    tenant_id        uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    maintenance_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
    vehicle_id       uuid NOT NULL,
    reason           text NOT NULL
                        CHECK (reason IN ('SERVICE_THRESHOLD', 'FUEL_VARIANCE_INVESTIGATION', 'MANUAL')),
    request_status   text NOT NULL DEFAULT 'OPEN'
                        CHECK (request_status IN ('OPEN', 'COMPLETED')),
    notes            text,
    parts_cost       numeric(14,2),
    labour_cost      numeric(14,2),
    completed_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, maintenance_request_id),
    FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles(tenant_id, vehicle_id)
);

-- Offline-capturable — the other canonical use case named in the SDD
-- mandate alongside trip_logs. `trip_log_id` is nullable (a fuel purchase
-- doesn't always tie to one specific trip, e.g. a periodic tank fill-up)
-- and, per Matrix Scenario #9, a fuel record referencing a trip that was
-- cancelled in the meantime is still accepted and posted — never rejected
-- over a referential race — just flagged via `orphaned_trip_reference`
-- for supervisor review. The FK itself stays valid either way (the trip
-- row still exists; only its `trip_status` changed), so no special
-- nullable-FK handling is needed for that case.
CREATE TABLE fuel_records (
    tenant_id                 uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    fuel_record_id            uuid NOT NULL DEFAULT gen_random_uuid(),
    vehicle_id                uuid NOT NULL,
    trip_log_id               uuid,
    litres                    numeric(10,3) NOT NULL,
    fuel_cost                 numeric(14,2) NOT NULL,
    expense_claim_reference   text,
    orphaned_trip_reference   boolean NOT NULL DEFAULT false,
    posting_status            text NOT NULL DEFAULT 'PENDING'
                                CHECK (posting_status IN ('PENDING', 'POSTED')),
    client_event_id           uuid NOT NULL,
    device_id                 uuid,
    created_offline           boolean NOT NULL DEFAULT false,
    sync_seq                  bigserial,
    created_at                timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, fuel_record_id),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles(tenant_id, vehicle_id),
    FOREIGN KEY (tenant_id, trip_log_id) REFERENCES trip_logs(tenant_id, trip_log_id)
);

CREATE INDEX idx_trip_logs_sync ON trip_logs (tenant_id, sync_seq);
CREATE INDEX idx_fuel_records_sync ON fuel_records (tenant_id, sync_seq);
CREATE INDEX idx_maintenance_requests_vehicle ON maintenance_requests (tenant_id, vehicle_id);

-- New GL accounts this module introduces.
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type)
SELECT tenant_id, '5320', 'Vehicle Fuel Expense', 'EXPENSE' FROM tenant_registry
UNION ALL
SELECT tenant_id, '5330', 'Vehicle Maintenance Expense', 'EXPENSE' FROM tenant_registry;

-- Posting rules (SDD §3.E "Financial Trigger" table):
--   fleet.fuel_recorded.v1        -> Dr Vehicle Fuel Expense (5320) / Cr Cash and Bank (1100)
--   fleet.maintenance_completed.v1 -> Dr Vehicle Maintenance Expense (5330) / Cr Accounts Payable (2110)
--
-- The SDD names an "or" on the fuel credit side (Cash/Fuel Card Payable,
-- or Employee Expense Payable if reimbursed) — this posting engine only
-- supports one fixed credit account per event_type (posting_rules.
-- condition_expression is never evaluated anywhere in this platform, a
-- documented gap since Slice #1), so this picks the single simplest,
-- deterministic path: fuel paid from company cash immediately. A
-- reimbursement-vs-direct-payment split would need condition_expression
-- actually implemented, which is out of scope for proving this module's
-- pattern.
--
-- Fuel variance itself is deliberately NOT posted (SDD §3.E note: it's an
-- operational KPI, not a transaction) — only actual fuel_cost/
-- parts_cost+labour_cost ever hit the ledger.
INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
SELECT tenant_id, 'fleet.fuel_recorded.v1', '5320', '1100', 'fuel_cost' FROM tenant_registry
UNION ALL
SELECT tenant_id, 'fleet.maintenance_completed.v1', '5330', '2110', 'total_cost' FROM tenant_registry;
