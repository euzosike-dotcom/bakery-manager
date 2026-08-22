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

- **Machine-to-machine auth now covers the platform's one synchronous
  service-to-service call.** governance-service's `/authorization-check`
  and `/approval-check` — called by `PostingAuthorityClient` from
  `procurement-service`, `sales-service`, `accounting-service`,
  `fleet-service`, and `hr-service` — used to trust a plain `x-tenant-id`
  header with zero verification of who was calling, the platform's one
  remaining pre-Keycloak stub-auth path. Each calling service now has its
  own confidential Keycloak client (`serviceAccountsEnabled: true`,
  `infra/keycloak/realm-export.json`) and mints a real client-credentials
  token (`@metrock/backend-common`'s `M2MTokenClient`, cached with a
  30-second early-refresh margin) that governance-service's new
  `M2MAuthMiddleware` verifies — real signature/issuer check plus the
  token's `azp` claim checked against an explicit allow-list
  (`M2M_ALLOWED_CLIENT_IDS`) — replacing `TenantContextMiddleware`,
  which is now fully deleted rather than left as unreachable code.
  `tenant_id`/`user_id` still travel as plain headers exactly as before
  (a service-account token has no tenant of its own to assert), now
  gated behind proof of the caller's identity instead of trusted on its
  word alone. Verified with a real minted token passing through to real
  business logic, a real throwaway Keycloak client with a genuinely
  valid token correctly REJECTED for not being on the allow-list, and a
  complete real transaction (a vendor bill payment through
  accounting-service, `OPEN` → `PAID` in the database) exercising the
  entire chain through actual application code, not hand-built curl
  headers. See docs/RUNBOOK.md's "Machine-to-machine auth" section for
  the full build and verification trail.
- **Finance connector** (Zoho Books / QuickBooks): `integration_queue` rows
  are written by the ledger service but nothing consumes them yet — the
  actual outbound connector is a separate build.
- **Multi-tenancy isolation tiers**: only the "Pool" tier (shared schema +
  RLS) is implemented. Schema-per-tenant ("Bridge") and database-per-tenant
  ("Silo") provisioning are not built yet.
- **API Gateway exists, but only as a transparent path-based reverse proxy —
  not the SDD's full Edge layer.** `infra/nginx/nginx.conf` (a new `gateway`
  service in `infra/docker-compose.yml`, `localhost:8000`) gives the
  Flutter client ONE base URL instead of 7 hardcoded per-module ports
  (`main.dart` now builds each `ApiClient` from `$gatewayBaseUrl/<module>`
  instead of its own port) and routes by path prefix to the right backend
  service. Deliberately NOT doing what the SDD's "API Gateway" component
  also calls for: subdomain-based tenant resolution (no second tenant
  exists to resolve against — this platform runs one tenant), per-*tenant*
  rate limiting (nothing to differentiate tenants by yet — see below for
  the flat, non-tenant-aware flood protection that DOES exist), or any JWT
  verification of its own (a transparent proxy; every backend service
  still verifies its own Bearer token exactly as before — see
  `nginx.conf`'s header comment for the full reasoning). The SDD's separate
  "Sync Gateway" component (relocating `/sync/push`/`/sync/pull` out of
  each domain service into one dedicated service) also remains
  unimplemented — those endpoints are correctly placed inside each service
  today and moving them would serve no one yet. `core/sync/sync_service.dart`
  still routes outbox events client-side via the `SyncModule` enum — that
  logic didn't need to change, only which URL each `ApiClient` points at.
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
- **`approval_matrix` amount-based approval routing now spans Procurement,
  Accounting, Fleet, and Manufacturing.** `checkApprovalAuthority` resolves
  a transaction's value against `approval_matrix`'s threshold bands to find
  the SPECIFIC role required at the current approval stage — a stricter
  check than the binary `can_approve` flag above, since e.g. both
  `PROCUREMENT_MGR` and `FINANCE_CONTROLLER` have `can_approve=true` but
  only one is the correct tier for a given amount. Procurement POs
  (`purchase_orders`), manual journal entries (`journal_entries`,
  accounting-service), and maintenance-request completions
  (`maintenance_requests`, fleet-service) all follow the SAME two-party
  shape: creation/submission calls no authority check at all, only
  approve/reject do, and reject requires the identical tier-check as
  approve (a lower-tier approver can reject what they could approve, not
  reject above their tier). Manufacturing's `production_batches` is
  deliberately shaped differently: it has no natural pre-posting
  amount-bearing transaction (batch close is offline-capturable, and the
  posting-authority retrofit above already excludes it from any gate on
  principle), so cost review is RETROSPECTIVE rather than gating — batch
  close always posts unconditionally and immediately, and separately
  computes `batch_cost` (`actualOutputQty * recipeVersion.standardCost`,
  an existing field, no new pricing logic) and does a plain read against
  `approval_matrix` (not `checkApprovalAuthority`, whose fail-closed
  behavior on "no matching band" is wrong for a threshold lookup that's
  usually not required) to decide whether the batch needs a manager to
  review it after the fact; `POST /production-batches/:batchId/approve`
  and `.../reject` never affect what already posted, only
  `cost_review_status`. Accounting's schema needed a real shape decision
  too — since `reports.service.ts` sums `journal_lines` directly to
  produce the trial balance, a journal entry cannot exist `POSTED` while
  still pending approval the way a PO can be `OPEN` while
  `approval_status=PENDING`; `journal_entries.status` itself now carries
  `PENDING_APPROVAL`/`REJECTED` as first-class states rather than adding a
  redundant parallel column. Manufacturing needed its own new Keycloak
  M2M client (`manufacturing-service`, added to governance-service's
  `M2M_ALLOWED_CLIENT_IDS`) since it never called governance-service
  before this. See `docs/RUNBOOK.md`'s "Approval-matrix enforcement"
  section for the full verification trail, including two real bugs found
  only by hitting a live database (a missing `UPDATE` grant on
  `journal_entries`, and a BigInt/JSON.stringify serialization crash on
  manufacturing-service's first `sync_seq`-returning GET endpoint).
- **Automated test coverage now spans every part of the platform — all 8
  Node services, the Go `ledger-service`'s pure logic, procurement-service
  against a real Postgres, and the Flutter mobile app — but is uneven by
  design and still mostly mocks the database.** Every module was
  previously verified exclusively by hand (curl, psql, re-run at the end
  of each phase); a 4-phase CI + test suite plan is now complete. Phases
  1-2 added 62 Jest unit tests across all 8 NestJS services targeting each
  one's single riskiest piece of business logic (governance-service's
  authority/approval checks and hash-chained audit log, procurement's
  over-receipt guard and PO approve/reject, manufacturing's yield formula,
  sales' capital gate, accounting's report arithmetic, fleet's
  fuel-variance tolerance, HR's revenue-based payroll calculation, a
  regression test for a real historical BigInt-serialization bug in CRM)
  plus 5 Go sub-tests for `ledger-service`'s pure
  `amountFromPayload`/`nullableUUID` helpers. Phase 3 added
  `test/*.integration-spec.ts` on procurement-service against a real
  `postgres:16-alpine` CI service container running the actual migrations
  + seed files: the exact 3-scenario RLS cross-tenant-isolation proof this
  repo had only ever verified by hand via `psql` since its first vertical
  slice, now automated, plus real-SQL proof (not mocked) that the
  over-receipt guard, idempotent replay, and PO approval actually persist
  correctly. Phase 4 added Flutter tests: `AuthClient`'s PKCE
  login/refresh/logout flow and secure-storage round-trip against
  `mocktail` fakes, and `GoodsReceiptRepository`'s offline outbox-event
  write path against a real in-memory sqlite database (not mocked —
  `AppDatabase` gained an optional `QueryExecutor` constructor param
  purely for this). A GitHub Actions workflow (`.github/workflows/ci.yml`
  — a matrix over the 8 Node services, plus separate Go, Postgres-backed
  integration, and Flutter jobs) builds and runs all of it on every
  push/PR. What's still NOT covered, deliberately: most services'
  secondary controllers (agents, NCR, invoices/bills/journals,
  vehicles/maintenance/trips, employees/attendance, customers, every
  `sync.service.ts`) and their Flutter repository counterparts; only
  procurement-service has real-database integration tests; nothing
  anywhere exercises the actual HTTP + Keycloak layer end-to-end
  automatically — the five approval-matrix scenarios remain a proven-by-
  hand curl verification, not a CI-enforced one. See `docs/RUNBOOK.md`'s
  "CI + test suite" Phase 1 through 4 sections for the full trail.
- **All committed credentials are local-dev-only, and there's no real
  secrets story for anything beyond that.** `infra/docker-compose.yml`'s
  three passwords (Postgres, MinIO, Keycloak admin) are overridable via a
  gitignored `infra/.env` (`infra/.env.example` documents this; `docker
  compose` reads it automatically from that directory). The 8
  `*_svc_dev_password` values `infra/postgres/migrations/*_role.sql`
  bakes in are no longer hardcoded literals — each file now reads its
  role's password from a psql variable (`:'procurement_svc_password'`),
  falling back via `\if`/`\else` to the exact same well-known dev value
  when nothing overrides it, so local dev and CI are unaffected, but a
  real deployment can pass `-v procurement_svc_password=<real-secret>`
  without ever touching a tracked file. Verified via a real
  `pg_authid.rolpassword` hash comparison, not just "the syntax parses"
  — see docs/RUNBOOK.md's "Secrets in production" section. This closes
  the one actual git-history leak (a real credential permanently baked
  into a committed file); the DEFAULTS themselves are still deliberately
  the same well-known values as before — they're not real secrets to
  begin with, so there's nothing to hide there. None of this is fit for
  any deployment reachable by anyone but the developer running it
  locally — a real deployment still needs an out-of-band, secrets-
  manager-driven provisioning step (Vault, AWS Secrets Manager, Doppler,
  or whatever the eventual hosting platform provides) that generates real
  per-environment credentials and injects them as env vars / `psql -v`
  flags at deploy time. That doesn't exist here, on purpose — no cloud
  deployment target exists yet to build it against, same "known, not
  solved" treatment as the missing machine-to-machine auth above.
- **`helmet` security headers on by default; CORS opt-in and unused so
  far.** `@metrock/backend-common`'s `applySecurityMiddleware` (called
  once per service from each `main.ts`, same shared-bootstrap pattern as
  `ValidationPipe`) applies `helmet()`'s defaults across all 8 NestJS
  services — real response headers (CSP, `X-Frame-Options`,
  `X-Content-Type-Options`, etc.), not just present in the code.
  CORS is gated behind an optional `CORS_ALLOWED_ORIGINS` env var
  (comma-separated, never a bare wildcard) precisely because it isn't an
  active gap today — a browser enforces same-origin with zero server
  config, and nothing today calls these APIs from a browser (only the
  native Flutter app + curl, neither subject to CORS). Left unset on
  every service, which changes nothing from before this pass; ready for
  whenever the SDD's Web Console client actually exists.
- **Flat, non-tenant-aware flood/DoS rate limiting exists at two
  independent layers — NOT the SDD's per-tenant-tier rate limiting,
  which still doesn't apply with one tenant in the system.** A gateway
  layer (`infra/nginx/nginx.conf`'s `limit_req_zone`, keyed by client IP:
  100 req/min with a 20-request burst, real `429`s confirmed under an
  actual 150-request burst, not just config review) and an app layer
  (`@metrock/backend-common`'s `RateLimitModule`, `@nestjs/throttler`
  wired into all 8 services' `AppModule`s: 100 req/min per client IP,
  also confirmed triggering real `429`s). Two layers because direct port
  access (`:3001`–`:3008`) bypasses the gateway entirely — this whole
  session's own manual verification has hit services directly on their
  ports throughout, so gateway-only protection would leave that path
  completely open. Limits are generous, clearly-dev-appropriate defaults,
  not real production SLA numbers (which the SDD ties to a tenant tier
  that doesn't exist yet).
- **TLS termination exists at the two things the Flutter client actually
  talks to directly — the nginx gateway and Keycloak — self-signed, and
  the mobile app now uses it end-to-end, including the native login
  flow.** `infra/certs/generate-dev-certs.sh`
  generates a gitignored, regenerable-per-machine self-signed cert
  (`CN=localhost`, SANs `localhost`+`127.0.0.1`) — deliberately plain
  `openssl`, not `mkcert`: `mkcert`'s nicer no-warning experience comes
  from installing a local CA into the system trust store, a real change
  to the machine itself that this repo doesn't make on your behalf. The
  gateway gets a second listener (`:8443`, alongside the existing plain
  `:8000` — not a replacement) and Keycloak gets `--https-certificate-file`
  alongside its existing plain `:8080` (mapped to host `:8543` to avoid
  colliding with the gateway's own `:8443`). Real TLS handshakes
  confirmed via `openssl s_client` and a full authenticated round-trip
  through `https://localhost:8443`, not just "the config parses." The
  8 backend services themselves don't serve TLS — they became internal-
  only the moment the gateway existed, so nothing client-facing hits them
  directly anymore. Postgres/Kafka/Redis/MinIO remain fully plaintext —
  internal data-plane traffic, each with its own separate TLS mechanism
  to configure, a distinctly bigger and lower-priority lift than the two
  client-facing endpoints. The Flutter app now speaks HTTPS to both: a
  pinned Dart `SecurityContext` for `ApiClient`'s data calls, and the
  iOS Simulator's own keychain trusting the dev cert (`xcrun simctl
  keychain ... add-root-cert`, a one-time per-simulator step) for
  `AuthClient`'s native `ASWebAuthenticationSession` login flow, which
  Dart-level TLS config can't reach at all. Moving the login endpoint to
  HTTPS also changes what's stamped into every issued token's `iss`
  claim, so all 8 backend services' `KEYCLOAK_ISSUER` and
  `NODE_EXTRA_CA_CERTS` (for their own JWKS fetch) had to move with it —
  see docs/RUNBOOK.md's "TLS termination (Part B)" for why that
  couldn't be avoided by pinning Keycloak's issuer instead.
- **NestJS 10→11 migration is complete — `npm audit` now reports 0
  vulnerabilities across all 8 services and `@metrock/backend-common`**,
  down from 23-24 per service. `@nestjs/common`/`core`/`platform-express`
  10→11.2.1, `@nestjs/config` 3→4.0.4, `@nestjs/cli`/`testing` 10→11,
  `@types/express` 4→5.0.6 — one coordinated bump, not staggered, since
  `@metrock/backend-common`'s peer ranges have to move before any
  consumer can, so a partial migration isn't really possible. The one
  real regression risk this carried: `@nestjs/platform-express@11`
  bundles Express 5, which changed route-pattern matching, and
  `consumer.apply(...).forRoutes('*')` is the exact pattern gating EVERY
  service's auth and request-id middleware — if Express 5's matching
  silently stopped matching that wildcard, it would be a platform-wide
  silent auth bypass, not a build error. Piloted on
  `@metrock/backend-common` + `procurement-service` first; before
  touching the other 7, confirmed live against a real running v11
  process that an unauthenticated request to a normal route still gets a
  real `401`, `/health`/`/metrics` still bypass auth via `.exclude()`,
  and a real Keycloak token still succeeds — the wildcard match held.
  Rolled the identical version set to the remaining 7 services, reran
  all 62 existing Jest tests plus procurement-service's real-Postgres
  integration suite (all passing, unmodified), and spot-checked the
  cross-cutting things this session already built that touch
  routing/middleware: the TLS gateway (`https://localhost:8443` routing
  still 200s), helmet headers (still present), and the full
  machine-to-machine auth chain (a real vendor-bill payment through
  accounting-service → `PostingAuthorityClient` → governance-service's
  `M2MAuthMiddleware`, real database state change, not a mocked
  assertion). See docs/RUNBOOK.md's "NestJS 10→11 migration" section for
  the full trail.
- **Backup/restore is on-demand and proven, not continuous.**
  `infra/postgres/backup.sh`/`restore.sh` run `pg_dump`/`pg_restore`
  inside the running postgres container (no local psql client needed).
  Deliberately data-only, not schema+data — schema already has a
  canonical source of truth (`infra/postgres/migrations/*.sql`), so
  baking a second copy into every dump would just be something else that
  can drift out of sync with it; `restore.sh` expects the target
  database's schema to already be current (run the migrations first,
  same as any fresh environment setup). Verified as a real recovery, not
  just "the script exited 0": backed up the live dev database, spun up a
  genuinely fresh disposable Postgres container with no data or schema,
  ran all 21 migrations to recreate schema and every least-privilege
  role from scratch, restored the backup into it, confirmed row counts
  matched exactly table-by-table against the source, then started an
  actual `procurement-service` instance pointed at the restored database
  and pulled real purchase orders back through its real API with a real
  Keycloak token — proof the restored data is genuinely usable by a
  running service, not just present in tables. No scheduled/automated
  backups and no off-host copy (`infra/.backups/` sits on the same disk
  as the data it backs up) — a real production DR story (continuous WAL
  archiving, point-in-time recovery, off-host retention) depends on
  whichever hosting target this eventually runs on, same "known, not
  solved yet" treatment as the missing secrets manager. See
  docs/RUNBOOK.md's "Backup & restore" section for the full trail.
- **Observability now covers health checks, structured logs, correlation
  ids, and a real Prometheus + Grafana stack — but still no alerting,
  tracing, or log aggregation.** Every backend service (all 8 Node
  services + the Go `ledger-service`, which had zero HTTP surface before
  this) now exposes an unauthenticated `GET /health` and a
  `GET /metrics` in Prometheus format; logs are structured JSON
  (`@metrock/backend-common`'s hand-rolled `StructuredLogger`, zero new
  dependency, replacing plain `console.log`/Nest's default text output);
  every request gets a correlation id (`RequestIdMiddleware` +
  `AsyncLocalStorage`) forwarded across the platform's one synchronous
  service-to-service call (`PostingAuthorityClient` -> governance-
  service) so one request's logs can be followed across that boundary —
  verified for real by forcing an actual error deep in governance-
  service's Prisma transaction and confirming the supplied id survived
  several async layers into the resulting log line, plus a real
  concurrent-execution test of the underlying `AsyncLocalStorage`
  mechanism itself. `infra/prometheus/prometheus.yml` scrapes all 9
  services via `host.docker.internal` (the same pattern the nginx
  gateway already uses); Grafana is pre-provisioned with a real dashboard
  (`infra/grafana/dashboards/metrock-platform-overview.json`, a tracked
  file, not clicked together in the UI) — confirmed rendering live data
  by generating real HTTP traffic and watching a panel spike in the
  browser, not just "the scrape config parses." SDD §4.2's "raise a
  real-time alert" on an authorization bypass attempt is still a
  structured log line, not an actual email/Slack/pager integration —
  Grafana could alert off these same metrics, but no alert rules or
  notification channel are configured. Also still missing: distributed
  tracing (no automatic cross-service trace visualization, just greppable
  correlation ids) and log aggregation (each service's JSON still only
  goes to its own stdout — no Loki/ELK centralizing it). See
  docs/RUNBOOK.md's "Observability" section for the full build and
  verification trail.
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
- ~~Auth is a stub — `TenantContextMiddleware` trusts a plain
  `x-tenant-id`/`x-user-id`/`x-role-code` header with zero
  verification~~ **Resolved 2026-08-05**, across four phases: a
  self-hosted Keycloak (`infra/docker-compose.yml`, realm config in
  `infra/keycloak/`) now issues signed JWTs carrying `tenant_id` and
  `local_user_id` claims. **Phase 1** proved the pattern on
  governance-service alone (`KeycloakAuthMiddleware`, DB-backed since
  that service owns the `users` table). **Phase 2** rolled it out to the
  other 7 services via one shared, dependency-free middleware variant in
  `packages/backend-common` that reads `local_user_id` straight off the
  token instead of a DB lookup (no service besides governance-service
  has a grant on `users`). **Phase 3** gave the Flutter mobile app
  (`apps/mobile`) a real login — Authorization Code + PKCE via
  `flutter_appauth`, tokens in `flutter_secure_storage`, replacing the
  hardcoded dev headers every `ApiClient` sent since Slice #1 — then
  retired the header-stub route exclusions Phase 2 needed once mobile no
  longer required them. **Phase 4** dropped the now-fully-dead
  `roleCode`/`x-role-code` field (confirmed by grep the whole way
  through: no authorization logic anywhere ever read it — role is always
  resolved by a DB join from `userId`). `TenantContextMiddleware` itself
  was later deleted outright once the machine-to-machine auth pass gave
  its one remaining route (governance-service's `/authorization-check`/
  `/approval-check`) a real replacement — see the "Known gaps" bullet
  above. See `docs/RUNBOOK.md`'s four "Keycloak auth retrofit" sections
  for the complete verification trail, including two
  real bugs caught rather than shipped silently: a Phase 1 regression
  that broke the mobile Users tab, and a Phase 3 discovery that mobile
  literally could not function until Phase 2's exclusions were retired
  (a hard blocker, not a nice-to-have cleanup).
