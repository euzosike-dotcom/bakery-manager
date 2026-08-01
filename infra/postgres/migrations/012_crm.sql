-- Customer Relationship Management module — NOT one of the original 15
-- modules in Metrock's PRD/FRS (see docs/SDD.md §5 traceability for the
-- original list); added as a platform extension at the user's request,
-- alongside Accounting. Integrates with the existing Sales & Agent Capital
-- module by adding a nullable customer_id to sales_orders (below) rather
-- than replacing that module's agent-capital financial gate, which is
-- unchanged.
--
-- Deliberately one table for both "prospect" and "existing customer"
-- (via customer_status) rather than a separate Leads table — a CRM
-- opportunity is always against a customer record in this model, whether
-- or not that customer has transacted yet. Simpler than a Lead/Customer
-- conversion workflow, which isn't required to prove the pattern.

CREATE TABLE customers (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    customer_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    customer_code   text NOT NULL,
    customer_name   text NOT NULL,
    customer_type   text NOT NULL DEFAULT 'RETAIL'
                        CHECK (customer_type IN ('RETAIL', 'WHOLESALE', 'INSTITUTIONAL')),
    contact_person  text,
    phone           text,
    email           citext,
    address         text,
    plant_id        uuid, -- home/serving plant, nullable (a prospect may not be assigned yet)
    customer_status text NOT NULL DEFAULT 'PROSPECT'
                        CHECK (customer_status IN ('PROSPECT', 'ACTIVE', 'INACTIVE')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, customer_id),
    UNIQUE (tenant_id, customer_code),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE opportunities (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    opportunity_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    customer_id         uuid NOT NULL,
    opportunity_name    text NOT NULL,
    stage               text NOT NULL DEFAULT 'NEW'
                            CHECK (stage IN ('NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST')),
    estimated_value     numeric(14,2),
    expected_close_date date,
    owner_user_id       uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, opportunity_id),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id)
);

-- The offline-capturable surface for this module — a field sales rep
-- logging a call/visit/note against a customer, same pattern as every
-- other module's field-facing capture (SDD §2.1).
CREATE TABLE activities (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    activity_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    customer_id     uuid NOT NULL,
    activity_type   text NOT NULL CHECK (activity_type IN ('CALL', 'VISIT', 'EMAIL', 'NOTE')),
    notes           text,
    activity_date   timestamptz NOT NULL DEFAULT now(),
    created_by_user_id uuid,
    client_event_id uuid NOT NULL,
    device_id       uuid,
    created_offline boolean NOT NULL DEFAULT false,
    sync_seq        bigserial,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, activity_id),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id)
);

CREATE INDEX idx_activities_sync ON activities (tenant_id, sync_seq);
CREATE INDEX idx_opportunities_customer ON opportunities (tenant_id, customer_id);

-- Integration point (per direction confirmed for this build): sales_orders
-- gets a nullable customer_id rather than a redesign of the Sales module's
-- agent-capital financial gate, which is unchanged. NULL means "no CRM
-- customer recorded for this order" — every order created before this
-- migration, and any created afterward without a customer_id, stays valid.
ALTER TABLE sales_orders ADD COLUMN customer_id uuid;
ALTER TABLE sales_orders ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id);
