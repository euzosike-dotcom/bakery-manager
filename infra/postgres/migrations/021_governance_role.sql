-- Governance & Master Data module (docs/SDD.md §3.A) — the sixth and
-- final of the original 15 PRD/FRS modules. Unlike every other module,
-- most of its schema already existed from Slice #1 (002_tenant_registry.sql,
-- 003_governance.sql): every other service has been reading `plants`,
-- `warehouses`, `roles`, `users` as cross-module master data since day
-- one. What this slice adds is the missing piece — an actual OWNING
-- service for that data, plus the two mechanisms the SDD specifically
-- calls for and nothing had implemented yet: hash-chained tamper-evident
-- audit logging (§4.2), and posting-authority enforcement with a
-- mandatory audit trail + alert on any bypass attempt (§4.2's
-- "Governance warning").
--
-- No new financial GL accounts or posting_rules — SDD §3.A is explicit:
-- "Financial Trigger: None directly — this module supplies the control
-- plane... consumed by every financially-triggering module." No Kafka
-- producer, no ledger-service extension, no Flutter offline-capture
-- surface either — SDD §3.A's Offline Strategy is equally explicit that
-- governance master data is "pull-only, read-cached... never edited
-- offline," a deliberate simplification since this data changes rarely
-- and its correctness is safety-critical.

-- `audit_log` (003_governance.sql) already has `prev_hash`/`record_hash`
-- columns but nothing has ever written to it (0 rows) — the hash chain
-- was never actually implemented. A deterministic per-insert ordering is
-- needed to know which row is "previous" when computing a new row's
-- prev_hash and when walking the chain to verify it; `event_time` alone
-- isn't safe for this (two inserts in the same transaction/millisecond
-- would tie). Safe to add now precisely because the table is empty.
ALTER TABLE audit_log ADD COLUMN chain_seq bigserial;
CREATE INDEX idx_audit_log_chain_seq ON audit_log (tenant_id, chain_seq);

-- Least-privilege role for governance-service, same rationale as every
-- prior module's *_svc role — see 007_app_role.sql for the full
-- explanation of why the bootstrap `metrock` superuser must never be
-- what a request-serving domain service connects as.
-- Password from :'governance_svc_password' — see 007_app_role.sql's
-- comment for why, and docs/RUNBOOK.md's "Secrets in production".
\if :{?governance_svc_password}
\else
  \set governance_svc_password 'governance_svc_dev_password'
\endif
CREATE ROLE governance_svc WITH LOGIN PASSWORD :'governance_svc_password';

GRANT CONNECT ON DATABASE metrock_erp TO governance_svc;
GRANT USAGE ON SCHEMA public TO governance_svc;

-- Tenant provisioning itself is out of scope for this slice (tenants are
-- seeded directly, same as every environment so far) — read-only.
GRANT SELECT ON tenant_registry TO governance_svc;

GRANT SELECT, INSERT, UPDATE ON
    plants, warehouses, roles, users, approval_matrix, reason_codes
    TO governance_svc;

-- audit_log: SELECT + INSERT only — no UPDATE grant at all, on top of
-- the append-only RULEs from 003_governance.sql (`audit_log_no_update`/
-- `audit_log_no_delete`). Belt-and-suspenders deliberately: the RULE
-- already turns any UPDATE/DELETE into a no-op regardless of role, but
-- not even holding the privilege is a stronger, defense-in-depth
-- statement about what this service is allowed to do to its own audit
-- trail.
GRANT SELECT, INSERT ON audit_log TO governance_svc;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO governance_svc;

-- Cross-tenant leakage smoke test (docs/RUNBOOK.md pattern):
--   docker compose exec postgres psql -U governance_svc -d metrock_erp -c "
--     SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM users;"
--   -> must be 0
