# Metrock ERP Platform

Multi-tenant, offline-first ERP platform for food manufacturing enterprises.
Metrock Enterprises is Tenant Zero. Full architecture: see
[`docs/SDD.md`](docs/SDD.md) (copied from the System Design Documentation).

## Status: All 15 original PRD/FRS modules covered, plus two platform extensions — verified end-to-end

This repo implements **eight modules** — Procurement GRN,
Manufacturing/Yield, Sales & Agent Capital, Accounting, CRM,
Logistics/Fleet, HR/Payroll, and Governance & Master Data — completing
every module named in the original PRD/FRS (Accounting and CRM are
platform extensions added on top, not part of that original 15):

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
| Logistics, Fleet & Fuel Management | `backend/fleet-service` | 3006 | `fleet.fuel_recorded.v1` -> Dr Vehicle Fuel Expense / Cr Cash and Bank; `fleet.maintenance_completed.v1` -> Dr Vehicle Maintenance Expense / Cr Accounts Payable |
| HR & Revenue-Based Payroll | `backend/hr-service` | 3007 | `payroll.run_posted.v1` -> Dr Salary/Wages Expense / Cr Payroll Payable |
| Governance & Master Data | `backend/governance-service` | 3008 | none — control plane only (RBAC, hash-chained audit log, posting-authority enforcement) |

Seven of the eight domain services share the exact same pattern: tenant-
context middleware + Prisma tenant-scoping helper (extracted into
`packages/backend-common` once a third service needed them — see "Known
gaps" history below), and a least-privilege Postgres role
(`procurement_svc`, `manufacturing_svc`, `sales_svc`, `accounting_svc`,
`crm_svc`, `fleet_svc`, `hr_svc`, `governance_svc`) so RLS is a real
backstop, not a no-op. Sales & Agent Capital
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

Logistics/Fleet picks the original 15-module PRD list back up (docs/SDD.md
§3.E) — trip logs and fuel records are the platform's next two offline-
capturable entities, and fuel-variance investigation is the platform's
second auto-triggered review workflow (after Manufacturing's yield
variance), feeding a shared `maintenance_requests` queue alongside a
mileage service-threshold check, deliberately not assuming a root cause
between "mechanical fault" and "fuel diversion" per the SDD. See
`docs/RUNBOOK.md`'s "Vertical Slice #5" section for the full trail,
including Matrix Scenario #9 (a fuel record referencing a since-cancelled
trip is still accepted and posted, only flagged for review).

HR & Revenue-Based Payroll is the fifth original-PRD module and the last
before Governance (docs/SDD.md §3.F) — attendance clock-in/out is the
platform's next offline-capturable entity, with two independent dedupe
layers (the standard client-event idempotency, plus Matrix Scenario #8's
time-bucket dedupe for two devices firing the same real-world clock-in).
Payroll itself is revenue-based, not a fixed salary structure: Payroll
Pool = Plant Revenue x Payroll Ratio, Employee Salary = Pool x Grade
Weight, split into an online-only calculate step and a separate online-
only post-to-books step per the SDD's explicit "never offline, never
queued" requirement for payroll. See `docs/RUNBOOK.md`'s "Vertical Slice
#6" section for the full trail, including the exact math verified end to
end and a real Postgres gotcha (a `GENERATED ALWAYS AS (date_trunc(...))
STORED` column rejected for depending on session TimeZone, not IMMUTABLE).

Governance & Master Data (docs/SDD.md §3.A) closes out the original
15-module PRD/FRS. Unusually, most of its schema (`plants`, `warehouses`,
`roles`, `users`, `approval_matrix`, `reason_codes`, `audit_log`) already
existed from Slice #1 — every other service has read it as cross-module
master data since day one. This slice adds the two things nothing had
implemented yet: hash-chained tamper-evident audit logging, and posting-
authority enforcement (deny + audit + alert on any bypass attempt) per
the SDD's §4.2 "Governance warning." It's also the first module with no
financial trigger, no Kafka producer, and no Flutter offline-capture
surface at all — the SDD is explicit that governance master data is
pull-only and never edited offline. See `docs/RUNBOOK.md`'s "Vertical
Slice #7" section for the full trail, including a genuine bug the hash-
chain verification surfaced (Postgres `jsonb` silently reorders object
keys on storage, breaking a naive hash round-trip) and direct proof that
the append-only audit trail can't be altered even by the Postgres
superuser.

## Repo layout

```
backend/
  procurement-service/   # NestJS: Suppliers, PR, PO, GRN, Sync Gateway
  manufacturing-service/ # NestJS: Recipes, Production Batch close, Sync Gateway
  sales-service/         # NestJS: Agents/capital status, Sales Orders (capital-gated, optional customerId), NCR, Sync Gateway
  accounting-service/    # NestJS: Vendor Bills/Customer Invoices (auto-generated via own Kafka consumer), manual journals, reports
  crm-service/           # NestJS: Customers (CRUD-lite), Opportunities, Activities (offline-capturable), Sync Gateway
  fleet-service/         # NestJS: Vehicles/Drivers, Trip Logs + Fuel Records (offline-capturable), Maintenance Requests, Sync Gateway
  hr-service/            # NestJS: Employees, Attendance (offline-capturable, two-layer dedupe), revenue-based Payroll Runs, Sync Gateway
  governance-service/    # NestJS: Plants/Warehouses/Roles/Users/Reason Codes/Approval Matrix (CRUD-lite), hash-chained Audit Log, posting-authority enforcement
  ledger-service/        # Go: Kafka consumer, double-entry posting engine (all modules)
packages/
  backend-common/        # Shared tenant-context middleware, Kafka producer, Prisma tenant-scoping helper
  contracts/             # Shared event/DTO contracts (JSON Schema)
infra/
  postgres/migrations/   # SQL migrations, RLS policies
  docker-compose.yml     # Postgres, Redpanda, Redis, MinIO for local dev
apps/
  mobile/                # Flutter: offline-first GRN + batch + sales order/NCR/activity/trip/fuel/attendance capture client
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
- **Fleet's Fuel Card Payable / Employee Expense Payable split isn't
  implemented** — same `condition_expression`-never-evaluated gap as
  above; `fleet.fuel_recorded.v1` always credits Cash and Bank.
- **Fleet has no driver picker or trip picker in the Flutter UI** — Trip
  capture uses the vehicle's one assigned driver; Fuel capture never sets
  `tripLogId`. Both are UI scope decisions — the backend accepts either
  field freely, and the fuel-variance/Scenario-#9 workflows this would
  exercise are already proven directly against fleet-service (see
  `docs/RUNBOOK.md`'s "Vertical Slice #5" §4).
- **`maintenance_requests` has no Flutter UI** — listing and completing a
  request (the one online-only back-office action in this module, mirrors
  NCR verification) were only proven via curl.
- **HR's `leave_requests` and true `salary_structures` are not built** —
  the SDD itself scopes attendance clock-in/out as the only offline-
  relevant surface in this module; neither is required to prove that
  pattern or the revenue-based payroll calculation.
- **No statutory payroll deduction engine** — `payroll_records
  .total_deductions` is always 0 (no tax/pension tables). A real
  deployment needs this before any real payslip could be cut.
- **HR's grade weights aren't validated to sum to 1.0** — tenant-
  configurable, not enforced; a misconfigured set silently under- or
  over-allocates the payroll pool rather than erroring.
- **No employee/attendance/payroll-review UI beyond capture** — employees
  are seeded directly via SQL; there's no attendance history view and no
  screen to review a calculated payroll run before posting it (both
  `calculateRun`/`postRun` were only proven via curl).
- **Plant Revenue is read from `sales_orders`, not `journal_entries`** —
  `sales.order_fulfilled.v1` never carries `plant_id` through to
  `journal_lines.cost_center_plant_id` (still NULL for every sales-
  revenue posting in this platform), so HR's payroll calculation reads
  sales-service's table directly instead of deriving revenue from the GL.
- **Posting-authority enforcement is retrofitted into the six ONLINE-ONLY
  finalization endpoints, deliberately not into offline field capture** —
  NCR verify (sales-service), vendor-bill payment + customer-invoice
  payment + manual journal entry (accounting-service), maintenance-request
  completion (fleet-service), and payroll-run posting (hr-service) all now
  call `governance-service`'s `POST /authorization-check` via
  `@metrock/backend-common`'s `PostingAuthorityClient` before posting.
  GRN receipt, batch close, sales order creation, and fuel/trip/attendance
  capture are NOT gated — those are offline-capturable actions performed
  by operational staff (a stores clerk, a production operator, a sales
  agent) who legitimately hold no `can_post` authority; gating them would
  require a synchronous online call mid-offline-capture, contradicting
  the offline-first design and breaking the already-verified capture flows
  tested against exactly that seed data. See `docs/RUNBOOK.md`'s "Posting-
  authority retrofit" section for the full verification trail (all six
  endpoints, three scenarios each, plus a fail-closed check with
  governance-service killed).
- **`approval_matrix` thresholds are configured but not enforced** — real,
  seeded, queryable data, but no service routes a transaction through
  approval-level checks based on it.
- **No real alerting pipeline** — SDD §4.2's "raise a real-time alert" on
  an authorization bypass attempt is a structured log line, not an actual
  email/Slack/pager integration.
- **Prefer `json` over `jsonb` (or canonicalize explicitly) for anything
  that must round-trip byte-identical** — `AuditService`'s hash chain
  initially failed verification because Postgres `jsonb` reorders object
  keys by `(length, then lexicographic)` on storage, so a naive
  `JSON.stringify` of a value read back from a `jsonb` column never
  matches the same value's serialization before it was stored. Fixed with
  a canonical (deterministically key-sorted) serialization applied on
  both sides — see `docs/RUNBOOK.md`'s "Vertical Slice #7" for the full
  story. Worth knowing before the next feature that hashes or signs
  anything stored as `jsonb`.

### Resolved during development (kept for history, not hidden)

- ~~Shared backend-common package doesn't exist yet~~ **Resolved
  2026-08-01**: extracted into `packages/backend-common`, consumed by all
  three domain services via a local `file:` dependency. See
  `docs/RUNBOOK.md` "Interlude" for a real npm gotcha this surfaced (local
  `file:` deps symlink by default, which breaks `instanceof` checks across
  module instances at runtime — fixed with `install-links=true` in each
  consumer's `.npmrc`).
- ~~Posting-authority enforcement isn't retrofitted into the other
  services~~ **Resolved 2026-08-04**: `PostingAuthorityClient` (in
  `packages/backend-common`, the platform's first synchronous
  service-to-service call) now gates the six online-only posting
  endpoints. See the "Known gaps" bullet above for what's gated and why
  the offline-capturable endpoints deliberately aren't, and
  `docs/RUNBOOK.md`'s "Posting-authority retrofit" section for the
  verification trail.
