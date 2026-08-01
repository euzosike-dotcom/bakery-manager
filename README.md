# Metrock ERP Platform

Multi-tenant, offline-first ERP platform for food manufacturing enterprises.
Metrock Enterprises is Tenant Zero. Full architecture: see
[`docs/SDD.md`](docs/SDD.md) (copied from the System Design Documentation).

## Status: Five modules verified end-to-end — Procurement GRN, Manufacturing/Yield, Sales & Agent Capital, Accounting, and CRM

This repo implements **five modules**, each proving the architecture
before scaling out to the remaining original-PRD modules (Logistics/Fleet,
HR/Payroll, Governance) or further platform extensions:

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
| Accounting (Zoho Books/QuickBooks equivalent) | `backend/accounting-service` | 3004 | `accounting.bill_paid.v1` -> Dr Accounts Payable / Cr Cash and Bank; `accounting.invoice_payment_received.v1` -> Dr Cash and Bank / Cr Agent Wallet |
| CRM | `backend/crm-service` | 3005 | none — no financial postings, integrates via `sales_orders.customer_id` |

All five domain services share the exact same pattern: tenant-context
middleware + Prisma tenant-scoping helper (extracted into
`packages/backend-common` once a third service needed them — see "Known
gaps" history below), and a least-privilege Postgres role
(`procurement_svc`, `manufacturing_svc`, `sales_svc`, `accounting_svc`,
`crm_svc`) so RLS is a real backstop, not a no-op. Sales & Agent Capital
introduces the platform's first real-time business gate: an order is
blocked server-side, synchronously, if it would exceed an agent's
available trading capital (`trading_capital_ledger`, computed live, never
cached) — the centerpiece rule from the original PRD.

Accounting and CRM are platform extensions added after the original three,
not part of the initial 15-module PRD/FRS — the user asked for a genuine
double-entry-adjacent AP/AR layer (Vendor Bills, Customer Invoices, manual
journal entries, Trial Balance/P&L/Balance Sheet) built **on top of** the
Unified Ledger that `ledger-service` already maintains, plus a CRM module
whose `Customer` entity is linked into Sales Orders. `accounting-service`
is architecturally distinct from the first three: it runs its own Kafka
**consumer** (a second, independent consumer group on the same
`erp.events` topic `ledger-service` already reads) to auto-generate bills/
invoices from `grn.posted.v1`/`sales.order_fulfilled.v1`, in addition to
producing the two payment events above. See
[`docs/RUNBOOK.md`](docs/RUNBOOK.md)'s "Vertical Slice #4" section for the
full verification trail.

## Repo layout

```
backend/
  procurement-service/   # NestJS: Suppliers, PR, PO, GRN, Sync Gateway
  manufacturing-service/ # NestJS: Recipes, Production Batch close, Sync Gateway
  sales-service/         # NestJS: Agents/capital status, Sales Orders (capital-gated, optional customerId), NCR, Sync Gateway
  accounting-service/    # NestJS: Vendor Bills/Customer Invoices (auto-generated via own Kafka consumer), manual journals, reports
  crm-service/           # NestJS: Customers (CRUD-lite), Opportunities, Activities (offline-capturable), Sync Gateway
  ledger-service/        # Go: Kafka consumer, double-entry posting engine (all modules)
packages/
  backend-common/        # Shared tenant-context middleware, Kafka producer, Prisma tenant-scoping helper
  contracts/             # Shared event/DTO contracts (JSON Schema)
infra/
  postgres/migrations/   # SQL migrations, RLS policies
  docker-compose.yml     # Postgres, Redpanda, Redis, MinIO for local dev
apps/
  mobile/                # Flutter: offline-first GRN + batch + sales order/NCR/activity capture client
docs/
  SDD.md                 # Full system design documentation
  RUNBOOK.md             # Verified bring-up + verification trail for every module
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
- **Accounting has no Flutter UI** — by design, not an oversight. Bill/
  invoice payment recording is an inherently connected back-office action
  (same scope decision as Sales's NCR verification step), so there's no
  offline-capturable entity for it to add to the sync engine. CRM's
  Activities screen (offline-capturable) and the Sales Order customer
  picker both exist and are proven on-device — see `docs/RUNBOOK.md`'s
  "Vertical Slice #4" §6 for the real kill-the-backend verification,
  including two real bugs it surfaced and fixed (a numeric-as-string
  cast bug in two of the Procurement/Manufacturing pull handlers, and a
  BigInt-JSON-serialization bug in crm-service's Activities list endpoint).
- **NCR-based and invoice-payment-based AR recovery are unreconciled**: a
  Sales NCR verification and an Accounting Customer Invoice payment both
  credit the same GL account (1210, Agent Wallet / Trading Capital
  Receivable) with no cross-check between the two channels — flagged when
  the Accounting schema was designed (`014_accounting.sql`'s header
  comment). No rule exists anywhere in the original PRD for whether a
  customer-invoiced order should even participate in agent capital at all,
  since that PRD predates the CRM/customer concept entirely.
- **No period-close / retained-earnings roll-forward** in Accounting's
  reports — Trial Balance/P&L/Balance Sheet are all-time snapshots, so
  Balance Sheet's `totalAssets` will always differ from
  `totalLiabilities + totalEquity` by exactly the P&L's unclosed
  `netIncome`. Expected, not a bug — see `reports.service.ts`'s class doc
  comment.
- **CRM has no Lead/Customer conversion workflow, no dedup/merge** — one
  `customers` table serves both "prospect" and "existing customer" via
  `customer_status`, a deliberate simplification (`012_crm.sql`'s header
  comment).

### Resolved during development (kept for history, not hidden)

- ~~Shared backend-common package doesn't exist yet~~ **Resolved
  2026-08-01**: extracted into `packages/backend-common`, consumed by all
  three domain services via a local `file:` dependency. See
  `docs/RUNBOOK.md` "Interlude" for a real npm gotcha this surfaced (local
  `file:` deps symlink by default, which breaks `instanceof` checks across
  module instances at runtime — fixed with `install-links=true` in each
  consumer's `.npmrc`).
