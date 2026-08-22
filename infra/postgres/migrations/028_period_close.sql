-- Closes the "no period-close / retained-earnings roll-forward" gap
-- (reports.service.ts's own class doc comment: "a real GL would zero P&L
-- accounts into an equity Retained Earnings balance at period end").
-- Balance Sheet's totalAssets differs from totalLiabilities +
-- totalEquity by exactly the unclosed net income whenever REVENUE/
-- EXPENSE activity hasn't been folded into EQUITY yet — this adds the
-- account those balances close INTO. Nothing in the chart of accounts
-- has ever used the EQUITY account_type before this (checked: no prior
-- migration or seed file inserts one), despite the CHECK constraint
-- allowing it since migration 005.
INSERT INTO chart_of_accounts (tenant_id, account_code, account_name, account_type)
SELECT tenant_id, '3100', 'Retained Earnings', 'EQUITY' FROM tenant_registry;
