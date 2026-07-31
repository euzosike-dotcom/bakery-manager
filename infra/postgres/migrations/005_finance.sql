-- Unified Ledger (SDD §4.1) — the platform's own system-of-record for
-- financial truth, independent of any external accounting product.

CREATE TABLE chart_of_accounts (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    account_code        text NOT NULL,
    account_name        text NOT NULL,
    account_type        text NOT NULL
                            CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    parent_account_code text,
    is_active           boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, account_code)
);

-- Configurable event -> journal mapping (SDD §3 preamble). One row per
-- event_type per tenant; amount_expression/condition_expression are simple
-- dot-path expressions evaluated by the ledger service against the event
-- payload (kept intentionally simple for this slice; a full expression
-- language is a later hardening step, not required to prove the pattern).
CREATE TABLE posting_rules (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    posting_rule_id         uuid NOT NULL DEFAULT gen_random_uuid(),
    event_type              text NOT NULL,
    debit_account_code      text NOT NULL,
    credit_account_code     text NOT NULL,
    amount_expression        text NOT NULL,
    condition_expression     text,
    is_active                boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, posting_rule_id),
    FOREIGN KEY (tenant_id, debit_account_code) REFERENCES chart_of_accounts(tenant_id, account_code),
    FOREIGN KEY (tenant_id, credit_account_code) REFERENCES chart_of_accounts(tenant_id, account_code)
);

CREATE TABLE journal_entries (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    journal_entry_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    source_event_id     uuid NOT NULL,
    source_module       text NOT NULL,
    posting_date        timestamptz NOT NULL DEFAULT now(),
    status              text NOT NULL DEFAULT 'POSTED'
                            CHECK (status IN ('POSTED', 'REVERSED')),
    memo                 text,
    PRIMARY KEY (tenant_id, journal_entry_id),
    -- The event that caused this posting can only ever post once (idempotency
    -- for the ledger service, mirroring the outbox idempotency on the client).
    UNIQUE (tenant_id, source_event_id)
);

CREATE TABLE journal_lines (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    journal_line_id     uuid NOT NULL DEFAULT gen_random_uuid(),
    journal_entry_id    uuid NOT NULL,
    account_code        text NOT NULL,
    debit_amount        numeric(14,2) NOT NULL DEFAULT 0,
    credit_amount       numeric(14,2) NOT NULL DEFAULT 0,
    cost_center_plant_id uuid,
    PRIMARY KEY (tenant_id, journal_line_id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, journal_entry_id),
    FOREIGN KEY (tenant_id, account_code) REFERENCES chart_of_accounts(tenant_id, account_code),
    CONSTRAINT one_sided_line CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (credit_amount > 0 AND debit_amount = 0)
    )
);

-- Journal entries/lines are append-only once posted — corrections are a new
-- reversing entry, never an UPDATE (SDD §4.2).
CREATE RULE journal_lines_no_update AS ON UPDATE TO journal_lines DO INSTEAD NOTHING;
CREATE RULE journal_lines_no_delete AS ON DELETE TO journal_lines DO INSTEAD NOTHING;

-- Outbound sync from journal_entries to the tenant's configured external
-- finance system (Zoho Books / QuickBooks / etc). Extends the table already
-- present in Metrock's existing schema register with tenant_id + external_system.
CREATE TABLE integration_queue (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    queue_id            uuid NOT NULL DEFAULT gen_random_uuid(),
    external_system      text NOT NULL DEFAULT 'NONE',
    source_module        text NOT NULL,
    source_record_id      text NOT NULL,
    transaction_type      text NOT NULL,
    payload_json          jsonb NOT NULL,
    queue_status          text NOT NULL DEFAULT 'PENDING'
                            CHECK (queue_status IN ('PENDING', 'POSTED', 'FAILED')),
    retry_count           int NOT NULL DEFAULT 0,
    last_error_message    text,
    posted_external_id    text,
    queued_time           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, queue_id)
);

CREATE TABLE failed_posting_review (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    review_id       uuid NOT NULL DEFAULT gen_random_uuid(),
    queue_id        uuid NOT NULL,
    source_record_id text NOT NULL,
    error_message    text NOT NULL,
    review_status    text NOT NULL DEFAULT 'OPEN' CHECK (review_status IN ('OPEN', 'RESOLVED')),
    reviewed_by      uuid,
    reviewed_time    timestamptz,
    PRIMARY KEY (tenant_id, review_id),
    FOREIGN KEY (tenant_id, queue_id) REFERENCES integration_queue(tenant_id, queue_id)
);
