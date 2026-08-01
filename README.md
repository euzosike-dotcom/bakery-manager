# Metrock ERP Platform

Multi-tenant, offline-first ERP platform for food manufacturing enterprises.
Metrock Enterprises is Tenant Zero. Full architecture: see
[`docs/SDD.md`](docs/SDD.md) (copied from the System Design Documentation).

## Status: Three modules verified end-to-end — Procurement GRN, Manufacturing/Yield, Sales & Agent Capital

This repo implements **three modules end-to-end**, each proving the
architecture before scaling out to the remaining three (Logistics/Fleet,
HR/Payroll, Governance):

```
Flutter (offline capture: GRN / production batch / sales order / NCR)
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
| Sales & Agent Capital | `backend/sales-service` | 3003 | `sales.order_fulfilled.v1` -> Dr Agent Wallet/Trading Capital Receivable / Cr Sales Revenue; `ncr.verified.v1` -> Dr Cash and Bank / Cr Agent Wallet |

All three domain services share the exact same pattern: tenant-context
middleware + Kafka producer + Prisma tenant-scoping helper (extracted into
`packages/backend-common` once a third service needed them — see "Known
gaps" history below), a direct/online REST endpoint, a `/sync/push` +
`/sync/pull` gateway with idempotency on `client_event_id`, and a
least-privilege Postgres role (`procurement_svc`, `manufacturing_svc`,
`sales_svc`) so RLS is a real backstop, not a no-op. Sales & Agent Capital
additionally introduces the platform's first real-time business gate: an
order is blocked server-side, synchronously, if it would exceed an agent's
available trading capital (`trading_capital_ledger`, computed live, never
cached) — the centerpiece rule from the original PRD. Now that this pattern
is proven three times, the remaining three modules are largely mechanical
repetition of it.

## Repo layout

```
backend/
  procurement-service/   # NestJS: Suppliers, PR, PO, GRN, Sync Gateway
  manufacturing-service/ # NestJS: Recipes, Production Batch close, Sync Gateway
  sales-service/         # NestJS: Agents/capital status, Sales Orders (capital-gated), NCR, Sync Gateway
  ledger-service/        # Go: Kafka consumer, double-entry posting engine (all three modules)
packages/
  backend-common/        # Shared tenant-context middleware, Kafka producer, Prisma tenant-scoping helper
  contracts/             # Shared event/DTO contracts (JSON Schema)
infra/
  postgres/migrations/   # SQL migrations, RLS policies
  docker-compose.yml     # Postgres, Redpanda, Redis, MinIO for local dev
apps/
  mobile/                # Flutter: offline-first GRN + batch + sales order/NCR capture client
docs/
  SDD.md                 # Full system design documentation
  RUNBOOK.md             # Verified bring-up + verification trail for all three modules
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
  client-side (`SyncModule` enum + a small routing table). Fine at three
  services, will not scale cleanly to six — a real API Gateway
  consolidating tenant resolution and per-module routing (as the SDD's
  architecture diagram already calls for) is the right next infrastructure
  investment, not a fourth entry in the client-side routing table.
- **No SKU catalog / pricing endpoint**: the Sales module's order capture
  hardcodes one finished-good SKU and lets the user type any unit price —
  no product-listing or price-list endpoint exists yet on any service.
- **`performance_reward_ledger`** (weekly agent reward bands based on NCR
  performance, `performance.reward_posted.v1` in the SDD) was explicitly
  descoped from the Sales module — a distinct sub-feature, not required to
  prove the capital-governance gate that module exists to demonstrate.
- **Purchase Order / Recipe / Agent caching is incomplete**:
  `apps/mobile/lib/core/database/tables.dart` defines cache tables for
  offline master-data lookup (`PurchaseOrdersCache`,
  `PurchaseOrderLinesCache`), but `main.dart` only holds the fetched
  `/purchase-orders`, `/recipes`, and `/agents` responses in memory for all
  three modules — none is persisted into local cache tables. Practical
  effect: a device needs connectivity at least once to open a given PO,
  recipe, or agent before capture; only the capture action itself (once
  that screen is open) works fully offline. Wiring the fetch-then-cache
  step is the natural next task, common to all three.
- **`posting_rules.condition_expression`** exists as a column but is never
  evaluated (SDD §3 preamble) — every posting rule so far has been
  unconditional. The Manufacturing module's variance handling worked around
  needing conditional logic by using two event types (favorable/
  unfavorable) instead; a module that genuinely needs conditional posting
  logic will need this implemented for real.

### Resolved during development (kept for history, not hidden)

- ~~Shared backend-common package doesn't exist yet~~ **Resolved
  2026-08-01**: extracted into `packages/backend-common`, consumed by all
  three domain services via a local `file:` dependency. See
  `docs/RUNBOOK.md` "Interlude" for a real npm gotcha this surfaced (local
  `file:` deps symlink by default, which breaks `instanceof` checks across
  module instances at runtime — fixed with `install-links=true` in each
  consumer's `.npmrc`).
