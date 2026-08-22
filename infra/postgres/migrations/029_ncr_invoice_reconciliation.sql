-- Reconciles the NCR-verification / invoice-payment overlap flagged in
-- migration 014's own header comment: both credited the SAME GL account
-- (1210, Agent Wallet / Trading Capital Receivable) with no link between
-- them, and — the more damaging half of the bug — a customer-invoiced
-- order's exposure NEVER left trading_capital_ledger unless the agent
-- separately filed an NCR covering it, since invoice payment never
-- touched that sub-ledger at all. A fully-paid customer invoice could
-- leave an agent permanently unable to place new orders.
--
-- Resolution (explicit product decision, not a default assumption): a
-- customer-invoiced order is a fundamentally different transaction from
-- an agent taking goods to sell on trading capital — the credit risk
-- belongs to the company's direct relationship with a known, CRM-tracked
-- customer (customer_invoices, its own due date), not to the agent. Such
-- orders now bypass agent trading capital ENTIRELY (see
-- sales.service.ts) and post to a dedicated receivable instead, so NCR
-- and invoice payment never touch the same account again.
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type)
SELECT tenant_id, '1220', 'Accounts Receivable — Customers', 'ASSET' FROM tenant_registry;

-- New event type for customer-invoiced ("direct") order fulfillment —
-- same pattern Manufacturing already established for "same trigger,
-- different GL treatment" (batch.yield_variance_favorable.v1 /
-- _unfavorable.v1) rather than posting_rules.condition_expression, which
-- has never been implemented anywhere in this platform.
INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
SELECT tenant_id, 'sales.order_fulfilled_direct.v1', '1220', '4000', 'order_value' FROM tenant_registry;

-- accounting.invoice_payment_received.v1 must now resolve the NEW
-- receivable (1220), not the Agent Wallet (1210) it originally did —
-- deactivated, not deleted or UPDATEd in place: posting_rules has no
-- unique constraint on (tenant_id, event_type) precisely so a rule can
-- be superseded this way (is_active exists for exactly this), and
-- ledger-service's loadPostingRule already filters on is_active = true.
-- This is forward-looking only — journal_lines already posted under the
-- old mapping are untouched, same "don't rewrite history" treatment
-- migration 022 gave journal_entries.status.
UPDATE posting_rules SET is_active = false
WHERE event_type = 'accounting.invoice_payment_received.v1' AND is_active = true;

INSERT INTO posting_rules (tenant_id, event_type, debit_account_code, credit_account_code, amount_expression)
SELECT tenant_id, 'accounting.invoice_payment_received.v1', '1100', '1220', 'payment_amount' FROM tenant_registry;
