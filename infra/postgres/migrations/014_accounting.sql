-- Accounting module (docs/SDD.md's Unified Ledger, extended into a real
-- "Zoho Books/QuickBooks equivalent" layer) — NOT one of the original 15
-- PRD modules, added as a platform extension alongside CRM.
--
-- IMPORTANT — what this module is and isn't: journal_entries/journal_lines
-- (migration 005) already ARE the platform's double-entry GL, populated by
-- ledger-service for every module since Vertical Slice #1. This migration
-- does NOT create a second, competing ledger. It adds the layer that was
-- genuinely missing: trackable Vendor Bills and Customer Invoices with due
-- dates and payment status (right now grn.posted.v1 and
-- sales.order_fulfilled.v1 post straight to GL accounts with no bill/
-- invoice record behind them at all), plus manual journal entries for
-- adjustments that have no automated trigger. accounting-service reads and
-- writes the SAME journal_entries/journal_lines tables ledger-service
-- already owns — see 015_accounting_rls_and_role.sql for why that's safe.

-- One bill per Goods Receipt (aggregating across a GRN's lines, since
-- grn.posted.v1 fires per line but a real vendor bill is per delivery/PO,
-- not per line item), auto-created by accounting-service consuming that
-- same Kafka event ledger-service already consumes (a second, independent
-- consumer group on the same topic — no change needed in procurement-service).
CREATE TABLE vendor_bills (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    bill_id         uuid NOT NULL DEFAULT gen_random_uuid(),
    bill_number     text NOT NULL,
    supplier_id     uuid NOT NULL,
    plant_id        uuid NOT NULL,
    grn_id          uuid NOT NULL, -- aggregation key: one bill per GRN
    bill_date       date NOT NULL DEFAULT current_date,
    due_date        date NOT NULL,
    total_amount    numeric(14,2) NOT NULL DEFAULT 0,
    amount_paid     numeric(14,2) NOT NULL DEFAULT 0,
    bill_status     text NOT NULL DEFAULT 'OPEN'
                        CHECK (bill_status IN ('OPEN', 'PARTIALLY_PAID', 'PAID')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, bill_id),
    UNIQUE (tenant_id, bill_number),
    UNIQUE (tenant_id, grn_id),
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, supplier_id),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE vendor_bill_lines (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    bill_line_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    bill_id         uuid NOT NULL,
    source_event_id uuid NOT NULL, -- the grn.posted.v1 event_id (= grn_line_id) this line came from
    line_value      numeric(14,2) NOT NULL,
    PRIMARY KEY (tenant_id, bill_line_id),
    UNIQUE (tenant_id, source_event_id), -- idempotency: a re-delivered Kafka event can't double-add a line
    FOREIGN KEY (tenant_id, bill_id) REFERENCES vendor_bills(tenant_id, bill_id)
);

CREATE TABLE vendor_bill_payments (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    payment_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    bill_id         uuid NOT NULL,
    payment_date    timestamptz NOT NULL DEFAULT now(),
    amount          numeric(14,2) NOT NULL,
    payment_method  text NOT NULL DEFAULT 'BANK_TRANSFER',
    reference_no    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, payment_id),
    FOREIGN KEY (tenant_id, bill_id) REFERENCES vendor_bills(tenant_id, bill_id)
);

-- One invoice per Sales Order, but ONLY for orders with a CRM customer_id
-- (migration 012) — an order with no customer_id has no AR paperwork to
-- generate, only its existing Agent Wallet posting (unchanged).
CREATE TABLE customer_invoices (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    invoice_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    invoice_number  text NOT NULL,
    customer_id     uuid NOT NULL,
    sales_order_id  uuid NOT NULL,
    plant_id        uuid NOT NULL,
    invoice_date    date NOT NULL DEFAULT current_date,
    due_date        date NOT NULL,
    total_amount    numeric(14,2) NOT NULL,
    amount_paid     numeric(14,2) NOT NULL DEFAULT 0,
    invoice_status  text NOT NULL DEFAULT 'OPEN'
                        CHECK (invoice_status IN ('OPEN', 'PARTIALLY_PAID', 'PAID')),
    source_event_id uuid NOT NULL, -- the sales.order_fulfilled.v1 event_id (idempotency)
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, invoice_id),
    UNIQUE (tenant_id, invoice_number),
    UNIQUE (tenant_id, sales_order_id),
    UNIQUE (tenant_id, source_event_id),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

-- IMPORTANT design note (a genuine open question, not silently resolved):
-- recording payment against a customer invoice credits the SAME GL account
-- (1210, "Agent Wallet / Trading Capital Receivable") that NCR verification
-- (Sales module) also credits — both are legitimate ways an amount owed
-- against a sales order gets resolved (an agent remits cash in bulk via
-- NCR; a directly-invoiced customer pays a specific invoice). This module
-- does NOT reconcile the two into one unified AR workflow — an order with
-- both an agent AND a customer_id could, in principle, have its exposure
-- reduced from either direction with no cross-check between them. Flagged
-- in README "Known gaps"; would need real business rules (does a customer-
-- invoiced order participate in agent capital at all, or are the two
-- channels mutually exclusive per order?) that aren't specified anywhere
-- in the original PRD, which predates the CRM/customer concept entirely.
CREATE TABLE customer_invoice_payments (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    payment_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    invoice_id      uuid NOT NULL,
    payment_date    timestamptz NOT NULL DEFAULT now(),
    amount          numeric(14,2) NOT NULL,
    payment_method  text NOT NULL DEFAULT 'BANK_TRANSFER',
    reference_no    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, payment_id),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES customer_invoices(tenant_id, invoice_id)
);

CREATE INDEX idx_vendor_bills_grn ON vendor_bills (tenant_id, grn_id);
CREATE INDEX idx_customer_invoices_order ON customer_invoices (tenant_id, sales_order_id);

-- Posting rules (new financial triggers this module introduces):
--   accounting.bill_paid.v1              -> Dr Accounts Payable (2110) / Cr Cash and Bank (1100)
--   accounting.invoice_payment_received.v1 -> Dr Cash and Bank (1100) / Cr Agent Wallet (1210)
INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
SELECT tenant_id, 'accounting.bill_paid.v1', '2110', '1100', 'payment_amount' FROM tenant_registry
UNION ALL
SELECT tenant_id, 'accounting.invoice_payment_received.v1', '1100', '1210', 'payment_amount' FROM tenant_registry;
