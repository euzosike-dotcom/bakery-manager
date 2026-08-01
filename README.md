# Metrock ERP Platform

Multi-tenant, offline-first ERP platform for food manufacturing enterprises.
Metrock Enterprises is Tenant Zero. Full architecture: see
[`docs/SDD.md`](docs/SDD.md) (copied from the System Design Documentation).

## Status: Two modules verified end-to-end — Procurement GRN, Manufacturing/Yield

This repo implements **two modules end-to-end**, each proving the
architecture before scaling out to the remaining four (Sales & Agent
Capital, Logistics/Fleet, HR/Payroll, Governance):

```
Flutter (offline capture: GRN / production batch)
   -> Drift local DB + outbox_events
   -> Sync Gateway (NestJS domain service: /sync/push, /sync/pull)
   -> Postgres (tenant-partitioned, RLS)
   -> Kafka/Redpanda event
   -> Go ledger-service
   -> journal_entries / journal_lines (double-entry posting)
```

| Module | Domain service | Port | Events -> Ledger posting |
|---|---|---|---|
| Procurement & Stores | `backend/procurement-service` | 3001 | `grn.posted.v1` -> Dr Raw Material Inventory / Cr Accounts Payable |
| Manufacturing & Yield | `backend/manufacturing-service` | 3002 | `batch.consumption_recorded.v1` -> Dr WIP / Cr Raw Material Inventory; `batch.output_recorded.v1` -> Dr Finished Goods / Cr WIP; `batch.yield_variance_(un)favorable.v1` -> WIP <-> Manufacturing Variance Expense |

Both domain services share the exact same pattern: tenant-context
middleware + Prisma helper (currently duplicated per service, see "Known
gaps" below), a direct/online REST endpoint, a `/sync/push` +
`/sync/pull` gateway with idempotency on `client_event_id`, and a
least-privilege Postgres role (`procurement_svc`, `manufacturing_svc`) so
RLS is a real backstop, not a no-op. Once this pattern is proven twice, the
remaining four modules are mechanical repetition of it.

## Repo layout

```
backend/
  procurement-service/   # NestJS: Suppliers, PR, PO, GRN, Sync Gateway
  manufacturing-service/ # NestJS: Recipes, Production Batch close, Sync Gateway
  ledger-service/        # Go: Kafka consumer, double-entry posting engine (both modules)
infra/
  postgres/migrations/   # SQL migrations, RLS policies
  docker-compose.yml     # Postgres, Redpanda, Redis, MinIO for local dev
apps/
  mobile/                # Flutter: offline-first GRN + batch capture client
packages/
  contracts/             # Shared event/DTO contracts (JSON Schema)
docs/
  SDD.md                 # Full system design documentation
  RUNBOOK.md             # Verified bring-up + verification trail for both modules
```

## Running locally

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for step-by-step setup.

## Known gaps (intentionally out of scope for now)

- **Auth**: Keycloak is specified in the SDD but not wired yet. A stub
  `x-tenant-id` / `x-user-role` header middleware stands in for real OIDC
  tokens. Replacing the stub with real Keycloak JWT validation is the next
  hardening step before this touches production data.
- **Finance connector** (Zoho Books / QuickBooks): `integration_queue` rows
  are written by the ledger service but nothing consumes them yet — the
  actual outbound connector is a separate build.
- **Multi-tenancy isolation tiers**: only the "Pool" tier (shared schema +
  RLS) is implemented. Schema-per-tenant ("Bridge") and database-per-tenant
  ("Silo") provisioning are not built yet.
- **No API Gateway yet**: the Flutter client talks to each domain service's
  base URL directly (hardcoded per module in `main.dart`), and
  `core/sync/sync_service.dart` routes outbox events to the right service
  client-side (`SyncModule` enum + a small routing table). This was fine at
  one module, tolerable at two; it will not scale cleanly to six — a real
  API Gateway consolidating tenant resolution and per-module routing (as
  the SDD's architecture diagram already calls for) is the right next
  infrastructure investment, not more per-module client routing tables.
- **Shared backend-common package doesn't exist yet**:
  `procurement-service` and `manufacturing-service` each have their own
  copy of `common/prisma.service.ts`, `common/tenant-context.middleware.ts`,
  `common/current-tenant.decorator.ts`, and a near-identical
  `kafka/kafka-producer.service.ts`. This is the single most
  correctness-sensitive piece of code in the platform (it's what makes RLS
  tenant isolation actually work) and it's currently duplicated. Tolerable
  at two services under active, deliberate parallel construction; extract
  a shared package before a third module copies it again.
- **Purchase Order / Recipe caching is incomplete**:
  `apps/mobile/lib/core/database/tables.dart` defines
  `PurchaseOrdersCache` / `PurchaseOrderLinesCache` for offline PO lookup,
  but `main.dart` only holds the fetched `/purchase-orders` and `/recipes`
  responses in memory — neither is persisted into local cache tables.
  Practical effect: a tablet needs connectivity at least once to open a
  given PO or recipe before capture; only the GRN/batch capture itself
  (once opened) works fully offline. Wiring the fetch-then-cache step is
  the natural next task for both.
- **`posting_rules.condition_expression`** exists as a column but is never
  evaluated (SDD §3 preamble) — every posting rule so far has been
  unconditional. The Manufacturing module's variance handling worked around
  needing conditional logic by using two event types (favorable/
  unfavorable) instead; a module that genuinely needs conditional posting
  logic will need this implemented for real.
