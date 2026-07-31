# Metrock ERP Platform

Multi-tenant, offline-first ERP platform for food manufacturing enterprises.
Metrock Enterprises is Tenant Zero. Full architecture: see
[`docs/SDD.md`](docs/SDD.md) (copied from the System Design Documentation).

## Status: Vertical Slice #1 — Procurement GRN

This repo currently implements **one module end-to-end** to prove the
architecture before scaling out to the other five (Manufacturing, Sales &
Agent Capital, Logistics/Fleet, HR/Payroll, Governance):

```
Flutter (offline GRN capture)
   -> Drift local DB + outbox_events
   -> Sync Gateway (NestJS procurement-service: /sync/push, /sync/pull)
   -> Postgres (tenant-partitioned, RLS)
   -> Kafka/Redpanda event (grn.posted.v1)
   -> Go ledger-service
   -> journal_entries / journal_lines (double-entry posting)
```

Once this slice is verified, every other module follows the same repeatable
pattern: domain service + event contract + posting rule + client screen.

## Repo layout

```
backend/
  procurement-service/   # NestJS: Suppliers, PR, PO, GRN, Sync Gateway
  ledger-service/        # Go: Kafka consumer, double-entry posting engine
infra/
  postgres/migrations/   # SQL migrations, RLS policies
  docker-compose.yml     # Postgres, Redpanda, Redis, MinIO for local dev
apps/
  mobile/                # Flutter: offline-first GRN capture client
packages/
  contracts/             # Shared event/DTO contracts (JSON Schema + generated types)
docs/
  SDD.md                 # Full system design documentation
```

## Running locally

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for step-by-step setup.

## Known gaps in this slice (intentionally out of scope for now)

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
- **Purchase Order caching is incomplete**: `apps/mobile/lib/core/database/tables.dart`
  defines `PurchaseOrdersCache` / `PurchaseOrderLinesCache` for offline PO
  lookup, but `main.dart` currently only holds the fetched `/purchase-orders`
  response in memory — it never persists it into those tables. Practical
  effect: a tablet needs connectivity at least once to open a given PO for
  GRN capture; only the GRN itself (once opened) can be captured fully
  offline. Wiring the fetch-then-cache step is the natural next task.
