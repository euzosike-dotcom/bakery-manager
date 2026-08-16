-- The bootstrap POSTGRES_USER role (`metrock`) is a Postgres SUPERUSER —
-- that's just how the official postgres image's initdb works. Superusers
-- bypass Row-Level Security unconditionally, regardless of FORCE ROW LEVEL
-- SECURITY (that flag only affects non-superuser table owners). Running the
-- application through the superuser role would silently defeat the RLS
-- backstop described in docs/SDD.md §1.2 ("three layers of isolation") —
-- the app-layer tenant filter and the gateway check would be the only two
-- layers actually doing anything.
--
-- procurement-service (and any future request-serving domain service) MUST
-- connect as this least-privilege, non-superuser, non-owner role instead so
-- RLS is a real backstop, not a no-op. ledger-service intentionally keeps
-- using the superuser/migration role — see the doc comment on
-- internal/db/pool.go for why that's an accepted, explicit tradeoff for a
-- trusted internal batch consumer, not an oversight.

-- Password comes from psql's :'procurement_svc_password' variable, not a
-- literal — set it with -v on the command line for a real deployment
-- (docs/RUNBOOK.md's "Secrets in production" section) to avoid ever
-- committing a real credential to this file. \if/\else below supplies
-- the same well-known dev default as before when nothing overrides it,
-- so local dev and CI need zero changes.
\if :{?procurement_svc_password}
\else
  \set procurement_svc_password 'procurement_svc_dev_password'
\endif
CREATE ROLE procurement_svc WITH LOGIN PASSWORD :'procurement_svc_password';

GRANT CONNECT ON DATABASE metrock_erp TO procurement_svc;
GRANT USAGE ON SCHEMA public TO procurement_svc;

-- Scoped to exactly what procurement-service's Prisma models touch today
-- (docs/RUNBOOK.md's smoke tests exercise this same set). Extend this list
-- as new modules add their own domain service + role, rather than widening
-- this one.
GRANT SELECT, INSERT, UPDATE ON
    plants, warehouses, suppliers,
    purchase_requests, purchase_request_lines,
    purchase_orders, purchase_order_lines,
    goods_receipts, goods_receipt_lines
    TO procurement_svc;

-- `goods_receipts.sync_seq` / `goods_receipt_lines.sync_seq` are bigserial
-- columns, i.e. an `integer NOT NULL DEFAULT nextval('..._seq')` column
-- backed by an implicit sequence. Table-level INSERT privilege is NOT
-- enough to satisfy that default expression — Postgres separately checks
-- USAGE on the sequence itself, and without it every INSERT into either
-- table fails at runtime with "permission denied for sequence ..._seq",
-- not at grant time, so this is easy to miss until the first real write.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO procurement_svc;

-- Being a non-superuser, non-owner role is what actually makes RLS apply —
-- FORCE is irrelevant for this role, but leaving it set is correct for when
-- ownership assumptions change later.
