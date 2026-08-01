-- Sales & Agent Capital Governance module (docs/SDD.md §3.D)
--
-- The centerpiece rule from the original PRD/Zoho proposal: "If Order
-- Volume > Available Capital -> Block Transaction". Available capital is
-- NEVER stored as a running-balance column trusted from any cache — it is
-- always computed live from trading_capital_ledger (SUM(debit) - SUM(credit))
-- against agent_master.approved_trading_capital, exactly as SDD §2.3
-- Conflict Matrix scenario #2 specifies ("running_balance is never trusted
-- from the client and is recomputed server-side"). See
-- sales-service/src/agents/agents.service.ts for the query.

CREATE TABLE agent_master (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    agent_id                uuid NOT NULL DEFAULT gen_random_uuid(),
    agent_code              text NOT NULL,
    agent_name              text NOT NULL,
    agent_type              text NOT NULL DEFAULT 'FIELD_AGENT',
    plant_id                uuid NOT NULL,
    agent_status            text NOT NULL DEFAULT 'ACTIVE',
    approved_trading_capital numeric(14,2) NOT NULL,
    capital_cap             numeric(14,2),
    base_discount_percent   numeric(5,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, agent_id),
    UNIQUE (tenant_id, agent_code),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

-- Append-only wallet ledger. Two entry types only, matching the two
-- financial triggers below: DEBIT_EXPOSURE (order fulfilled, consumes
-- capital) and CREDIT_RECOVERY (NCR verified, restores capital).
CREATE TABLE trading_capital_ledger (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    tcl_entry_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    entry_datetime  timestamptz NOT NULL DEFAULT now(),
    agent_id        uuid NOT NULL,
    entry_type      text NOT NULL CHECK (entry_type IN ('DEBIT_EXPOSURE', 'CREDIT_RECOVERY')),
    reference_no    text NOT NULL, -- order_number or ncr reference
    debit_value     numeric(14,2) NOT NULL DEFAULT 0,
    credit_value    numeric(14,2) NOT NULL DEFAULT 0,
    notes           text,
    PRIMARY KEY (tenant_id, tcl_entry_id),
    FOREIGN KEY (tenant_id, agent_id) REFERENCES agent_master(tenant_id, agent_id),
    CONSTRAINT one_sided_ledger_entry CHECK (
        (debit_value > 0 AND credit_value = 0) OR (credit_value > 0 AND debit_value = 0)
    )
);

-- Append-only: corrections are a new reversing entry, never an UPDATE —
-- same rule as journal_lines (migration 005) and audit_log (migration 003).
CREATE RULE trading_capital_ledger_no_update AS ON UPDATE TO trading_capital_ledger DO INSTEAD NOTHING;
CREATE RULE trading_capital_ledger_no_delete AS ON DELETE TO trading_capital_ledger DO INSTEAD NOTHING;

-- sales_orders / order_lines are the primary offline-sync surface for this
-- module (field agent capturing an order), same idempotency pattern as
-- goods_receipts (migration 004) and production_batches (migration 008).
CREATE TABLE sales_orders (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    sales_order_id          uuid NOT NULL DEFAULT gen_random_uuid(),
    order_number            text NOT NULL,
    agent_id                uuid NOT NULL,
    plant_id                uuid NOT NULL,
    order_date              timestamptz NOT NULL DEFAULT now(),
    total_order_value       numeric(14,2) NOT NULL,
    order_status            text NOT NULL DEFAULT 'CONFIRMED'
                                CHECK (order_status IN ('CONFIRMED', 'NEEDS_REVIEW', 'CANCELLED')),
    -- SDD §2.3 scenario #7: an offline-captured order carries a provisional
    -- status until the server re-validates capital at sync time — never
    -- silently auto-approved on a stale client-side check alone.
    credit_eligibility_status text NOT NULL DEFAULT 'PENDING_SYNC_VALIDATION'
                                CHECK (credit_eligibility_status IN ('PENDING_SYNC_VALIDATION', 'APPROVED', 'BLOCKED')),
    client_event_id         uuid NOT NULL,
    device_id               uuid,
    created_offline         boolean NOT NULL DEFAULT false,
    sync_seq                bigserial,
    created_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, sales_order_id),
    UNIQUE (tenant_id, order_number),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, agent_id) REFERENCES agent_master(tenant_id, agent_id),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE order_lines (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    order_line_id   uuid NOT NULL DEFAULT gen_random_uuid(),
    sales_order_id  uuid NOT NULL,
    sku_id          uuid NOT NULL, -- references product_skus (migration 008) — reused across modules
    ordered_qty     numeric(14,3) NOT NULL,
    unit_price      numeric(14,2) NOT NULL,
    line_value      numeric(14,2) GENERATED ALWAYS AS (ordered_qty * unit_price) STORED,
    PRIMARY KEY (tenant_id, order_line_id),
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, sales_order_id),
    FOREIGN KEY (tenant_id, sku_id) REFERENCES product_skus(tenant_id, sku_id)
);

-- NCR (cash collected from the market and returned to the company). Agent-
-- submitted, offline-capturable, but verified_flag only ever flips to true
-- via a separate ONLINE-ONLY back-office action (finance confirms the cash
-- actually reached the bank) — unverified NCR must never restore capital.
CREATE TABLE ncr_collections (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    ncr_id              uuid NOT NULL DEFAULT gen_random_uuid(),
    ncr_reference       text NOT NULL,
    agent_id            uuid NOT NULL,
    collection_date     timestamptz NOT NULL DEFAULT now(),
    amount              numeric(14,2) NOT NULL,
    verified_flag       boolean NOT NULL DEFAULT false,
    verified_by         uuid,
    verified_at         timestamptz,
    client_event_id     uuid NOT NULL,
    device_id           uuid,
    created_offline      boolean NOT NULL DEFAULT false,
    sync_seq            bigserial,
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, ncr_id),
    UNIQUE (tenant_id, ncr_reference),
    UNIQUE (tenant_id, client_event_id),
    FOREIGN KEY (tenant_id, agent_id) REFERENCES agent_master(tenant_id, agent_id)
);

CREATE INDEX idx_sales_orders_sync ON sales_orders (tenant_id, sync_seq);
CREATE INDEX idx_ncr_collections_sync ON ncr_collections (tenant_id, sync_seq);
CREATE INDEX idx_trading_capital_ledger_agent ON trading_capital_ledger (tenant_id, agent_id);

-- Chart of accounts for Sales & Agent Capital postings (SDD §3.D):
--   "Agent Wallet Ledger" in the SDD's worked example is a GL receivable-
--   type account representing trading capital extended to agents — not to
--   be confused with trading_capital_ledger, which is the operational
--   sub-ledger driving the capital-eligibility check. Both exist: the
--   sub-ledger gates orders in real time, the GL account is what the
--   sub-ledger's postings ultimately land in.
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type)
SELECT tenant_id, '1100', 'Cash and Bank', 'ASSET' FROM tenant_registry
UNION ALL
SELECT tenant_id, '1210', 'Agent Wallet / Trading Capital Receivable', 'ASSET' FROM tenant_registry
UNION ALL
SELECT tenant_id, '4000', 'Sales Revenue', 'REVENUE' FROM tenant_registry;

-- Posting rules (SDD §3.D Financial Trigger):
--   sales.order_fulfilled.v1 -> Dr Agent Wallet Ledger / Cr Sales Revenue
--   ncr.verified.v1          -> Dr Cash and Bank / Cr Agent Wallet Ledger
INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
SELECT tenant_id, 'sales.order_fulfilled.v1', '1210', '4000', 'order_value' FROM tenant_registry
UNION ALL
SELECT tenant_id, 'ncr.verified.v1', '1100', '1210', 'ncr_amount' FROM tenant_registry;
