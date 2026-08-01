-- Manufacturing & Yield Intelligence module (docs/SDD.md §3.C)

CREATE TABLE product_skus (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    sku_id              uuid NOT NULL DEFAULT gen_random_uuid(),
    sku_code            text NOT NULL,
    sku_name            text NOT NULL,
    sku_category        text NOT NULL, -- e.g. 'FINISHED_GOOD', 'RAW_MATERIAL'
    unit_of_measure     text NOT NULL,
    standard_weight_kg  numeric(10,3),
    is_active           boolean NOT NULL DEFAULT true,
    plant_specific      boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, sku_id),
    UNIQUE (tenant_id, sku_code)
);

-- NOTE: `purchase_order_lines.sku_description` (migration 004) is still
-- free text, not an FK to this table — retrofitting that link is a known
-- gap (see README "Known gaps"), not done here to keep this slice scoped to
-- Manufacturing. `recipe_ingredients.ingredient_sku_id` below deliberately
-- references this new table independently.

CREATE TABLE recipes (
    tenant_id                   uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    recipe_id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    sku_id                      uuid NOT NULL,
    recipe_name                 text NOT NULL,
    current_active_version_id  uuid,
    recipe_status               text NOT NULL DEFAULT 'ACTIVE',
    PRIMARY KEY (tenant_id, recipe_id),
    FOREIGN KEY (tenant_id, sku_id) REFERENCES product_skus(tenant_id, sku_id)
);

-- Recipe versions are the snapshot-pinning unit (Conflict Matrix scenario
-- #5, docs/SDD.md §2.3): a production_batch stores recipe_version_id at
-- creation and never re-resolves "the current version" — this table (and
-- recipe_ingredients below) must therefore never be mutated in place once a
-- batch references it. `archived_flag` retires a version; corrections are a
-- new version, not an UPDATE.
CREATE TABLE recipe_versions (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    recipe_version_id       uuid NOT NULL DEFAULT gen_random_uuid(),
    recipe_id               uuid NOT NULL,
    version_no              int NOT NULL,
    effective_date          date NOT NULL DEFAULT current_date,
    approved_by_lab         boolean NOT NULL DEFAULT false,
    approved_by_finance     boolean NOT NULL DEFAULT false,
    approved_by_executive   boolean NOT NULL DEFAULT false,
    standard_batch_size     numeric(14,3) NOT NULL,
    standard_yield_qty      numeric(14,3) NOT NULL,
    standard_cost           numeric(14,2) NOT NULL, -- cost per unit of output (sku's unit_of_measure)
    yield_threshold_percent numeric(5,2) NOT NULL DEFAULT 90.00,
    archived_flag           boolean NOT NULL DEFAULT false,
    approval_status         text NOT NULL DEFAULT 'PENDING'
                                CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    notes                   text,
    PRIMARY KEY (tenant_id, recipe_version_id),
    UNIQUE (tenant_id, recipe_id, version_no),
    FOREIGN KEY (tenant_id, recipe_id) REFERENCES recipes(tenant_id, recipe_id)
);

ALTER TABLE recipes ADD FOREIGN KEY (tenant_id, current_active_version_id) REFERENCES recipe_versions(tenant_id, recipe_version_id);

CREATE TABLE recipe_ingredients (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    recipe_ingredient_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    recipe_version_id       uuid NOT NULL,
    ingredient_sku_id       uuid NOT NULL,
    quantity_per_batch      numeric(14,3) NOT NULL,
    unit_of_measure         text NOT NULL,
    -- Cost snapshot at the time this recipe version was approved — deliberately
    -- NOT a live lookup against current raw-material cost, for the same
    -- reproducibility reason a batch pins its recipe_version_id (SDD §2.3 #5).
    unit_cost               numeric(14,2) NOT NULL,
    PRIMARY KEY (tenant_id, recipe_ingredient_id),
    FOREIGN KEY (tenant_id, recipe_version_id) REFERENCES recipe_versions(tenant_id, recipe_version_id),
    FOREIGN KEY (tenant_id, ingredient_sku_id) REFERENCES product_skus(tenant_id, sku_id)
);

-- production_batches / production_consumption are the primary offline-sync
-- surface for this module (plant-floor batch logging, SDD §3.C) — same
-- idempotency-key pattern as goods_receipts (migration 004).
CREATE TABLE production_batches (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    batch_id            uuid NOT NULL DEFAULT gen_random_uuid(),
    batch_number        text NOT NULL,
    plant_id            uuid NOT NULL,
    sku_id              uuid NOT NULL,
    recipe_version_id   uuid NOT NULL, -- snapshot-pinned at creation, immutable
    batch_date          timestamptz NOT NULL DEFAULT now(),
    planned_qty         numeric(14,3) NOT NULL,
    actual_output_qty   numeric(14,3) NOT NULL,
    actual_waste_qty    numeric(14,3) NOT NULL DEFAULT 0,
    yield_percent       numeric(6,2), -- computed at close: output / total actual input * 100
    yield_alert_triggered boolean NOT NULL DEFAULT false,
    batch_status        text NOT NULL DEFAULT 'CLOSED'
                            CHECK (batch_status IN ('CLOSED', 'NEEDS_REVIEW')),
    supervisor_user_id  uuid,
    client_event_id     uuid NOT NULL,
    device_id           uuid,
    created_offline      boolean NOT NULL DEFAULT false,
    sync_seq            bigserial,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, batch_id),
    UNIQUE (tenant_id, batch_number),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id),
    FOREIGN KEY (tenant_id, sku_id) REFERENCES product_skus(tenant_id, sku_id),
    FOREIGN KEY (tenant_id, recipe_version_id) REFERENCES recipe_versions(tenant_id, recipe_version_id)
);

CREATE TABLE production_consumption (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    consumption_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    batch_id            uuid NOT NULL,
    ingredient_sku_id   uuid NOT NULL,
    planned_qty         numeric(14,3) NOT NULL,
    actual_qty          numeric(14,3) NOT NULL,
    unit_cost           numeric(14,2) NOT NULL, -- copied from recipe_ingredients snapshot at batch close
    variance_qty        numeric(14,3) GENERATED ALWAYS AS (actual_qty - planned_qty) STORED,
    PRIMARY KEY (tenant_id, consumption_id),
    FOREIGN KEY (tenant_id, batch_id) REFERENCES production_batches(tenant_id, batch_id),
    FOREIGN KEY (tenant_id, ingredient_sku_id) REFERENCES product_skus(tenant_id, sku_id)
);

CREATE INDEX idx_production_batches_sync ON production_batches (tenant_id, sync_seq);

-- Additional chart of accounts for the manufacturing postings (SDD §3.C
-- Financial Trigger): 1310 Raw Material Inventory already exists (migration
-- 005/seed); this module adds WIP, Finished Goods, and the variance account.
--
-- NOTE: this INSERT...SELECT FROM tenant_registry backfills every tenant
-- that exists when this migration runs — it does not cover tenants
-- provisioned afterward. Production tenant provisioning (SDD §1.2 step 2,
-- "seed a starter chart_of_accounts") must include these accounts + the
-- posting rules below in its own seed step, not rely on this migration.
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type)
SELECT tenant_id, '1320', 'Work-in-Progress (WIP)', 'ASSET' FROM tenant_registry
UNION ALL
SELECT tenant_id, '1330', 'Finished Goods Inventory', 'ASSET' FROM tenant_registry
UNION ALL
SELECT tenant_id, '5310', 'Manufacturing Variance Expense', 'EXPENSE' FROM tenant_registry;

-- Hardening noticed while extending posting_rules for this module: nothing
-- stopped two *active* rules existing for the same (tenant, event_type) —
-- the Go ledger's loadPostingRule() does `LIMIT 1`, so a duplicate would be
-- picked nondeterministically instead of erroring. A partial unique index
-- (only enforced while is_active) allows historical inactive rules to
-- coexist (e.g. a tenant's old COA mapping kept for audit) while still
-- guaranteeing exactly one live rule per event type.
CREATE UNIQUE INDEX one_active_posting_rule_per_event_type
    ON posting_rules (tenant_id, event_type) WHERE is_active;

-- Posting rules (SDD §3.C):
--   consumption: Dr WIP / Cr Raw Material Inventory, at ACTUAL cost
--   output:      Dr Finished Goods / Cr WIP, at STANDARD cost
--   variance:    whatever's left in WIP after the two postings above is the
--                variance; two event types (not a conditional rule) so the
--                ledger engine's simple fixed-Dr/Cr-per-event-type model
--                (posting_rules) doesn't need conditional-direction logic.
INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
SELECT tenant_id, 'batch.consumption_recorded.v1', '1320', '1310', 'consumption_value' FROM tenant_registry
UNION ALL
SELECT tenant_id, 'batch.output_recorded.v1', '1330', '1320', 'output_value' FROM tenant_registry
UNION ALL
SELECT tenant_id, 'batch.yield_variance_unfavorable.v1', '5310', '1320', 'variance_value' FROM tenant_registry
UNION ALL
SELECT tenant_id, 'batch.yield_variance_favorable.v1', '1320', '5310', 'variance_value' FROM tenant_registry;
