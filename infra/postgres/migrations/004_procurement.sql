-- Supply Chain, Procurement & Stores module (SDD §3.B)

CREATE TABLE suppliers (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    supplier_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    supplier_code   text NOT NULL,
    supplier_name   text NOT NULL,
    supplier_type   text,
    contact_person  text,
    phone           text,
    email           citext,
    address         text,
    tax_id          text,
    payment_terms   text,
    rating_status   text,
    default_currency text NOT NULL DEFAULT 'NGN',
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, supplier_id),
    UNIQUE (tenant_id, supplier_code)
);

CREATE TABLE purchase_requests (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    pr_id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    pr_number               text NOT NULL,
    request_date            date NOT NULL DEFAULT current_date,
    requesting_department   text,
    plant_id                uuid NOT NULL,
    requested_by            uuid,
    needed_by_date          date,
    priority                text NOT NULL DEFAULT 'NORMAL',
    request_status          text NOT NULL DEFAULT 'DRAFT',
    approval_status         text NOT NULL DEFAULT 'PENDING'
                                CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    total_estimated_value   numeric(14,2) NOT NULL DEFAULT 0,
    current_approval_stage  int NOT NULL DEFAULT 1,
    pending_approver_role_id uuid,
    reason_note             text,
    PRIMARY KEY (tenant_id, pr_id),
    UNIQUE (tenant_id, pr_number),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE purchase_request_lines (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    pr_line_id          uuid NOT NULL DEFAULT gen_random_uuid(),
    pr_id               uuid NOT NULL,
    sku_id              uuid,
    description         text NOT NULL,
    requested_qty       numeric(14,3) NOT NULL,
    uom                 text NOT NULL,
    estimated_unit_cost numeric(14,2) NOT NULL,
    estimated_line_value numeric(14,2) GENERATED ALWAYS AS (requested_qty * estimated_unit_cost) STORED,
    PRIMARY KEY (tenant_id, pr_line_id),
    FOREIGN KEY (tenant_id, pr_id) REFERENCES purchase_requests(tenant_id, pr_id)
);

CREATE TABLE purchase_orders (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    po_id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    po_number               text NOT NULL,
    supplier_id             uuid NOT NULL,
    plant_id                uuid NOT NULL,
    linked_pr_id            uuid,
    po_date                 date NOT NULL DEFAULT current_date,
    payment_terms           text,
    currency                text NOT NULL DEFAULT 'NGN',
    expected_delivery_date  date,
    approval_status         text NOT NULL DEFAULT 'PENDING'
                                CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    po_status               text NOT NULL DEFAULT 'OPEN'
                                CHECK (po_status IN ('OPEN', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED')),
    total_po_value          numeric(14,2) NOT NULL DEFAULT 0,
    current_approval_stage  int NOT NULL DEFAULT 1,
    pending_approver_role_id uuid,
    PRIMARY KEY (tenant_id, po_id),
    UNIQUE (tenant_id, po_number),
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, supplier_id),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id),
    FOREIGN KEY (tenant_id, linked_pr_id) REFERENCES purchase_requests(tenant_id, pr_id)
);

CREATE TABLE purchase_order_lines (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    po_line_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    po_id           uuid NOT NULL,
    sku_id          uuid,
    sku_description text NOT NULL,
    ordered_qty     numeric(14,3) NOT NULL,
    received_qty    numeric(14,3) NOT NULL DEFAULT 0,
    uom             text NOT NULL,
    unit_cost       numeric(14,2) NOT NULL,
    line_value      numeric(14,2) GENERATED ALWAYS AS (ordered_qty * unit_cost) STORED,
    line_status     text NOT NULL DEFAULT 'OPEN'
                        CHECK (line_status IN ('OPEN', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED')),
    PRIMARY KEY (tenant_id, po_line_id),
    FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders(tenant_id, po_id),
    -- Over-receipt is prevented at the DB layer as a hard invariant (Conflict Matrix #3):
    -- application logic also checks this before insert, but the constraint is the backstop.
    CONSTRAINT received_not_over_ordered CHECK (received_qty <= ordered_qty)
);

-- goods_receipts / goods_receipt_lines are the primary offline-sync surface
-- for this vertical slice. `client_event_id` is the idempotency key supplied
-- by the Flutter outbox (SDD §2.1) — the UNIQUE constraint is what makes
-- POST /sync/push safe to retry.
CREATE TABLE goods_receipts (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    grn_id              uuid NOT NULL DEFAULT gen_random_uuid(),
    grn_number          text NOT NULL,
    po_id               uuid NOT NULL,
    receipt_date        timestamptz NOT NULL DEFAULT now(),
    warehouse_id        uuid NOT NULL,
    receiver_user_id    uuid,
    qc_status           text NOT NULL DEFAULT 'PENDING',
    posting_status      text NOT NULL DEFAULT 'PENDING'
                            CHECK (posting_status IN ('PENDING', 'POSTED', 'NEEDS_REVIEW')),
    client_event_id     uuid NOT NULL,
    device_id           uuid,
    created_offline      boolean NOT NULL DEFAULT false,
    sync_seq            bigserial,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, grn_id),
    UNIQUE (tenant_id, grn_number),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders(tenant_id, po_id),
    FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, warehouse_id)
);

CREATE TABLE goods_receipt_lines (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    grn_line_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    grn_id          uuid NOT NULL,
    po_line_id      uuid NOT NULL,
    received_qty    numeric(14,3) NOT NULL,
    accepted_qty    numeric(14,3) NOT NULL,
    rejected_qty    numeric(14,3) NOT NULL DEFAULT 0,
    uom             text NOT NULL,
    unit_cost       numeric(14,2) NOT NULL,
    accepted_value  numeric(14,2) GENERATED ALWAYS AS (accepted_qty * unit_cost) STORED,
    rejected_value  numeric(14,2) GENERATED ALWAYS AS (rejected_qty * unit_cost) STORED,
    client_event_id uuid NOT NULL,
    sync_seq        bigserial,
    PRIMARY KEY (tenant_id, grn_line_id),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, grn_id) REFERENCES goods_receipts(tenant_id, grn_id),
    FOREIGN KEY (tenant_id, po_line_id) REFERENCES purchase_order_lines(tenant_id, po_line_id),
    CONSTRAINT accepted_plus_rejected_eq_received CHECK (accepted_qty + rejected_qty = received_qty)
);

CREATE INDEX idx_goods_receipts_sync ON goods_receipts (tenant_id, sync_seq);
CREATE INDEX idx_goods_receipt_lines_sync ON goods_receipt_lines (tenant_id, sync_seq);
