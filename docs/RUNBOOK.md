# Runbook — Vertical Slice #1 (Procurement GRN)

**Status: fully verified end-to-end on 2026-07-30**, including on-device —
not just via curl. Backend (Node 26 via nvm, Go 1.26) verified via direct
API calls; then the Flutter app itself was built and run on an iOS
Simulator (Flutter 3.44, Xcode 26.5), with the backend deliberately killed
to prove the offline write path, then restarted and synced to prove the
full round trip. The steps below are what was actually run, in order,
including the real bugs that surfaced along the way and how they were
fixed — kept in this doc rather than scrubbed out, since the next module to
come online will hit variants of most of them again.

## 0. Toolchain setup

| Tool | Check | Install |
|---|---|---|
| Node 20+ (use via nvm, not system Node) | `node --version` | `nvm install 20 && nvm use 20` (or later — verified against Node 26) |
| Go 1.22+ | `go version` | `brew install go` (requires accepting the Xcode license first: `sudo xcodebuild -license accept`) or https://go.dev/dl/ |
| Flutter 3.22+ | `flutter doctor` | https://docs.flutter.dev/get-started/install (includes Dart) |
| Docker Desktop | `docker --version` | https://www.docker.com/products/docker-desktop/ |

**Every command below that runs Node must be preceded by
`source "$HOME/.nvm/nvm.sh" && nvm use 20` (or whatever version you
installed) in the same shell.** If you see a `SyntaxError: Unexpected
token '?'` from `nest start`, that's Node 13 (or another EOL system Node)
being picked up instead — nvm wasn't actually active in that shell.

## 1. Start the local infra stack

```bash
cd infra
docker compose up -d
```

Starts Postgres (`localhost:5432`), Redpanda/Kafka (`localhost:9092`),
Redis (`localhost:6379`), MinIO (`localhost:9000`, console `:9001`), and
the nginx API Gateway (`localhost:8000` plain / `:8443` TLS — see "API
Gateway" and "TLS termination" sections below; the 8 backend services
themselves still run on the host, not in compose). Keycloak's own HTTPS
listener is on `:8543`. Run `infra/certs/generate-dev-certs.sh` once
before first use — nginx and Keycloak both fail to start without a cert
present at `infra/certs/`.

Postgres/MinIO/Keycloak-admin credentials default to well-known local-dev
values (`metrock_dev_password`, `admin`) baked into `docker-compose.yml` —
fine as-is for local use, since this stack isn't reachable from anywhere
but `localhost`. To override them (still never for a real deployment, see
README "Known gaps"), copy `infra/.env.example` to `infra/.env` —
`docker compose` reads a `.env` file from this same directory
automatically, no extra flag needed.

**Bug #1 found here — Redpanda advertised-listener mismatch.** Redpanda's
compose config originally advertised itself as `redpanda:9092` (its
in-network Docker Compose hostname). A Kafka client connects to the
bootstrap address fine, but then re-dials whatever address the *broker*
advertises in cluster metadata — and `redpanda` isn't resolvable from the
host, where `procurement-service` and `ledger-service` both run for this
slice. Symptom: `ledger-service` logged a clean startup, then died ~10s
later with `dial tcp: lookup redpanda: no such host`. Fixed in
`infra/docker-compose.yml` by advertising `localhost:9092` instead (see the
comment on that line — if a service is later containerized on this compose
network, it needs its own listener, not a flip back).

If you pulled this repo before that fix, or edit the compose file again:

```bash
docker compose up -d redpanda   # recreates with the new advertised address
```

## 2. Run migrations + seed data

```bash
cd infra
for f in postgres/migrations/*.sql; do
  docker compose exec -T postgres psql -U metrock -d metrock_erp < "$f"
done
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/seed/dev_seed.sql
```

**Bug #2 found here — seed data used invalid UUIDs.** The original seed
data used cosmetic sequential placeholders
(`00000000-0000-0000-0000-000000000601`). Postgres's `uuid` type accepts
these happily (it's just 32 hex digits + dashes), but `class-validator`'s
`@IsUUID()` in the NestJS DTOs correctly rejects them — their version/variant
nibbles aren't RFC-4122-valid. This only surfaces the moment something
actually POSTs a body containing one (`poId must be a UUID` etc.), not at
migration time. Fixed by regenerating `dev_seed.sql` with real
`crypto.randomUUID()` values (documented in a comment block at the top of
that file). **The IDs below are the current, correct ones** — if you see
the old `00000000-...` IDs anywhere (old notes, a stale branch), they're
wrong, not just ugly.

| Entity | ID |
|---|---|
| Tenant (METROCK) | `b17d9226-2a43-43eb-8c5e-a923637b23c5` |
| Plant PLT-1 | `aba294c3-c28c-43a9-a465-67ced442a487` |
| Warehouse WH-PLT1-RM | `7840f37a-13eb-4779-aa16-84bf10f7d351` |
| Supplier SUP-001 | `cb6e3879-86db-482e-a602-8a696d2b5a40` |
| PO PO-2026-00001 | `46778dc9-e4dc-4d00-9f53-3a2b476a0f64` |
| PO line (Flour) | `db94681e-d781-4c12-ad1c-4d7d7204f480` |

If you seeded before this fix, wipe and reseed rather than trying to patch
rows in place:

```bash
docker compose exec -T postgres psql -U metrock -d metrock_erp -c "
  TRUNCATE TABLE purchase_order_lines, purchase_orders, posting_rules,
    chart_of_accounts, suppliers, users, warehouses, plants, roles,
    tenant_registry CASCADE;
"
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/seed/dev_seed.sql
```

### Least-privilege app role + RLS verification

**Important**: `metrock` (the bootstrap `POSTGRES_USER`) is a Postgres
**superuser** — that's just how the official postgres image's initdb works.
Superusers bypass Row-Level Security unconditionally, so testing RLS (or
running the app) through this role proves nothing and silently defeats the
DB-layer isolation backstop. Migration `007_app_role.sql` creates a
least-privilege `procurement_svc` role for exactly this reason — this
migration is not optional, `procurement-service`'s `.env` depends on it:

```bash
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/migrations/007_app_role.sql
```

Now verify RLS **as that role**, not as `metrock`:

```bash
# Wrong tenant -> must be 0
docker compose exec postgres psql -U procurement_svc -d metrock_erp -c "
  BEGIN; SET LOCAL app.tenant_id = '4516225e-8cf1-479f-823c-682df503f558';
  SELECT count(*) FROM purchase_orders; ROLLBACK;
"
# Correct (seeded) tenant -> must be 1
docker compose exec postgres psql -U procurement_svc -d metrock_erp -c "
  BEGIN; SET LOCAL app.tenant_id = 'b17d9226-2a43-43eb-8c5e-a923637b23c5';
  SELECT count(*) FROM purchase_orders; ROLLBACK;
"
# No tenant context set at all -> must be 0 (fail closed)
docker compose exec postgres psql -U procurement_svc -d metrock_erp -c "
  SELECT count(*) FROM purchase_orders;
"
```

Verified results: `0`, `1`, `0` — RLS is genuinely enforced, not just
present in the schema.

## 3. Start procurement-service (NestJS)

```bash
cd backend/procurement-service
cp .env.example .env
source "$HOME/.nvm/nvm.sh" && nvm use 20   # or your installed version
npm install
npx prisma generate
npm run start:dev
```

`.env`'s `DATABASE_URL` must point at `procurement_svc`, not `metrock` (see
above) — `.env.example` already reflects this.

Should log `procurement-service listening on :3001`. Smoke-test:

```bash
curl http://localhost:3001/purchase-orders \
  -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5"
```

You should get back the seeded `PO-2026-00001` with its one line. Also
confirm tenant isolation from the outside, not just via raw SQL:

```bash
# Wrong tenant -> []
curl http://localhost:3001/purchase-orders -H "x-tenant-id: 4516225e-8cf1-479f-823c-682df503f558"
# No tenant header at all -> HTTP 401
curl -o /dev/null -w "%{http_code}\n" http://localhost:3001/purchase-orders
```

**If port 3001 is already in use** from a previous crashed/backgrounded
attempt: `lsof -nP -iTCP:3001 -sTCP:LISTEN` to find the stale PID, `kill`
it, then retry.

## 4. Start ledger-service (Go)

```bash
cd backend/ledger-service
go mod tidy
go build ./...   # sanity check before running
go run ./cmd/ledger-service
```

Should log `ledger-service starting topic=erp.events group=ledger-service`
and then just sit there (that's correct — it's blocked on `FetchMessage`).
If it instead dies ~10s later with a `lookup redpanda: no such host` error,
you're hitting Bug #1 above — check `infra/docker-compose.yml`'s
`--advertise-kafka-addr` and recreate the `redpanda` container.

## 5. Prove the backend chain before touching the mobile app

Faster feedback loop than waiting on the Flutter build: POST a GRN directly
and watch it flow through Kafka to a posted journal entry.

```bash
curl -s -X POST http://localhost:3001/goods-receipts \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5" \
  -H "x-user-id: b5875910-4707-4a3a-952d-3f2cde434d4e" \
  -d '{
    "grnNumber": "GRN-2026-00001",
    "poId": "46778dc9-e4dc-4d00-9f53-3a2b476a0f64",
    "warehouseId": "7840f37a-13eb-4779-aa16-84bf10f7d351",
    "lines": [
      { "poLineId": "db94681e-d781-4c12-ad1c-4d7d7204f480",
        "receivedQty": 500, "acceptedQty": 480, "rejectedQty": 20,
        "uom": "KG", "unitCost": 480 }
    ]
  }'
```

Expect `{"clientEventId":"...","status":"ACKED","serverEntityId":"...",
"message":"GRN posted; grn.posted.v1 emitted per accepted line."}`.

Then check `ledger-service`'s log for `posted journal entry ... debit=1310
credit=2110`, and confirm in Postgres:

```bash
docker compose exec postgres psql -U metrock -d metrock_erp -c "
  SET app.tenant_id = 'b17d9226-2a43-43eb-8c5e-a923637b23c5';
  SELECT je.journal_entry_id, jl.account_code, jl.debit_amount, jl.credit_amount
  FROM journal_entries je JOIN journal_lines jl USING (journal_entry_id, tenant_id)
  ORDER BY je.posting_date DESC LIMIT 10;
"
```

Expect one row crediting `2110` (Accounts Payable) and one debiting `1310`
(Raw Material Inventory), both `230400.00` (= 480 accepted × 480 unit cost)
— matching the worked example in `docs/SDD.md` §3.B.

**Re-posting the identical GRN body a second time** (same `grnNumber`, but
note it'll generate a *new* `clientEventId` since none was supplied — to
actually test idempotency, add `"clientEventId": "<any-fixed-uuid>"` to the
body and repeat the request) should return `"message":"Already applied
(idempotent replay)"` with no second journal entry — this is the
idempotency guarantee from SDD §2.2, worth checking explicitly rather than
assuming it works because the code looks right.

## 6. Run the mobile app

The Flutter project here has `pubspec.yaml` and `lib/` but **not** the
native `android/`, `ios/`, `macos/` platform folders — generate them once,
fetch packages, generate Drift's `.g.dart`:

```bash
cd apps/mobile
flutter create --platforms=android,ios,macos,linux,windows .
flutter pub get
dart run build_runner build --delete-conflicting-outputs
flutter run   # pick a connected simulator/device when prompted
```

Before running, update the dev constants in `lib/main.dart` to match the
regenerated seed IDs above (`_devTenantId`, and the hardcoded warehouse ID
in `_HomeScreenState._openCapture`) — they still have the old
`00000000-...` placeholders as of this doc being written; if `main.dart` has
since been updated to the real IDs, this step is already done.

If running on the **Android emulator**, also change `_devApiBaseUrl` from
`http://localhost:3001` to `http://10.0.2.2:3001` (the emulator's alias for
the host machine).

## 7. Prove the vertical slice end-to-end (through the app, offline)

1. In the app, turn on Airplane Mode (or otherwise cut connectivity).
2. Tap into `PO-2026-00001`, enter an accepted quantity against the Flour
   line, tap **Save Goods Receipt**. You should see "Saved locally..." —
   this happened entirely offline, no request was made.
3. Turn connectivity back on. `SyncService`'s connectivity listener fires
   automatically (or tap the sync icon in the app bar).
4. Check `procurement-service` logs for `published grn.posted.v1 for
   tenant=...`, and `ledger-service` logs for `posted journal entry`.
5. Re-run the journal query from step 5 above — a second entry should
   appear for this GRN.
6. Tap sync again (or wait for the periodic pull) and confirm the GRN's
   `postingStatus` in the local cache flips from `PENDING` to `POSTED`.

## What actually happened, on-device (2026-07-30)

Ran `flutter create --platforms=ios,android,macos`, `flutter pub get`,
`dart run build_runner build`, `flutter analyze` (clean), `flutter test`
(the generated boilerplate test referenced a `MyApp` class that doesn't
exist in this project — our root widget is `MetrockApp` — replaced with a
real dependency-free unit test of `PoLineDraft`'s quantity math). Built
`flutter build ios --debug --simulator`, booted an iPhone 17 Pro simulator,
launched the app, and drove it via the iOS Simulator MCP tools.

**Bug #4 found here — tap coordinates.** This tool's `tap`/`swipe` actions
take coordinates in **device points** (this device: 402×874), not raw
screenshot pixel coordinates — the screenshots render larger than that. Do
the pixel→point division (screenshot width ÷ 402) before tapping, or taps
land on the wrong element entirely; several confusing "phantom text" and
"button did nothing" moments during this verification pass turned out to
just be this, not an app bug.

**What was proven, in order:**
1. App launched, fetched the live seeded `PO-2026-00001` over the network,
   and rendered it correctly.
2. Opened the GRN capture screen for that PO; entered accepted/rejected
   quantities.
3. **Killed `procurement-service` entirely**, then tapped **Save Goods
   Receipt** — it saved instantly and showed "Saved locally. Will sync
   automatically once connected — nothing is lost offline." with zero
   network dependency, exactly as designed (the write path never touches
   the network — see `GoodsReceiptRepository.captureGoodsReceipt`).
4. Restarted `procurement-service`, tapped the sync icon.
5. Confirmed server-side: the queued offline GRN(s) synced, `posting_status`
   flipped to `POSTED`, and `ledger-service` posted matching balanced
   journal entries (`Dr 1310 / Cr 2110`) for each valid one.
6. As a bonus (unintentional, but a good stress test — some earlier
   coordinate-confusion taps ended up submitting a few extra GRNs with
   partial quantities before this was diagnosed): one of the queued GRNs
   pushed cumulative received quantity past the PO line's remaining
   capacity and was correctly routed to `NEEDS_REVIEW` with **no** journal
   entry posted for it — Conflict Matrix scenario #3, working through the
   real app, not just via a hand-crafted curl request.

## Known gaps still open after this pass (Procurement)

- No automated test yet for the over-receipt path (Conflict Matrix scenario
  #3) or the idempotent-retry path — both were exercised manually above,
  not covered by CI.
- `PurchaseOrdersCache` / `PurchaseOrderLinesCache` Drift tables are defined
  but not yet written to — see `README.md` "Known gaps".
- `ledger-service` still connects as the Postgres superuser by design (see
  the doc comment on `internal/db/pool.go`) — that's an accepted tradeoff
  for a trusted internal consumer, not something this pass changed.

---

# Vertical Slice #2 — Manufacturing & Yield Intelligence

**Status: fully verified end-to-end on 2026-08-01**, same rigor as
Procurement above: backend proven via curl first, then the Flutter app
itself was built, run on the same iPhone 17 Pro simulator, and put through
the offline-kill-restart-sync cycle. Three more real bugs surfaced; documented
below rather than scrubbed out.

## 1. Apply the new migrations + seed data

```bash
cd infra
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/migrations/008_manufacturing.sql
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/migrations/009_manufacturing_rls_and_role.sql
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/seed/manufacturing_seed.sql
```

Verify RLS as the `manufacturing_svc` role, same pattern as `procurement_svc`:

```bash
# Wrong tenant -> 0
docker compose exec postgres psql -U manufacturing_svc -d metrock_erp -c "
  BEGIN; SET LOCAL app.tenant_id = '4516225e-8cf1-479f-823c-682df503f558';
  SELECT count(*) FROM recipe_versions; ROLLBACK;"
# Correct tenant -> 1
docker compose exec postgres psql -U manufacturing_svc -d metrock_erp -c "
  BEGIN; SET LOCAL app.tenant_id = 'b17d9226-2a43-43eb-8c5e-a923637b23c5';
  SELECT count(*) FROM recipe_versions; ROLLBACK;"
```

Seeded IDs (see the header comment in `manufacturing_seed.sql` for the full
list): SKU `BRD-500G` = `8558cee8-8acd-4d5a-a334-3b3dc4088512`, Recipe
Version 1 (approved) = `103f648b-d180-4be8-951c-ba011a7d8725`.

**Bug #4 — `manufacturing_svc` needed sequence grants too.** Identical
failure mode to Bug #3 in the Procurement section
(`permission denied for sequence production_batches_sync_seq_seq`) — same
fix, same root cause (table `INSERT` privilege does not imply sequence
`USAGE`). Already baked into `009_manufacturing_rls_and_role.sql` this
time, since it was known going in — but re-verify with a real POST if you
ever add another bigserial column anywhere in this schema.

## 2. Start manufacturing-service (NestJS, port 3002)

```bash
cd backend/manufacturing-service
cp .env.example .env
source "$HOME/.nvm/nvm.sh" && nvm use 20
npm install
npx prisma generate
npm run start:dev
```

Smoke-test:

```bash
curl http://localhost:3002/recipes -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5"
```

Should return "Standard White Bread" with 1 approved version and 4
ingredients (flour/sugar/yeast/salt).

## 3. Restart ledger-service so it knows the new event types

`ledger-service` doesn't need a schema change to handle new event types
(the posting-rule lookup is generic), but it DOES need the
`sourceModuleFor()` switch in `internal/kafka/consumer.go` updated — already
done, mapping `batch.consumption_recorded.v1`, `batch.output_recorded.v1`,
and both `batch.yield_variance_*.v1` events to `"manufacturing"`.

```bash
cd backend/ledger-service
go build ./...   # sanity check
```

**Important — check for a stale duplicate consumer before restarting.** If
you edit `consumer.go` while an old `go run ./cmd/ledger-service` is still
alive, `pkill -f "cmd/ledger-service"` will NOT kill the actual compiled
binary (its process name is a go-build cache path, not that string) — you'll
end up with two processes in the same Kafka consumer group, and it's
non-deterministic which one (old buggy code vs. new fixed code) actually
processes the next message. Find and kill the real binary explicitly:

```bash
ps aux | grep -i ledger   # look for a second process alongside "go run ./cmd/ledger-service"
kill -9 <stale-pid>
go run ./cmd/ledger-service
```

If you just killed a stale member with `-9`, the survivor may sit idle for
10-20s waiting on the Kafka consumer-group rebalance (the old member's
session has to time out) before it resumes consuming — this is normal, not
a hang; give it ~20s before concluding something's broken.

## 4. Prove the backend chain: close a batch directly

```bash
curl -s -X POST http://localhost:3002/production-batches \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5" \
  -d '{
    "batchNumber": "BATCH-2026-00001",
    "plantId": "aba294c3-c28c-43a9-a465-67ced442a487",
    "skuId": "8558cee8-8acd-4d5a-a334-3b3dc4088512",
    "recipeVersionId": "103f648b-d180-4be8-951c-ba011a7d8725",
    "plannedQty": 343,
    "actualOutputQty": 900,
    "actualWasteQty": 5,
    "consumptionLines": [
      { "ingredientSkuId": "39db8695-0360-4ae3-9d28-85472f5b270e", "plannedQty": 300, "actualQty": 300 },
      { "ingredientSkuId": "d48dfceb-22ad-414b-a053-fde5ed84332f", "plannedQty": 30, "actualQty": 30 },
      { "ingredientSkuId": "7f7a9932-dd76-44b9-8e0a-43f4ff30d5e7", "plannedQty": 5, "actualQty": 5 },
      { "ingredientSkuId": "97efb0b1-9c5f-418c-a805-b6e1c0f7c316", "plannedQty": 8, "actualQty": 8 }
    ]
  }'
```

Expect `"yieldPercent":131.19...`, `"message":"Batch closed and posted to
the ledger."`. That 131.2% is correct, not a bug — see next section.

**Bug #5 (real correctness bug, found on first test) — yield % compared
the wrong units.** The first test run returned `"yieldPercent":250` for
870 units of output against 348kg of ingredients: 870/348*100. That's
comparing a *unit count* directly to a *KG total* — meaningless. Fixed in
`production.service.ts` by converting output quantity to mass via the
SKU's `standardWeightKg` (0.5kg/loaf for `BRD-500G`) before the yield
division: `(actualOutputQty * standardWeightKg) / totalActualQty * 100`.
900 loaves * 0.5kg = 450kg / 343kg standard input = 131.2% — a plausible
bakery yield (dough absorbs water during mixing that isn't a costed
ingredient, so >100% mass yield is normal, not a red flag). Also had to add
`standardWeightKg` to the Prisma model — it existed in the SQL migration
but was never mapped in `schema.prisma`, so this bug was invisible to the
type checker.

Confirm the posting in Postgres:

```bash
docker compose exec postgres psql -U metrock -d metrock_erp -c "
  SET app.tenant_id = 'b17d9226-2a43-43eb-8c5e-a923637b23c5';
  SELECT je.source_module, jl.account_code, jl.debit_amount, jl.credit_amount
  FROM journal_entries je JOIN journal_lines jl USING (journal_entry_id, tenant_id)
  ORDER BY je.posting_date DESC LIMIT 6;
"
```

Expect three entries: Dr `1320`/Cr `1310` = 170,700 (consumption at actual
cost), Dr `1330`/Cr `1320` = 171,000 (output at standard cost), and — since
170,700 < 171,000 here — a **favorable** variance Dr `1320`/Cr `5310` = 300.
Submit the same request again with different quantities that make
consumption *exceed* standard cost to see the **unfavorable** direction
(Dr `5310`/Cr `1320`) instead — both directions were exercised during this
verification pass, see below.

**Bug #6 — no validation that a recipe version actually belongs to the
submitted SKU.** Caught in code review before it ever shipped, not at
runtime: `closeProductionBatch` originally trusted `dto.skuId` without
checking it against `recipeVersion.recipe.skuId`. Fixed by fetching the
recipe's own SKU and rejecting a mismatch — otherwise a client bug (or a
malicious client) could post a batch against the wrong recipe's cost
structure with no server-side check catching it.

## 5. Run the mobile app (Recipes tab)

Same build steps as Procurement (`flutter create` was already run once for
this project, no need to repeat) — `main.dart` now shows a two-tab home
screen: **Purchase Orders** and **Recipes**. The Recipes tab fetches
directly from `manufacturing-service` (`:3002`), same "known gap" as
Purchase Orders (see README) — no offline cache yet, needs connectivity to
open a recipe once.

If running on Android emulator, `_devManufacturingBaseUrl` needs the same
`10.0.2.2` substitution as `_devProcurementBaseUrl`.

## 6. Prove the vertical slice end-to-end through the app, offline

1. Open the **Recipes** tab, tap "Standard White Bread".
2. Enter output/waste quantities and each ingredient's actual consumption.
   Ingredient rows show only the SKU ID prefix, not a name (README "Known
   gaps" — no SKU-name lookup wired into this screen yet).
3. **Killed `manufacturing-service` entirely**, then tapped **Close
   Batch** — saved instantly with "Saved locally...", zero network
   dependency, same as GRN capture.
4. Restarted `manufacturing-service`, tapped the sync icon (top-right of
   the shared app bar — syncs both modules in one tap, see
   `core/sync/sync_service.dart`'s `SyncModule` routing).
5. Confirmed server-side: the queued offline batch synced, `yieldPercent`
   was computed (server-side, never trusted from the client — see the doc
   comment on `ProductionBatchCaptureCubit`), and `ledger-service` posted
   the matching consumption/output/variance entries.

**Note on UI automation coordinates**: filling this form hit the same
point-vs-pixel coordinate lesson documented in the Procurement section —
worth re-reading before automating taps against a new screen. Row spacing
between the ingredient fields on this particular screen was empirically
~48pt for the first two rows but the third row needed a noticeably larger
jump (~96pt) before the tap actually landed on it — screen layout isn't
perfectly uniform once conditional label/error text is involved, so verify
each tap with a screenshot rather than extrapolating a fixed row height
across an entire form.

## Known gaps still open after this pass (Manufacturing)

- No automated test yet for the recipe-not-approved -> `NEEDS_REVIEW` path
  (mirrors Procurement's over-receipt gate) — implemented, not yet
  exercised in this verification pass the way over-receipt was.
- Ingredient consumption lines aren't pulled back down to the client (only
  `production_batches` headers are) — the client doesn't need them back
  since it authored them, but this means `production_consumption` has no
  pull-cursor at all, not even a documented gap, just genuinely unused
  round-trip. Fine for now; would need it if lines can ever change
  server-side independent of the client.
- Same shared backend-common package gap as noted in `README.md` — now
  proven at exactly the "two services" threshold where it's worth fixing
  before a third.

---

# Interlude — Extracting `packages/backend-common` (2026-08-01)

Before starting Vertical Slice #3, paid down the duplication debt flagged
above: `tenant-context.middleware.ts`, `current-tenant.decorator.ts`,
`kafka-producer.service.ts`, and the Prisma tenant-scoping logic moved into
`packages/backend-common`, consumed by `procurement-service` and
`manufacturing-service` via `"@metrock/backend-common": "file:../../packages/backend-common"`.
`KafkaProducerService` now takes a `clientId` constructor argument (the one
thing that differed per copy), so each service's module registers it via a
factory provider instead of Nest's default zero-arg instantiation:

```ts
{ provide: KafkaProducerService, useFactory: () => new KafkaProducerService('procurement-service') }
```

**Bug #7 — npm symlinks a local `file:` dependency; Node's module
resolution then escapes the consuming service's `node_modules` entirely.**
This one is worth understanding in full, because it fails at *runtime*, not
at `npm install` or `tsc` time, which makes it easy to ship unnoticed.

1. `npm install` for a `file:../../packages/backend-common` dependency
   defaults to creating a **symlink** at
   `node_modules/@metrock/backend-common` pointing to the real
   `packages/backend-common` directory (npm does this to save disk space,
   same idea as workspace hoisting).
2. Node's `require()` resolution follows that symlink to its **real path**
   before walking up looking for `node_modules` directories. So requiring
   `@nestjs/common` from inside `packages/backend-common/dist/*.js` walks up
   from `packages/backend-common`, not from
   `backend/procurement-service/node_modules/@metrock/backend-common` — it
   never sees `procurement-service`'s own (hoisted) `node_modules/@nestjs/common`
   at all.
3. First symptom (before we removed `backend-common`'s own `node_modules`):
   `backend-common` still had a leftover `node_modules/@nestjs/common` from
   when it was built, so resolution found *that* copy instead — a **second,
   separate instance** of `@nestjs/common` in the process. `UnauthorizedException`
   thrown from that instance fails `instanceof HttpException` checks in
   Nest's exception filter (different class objects, same name), so Nest
   couldn't recognize it as an HTTP exception and returned a bare `500`
   instead of the correct `401` for a missing `x-tenant-id` header. This is
   the dangerous version: no error message pointing at the real cause,
   the app "works" for every happy path, and only breaks on an error path
   that's easy not to test.
4. After deleting `backend-common`'s own `node_modules` (correct — a
   library shouldn't ship one), resolution failed outright:
   `Cannot find module '@nestjs/common'`, `MODULE_NOT_FOUND`, immediately on
   boot. Loud and obvious, but still a symptom of the same root cause.

**Fix**: force npm to *copy* the dependency instead of symlinking it, via
`install-links=true` in an `.npmrc` in each consuming service
(`backend/procurement-service/.npmrc`, `backend/manufacturing-service/.npmrc`,
and now `backend/sales-service/.npmrc`). Once copied, `@metrock/backend-common`
is a real subdirectory of the consuming service's own `node_modules`, so
Node's walk-up correctly finds that service's own hoisted `@nestjs/common`.
As a side benefit, `backend-common/package.json`'s `"files": ["dist"]`
field is only respected by npm when it's actually packing/copying (not when
symlinking), so the copied version is also clean — just `dist/` and
`package.json`, no stray `src/`/`tsconfig.json`.

**Verification after the fix**: restarted both services, re-ran the
tenant-isolation checks from Vertical Slice #1/#2 (wrong tenant -> `[]`,
missing header -> `401` — genuinely `401` this time, not `500`), then
POSTed a real GRN and confirmed a new balanced journal entry landed
(`journal_entries` count went 20 -> 21) — i.e. re-verified the *entire*
already-shipped, already-pushed pipeline still works after touching its
shared plumbing, not just that it compiles.

If you extract another shared package later: add `install-links=true` to
that consumer's `.npmrc` from the start, don't wait to hit this.

---

# Vertical Slice #3 — Sales & Agent Capital Governance

**Status: fully verified end-to-end on 2026-08-01.** Same rigor as the
first two slices — backend proven via curl first (including the two
scenarios that actually matter: an order within capital and one that
exceeds it), then the Flutter app itself, on the same simulator, through
the full offline-kill-restart-sync cycle for both a sales order and an NCR
submission. `sales-service` was built on `@metrock/backend-common` and with
`install-links=true` from the start (see the Interlude above) — no repeat
of that bug here. One new, real bug did surface; documented below.

## 1. Apply migrations + seed data

```bash
cd infra
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/migrations/010_sales_agent_capital.sql
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/migrations/011_sales_rls_and_role.sql
docker compose exec -T postgres psql -U metrock -d metrock_erp < postgres/seed/sales_agent_capital_seed.sql
```

Verify RLS as `sales_svc`, same pattern as the other two roles:

```bash
docker compose exec postgres psql -U sales_svc -d metrock_erp -c "
  BEGIN; SET LOCAL app.tenant_id = '4516225e-8cf1-479f-823c-682df503f558';
  SELECT count(*) FROM agent_master; ROLLBACK;"   # -> 0
docker compose exec postgres psql -U sales_svc -d metrock_erp -c "
  BEGIN; SET LOCAL app.tenant_id = 'b17d9226-2a43-43eb-8c5e-a923637b23c5';
  SELECT count(*) FROM agent_master; ROLLBACK;"   # -> 1
```

Seeded: Agent `AG-0001` (Chidi Okafor) = `3db3020f-f5fd-4eae-bfa9-f7b9a1ad90d4`,
`approvedTradingCapital` = 500,000.

## 2. Start sales-service (NestJS, port 3003)

```bash
cd backend/sales-service
cp .env.example .env
source "$HOME/.nvm/nvm.sh" && nvm use 20
npm install
npx prisma generate
npm run start:dev
```

Smoke-test:

```bash
curl http://localhost:3003/agents -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5"
```

Should return AG-0001 with `availableCapital: 500000` (computed live from
`trading_capital_ledger`, never cached — see `AgentsService`'s doc
comment).

**Structural note**: this service has three feature modules (Agents,
Sales, Ncr) all needing `PrismaService`/`KafkaProducerService`, unlike the
other two services' single-feature-module structure — declaring those
providers locally in each module (the pattern procurement-service/
manufacturing-service use, harmlessly, since only one module needs them
there) would silently open three separate DB connection pools and Kafka
producer connections, and leave `SyncModule` with an ambiguous provider to
resolve. Fixed with `@Global()` `PrismaModule`/`KafkaModule` in
`src/common/` — see those files' doc comments if adding a fourth module.

## 3. Extend ledger-service

Already done: `sourceModuleFor()` in `internal/kafka/consumer.go` maps
`sales.order_fulfilled.v1` and `ncr.verified.v1` to `"sales"`. Rebuild and
restart the same way as Vertical Slice #2 (watch for the stale-duplicate-
consumer gotcha if you edited this file while an old instance was running).

## 4. Prove the backend chain: the capital gate, directly

This is the one worth being deliberate about — it's the actual point of
this module.

```bash
# Order WITHIN capital (300,000 of 500,000 available) -> confirmed + posted
curl -s -X POST http://localhost:3003/sales-orders \
  -H "Content-Type: application/json" -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5" \
  -d '{"orderNumber":"SO-2026-00001","agentId":"3db3020f-f5fd-4eae-bfa9-f7b9a1ad90d4",
       "plantId":"aba294c3-c28c-43a9-a465-67ced442a487",
       "lines":[{"skuId":"8558cee8-8acd-4d5a-a334-3b3dc4088512","orderedQty":1000,"unitPrice":300}]}'
# -> status ACKED, availableCapital 200000

# Order EXCEEDING remaining capital (700,000 vs 200,000 available) -> blocked, NOT posted
curl -s -X POST http://localhost:3003/sales-orders \
  -H "Content-Type: application/json" -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5" \
  -d '{"orderNumber":"SO-2026-00002","agentId":"3db3020f-f5fd-4eae-bfa9-f7b9a1ad90d4",
       "plantId":"aba294c3-c28c-43a9-a465-67ced442a487",
       "lines":[{"skuId":"8558cee8-8acd-4d5a-a334-3b3dc4088512","orderedQty":1000,"unitPrice":700}]}'
# -> status NEEDS_REVIEW, reasonCode ORDER_EXCEEDS_AVAILABLE_CAPITAL, availableCapital STILL 200000
```

Confirm in Postgres: exactly one `journal_entries` row for `source_module =
'sales'` (Dr `1210` / Cr `4000`, 300,000) — the blocked order produced
none. Then NCR:

```bash
# Submit (unverified) -> capital unchanged
curl -s -X POST http://localhost:3003/ncr-collections \
  -H "Content-Type: application/json" -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5" \
  -d '{"ncrReference":"NCR-2026-00001","agentId":"3db3020f-f5fd-4eae-bfa9-f7b9a1ad90d4","amount":150000}'
# check /agents/.../capital-status -> still 200000

# Verify (online-only, no sync path) -> restores capital + posts to ledger
curl -s -X POST "http://localhost:3003/ncr-collections/<ncrId>/verify" \
  -H "x-tenant-id: b17d9226-2a43-43eb-8c5e-a923637b23c5" -H "x-user-id: b5875910-4707-4a3a-952d-3f2cde434d4e"
# check /agents/.../capital-status -> 350000 now; new journal entry Dr 1100 / Cr 1210, 150000
```

**Bug #8 — `payload` field on the sync push DTO needs `@IsObject()`, or the
entire request gets rejected.** This one cost the most debugging time of
any bug in this project, because the symptom looked exactly like a UI
tap-target miss (something this project has had several genuine instances
of), not a server bug. `SyncPushEventDto.payload` carries either a
`CreateSalesOrderDto` or a `SubmitNcrDto` shape depending on `entityType` —
`class-validator` doesn't support "validate as type A or B based on a
sibling field" natively, so (unlike procurement-service/manufacturing-
service, which each have only one push-able entity type and could
strongly-type `payload` with `@ValidateNested() @Type(() => ConcreteDto)`)
this field was declared as a bare `Record<string, unknown>` with **no
class-validator decorator at all**. Nest's global `ValidationPipe` here is
configured `whitelist: true, forbidNonWhitelisted: true` (correctly — it's
what makes the DTO layer actually mean something). That combination
doesn't just strip undecorated properties, it **rejects the whole
request** with `"property payload should not exist"`. Every `/sync/push`
call failed with a `400` before `SyncService.push` ever ran — and because
the mobile client's error handling correctly reverts a failed push group
back to `PENDING` (see Vertical Slice #1's `_pushOutbox`), the *symptom* was
just "nothing appears server-side after tapping sync," identical to what a
missed tap looks like. Spent real time re-verifying tap coordinates before
replicating the exact request with curl and seeing the actual 400.

Fix: `@IsObject()` on `payload` (not `@ValidateNested()` +
`@Type()`, which would force one concrete shape) — enough to satisfy the
whitelist without imposing a shape, and `SyncService.push` still does its
own manual `plainToInstance` + `validate()` per branch afterward (see that
file's doc comment — this was already correct going in; only the outer
DTO's whitelist gate was missing). If a future module's push endpoint also
needs a polymorphic payload, this is the pattern; if you see "property X
should not exist" from any Nest endpoint, check for a field with no
validator decorator before assuming the request body is wrong.

## 5. Run the mobile app (Agents tab)

Third tab, third `ApiClient` (`:3003`), agent list shows live
`availableCapital`; tapping an agent opens a detail screen with **New
Sales Order** and **Submit Cash Collection (NCR)**. `SyncModule.sales` in
`core/sync/sync_service.dart` routes `sales_order`/`ncr_collection` push
and `sales_orders`/`ncr_collections` pull to this service — see that file
for the routing tables if adding a fourth service.

Order capture hardcodes one finished-good SKU (`BRD-500G`, same as the
Manufacturing seed) for the single order line — same "no catalog picker
yet" simplification as the other two capture screens; a real SKU picker
needs a product-listing endpoint on sales-service, which doesn't exist.

## 6. Prove the vertical slice end-to-end through the app, offline

1. Agents tab -> tap AG-0001 -> **New Sales Order** -> enter a quantity ×
   price that deliberately exceeds the displayed available capital (the
   screen shows a warning, but does not block submission — see
   `SalesOrderCaptureCubit`'s doc comment for why blocking here would
   repeat Conflict Matrix scenario #7's mistake).
2. **Killed `sales-service` entirely**, tapped **Save Order** — saved
   instantly, "Saved locally...", zero network dependency.
3. Restarted `sales-service`, tapped sync. Confirmed server-side: the
   order synced with `created_offline = true`, `order_status =
   NEEDS_REVIEW`, `credit_eligibility_status = BLOCKED` — the capital gate
   applied correctly to an order that originated offline, exactly as
   scenario #7 requires, and no journal entry was posted for it.
4. Repeated for NCR: **Submit Cash Collection (NCR)** while offline, saved
   locally, synced after reconnecting, landed with `verified_flag = false`
   — correctly NOT restoring capital (that requires the separate,
   online-only verify action, which this app has no UI for by design).

## Known gaps still open after this pass (Sales & Agent Capital)

- No SKU catalog / pricing endpoint — order capture hardcodes one product
  and lets the user type any unit price. A real pricing/price-list
  subsystem (`product_skus.current_price_list_status` exists as a column
  in the original module register but nothing reads it yet) is out of
  scope for this slice.
- No UI anywhere for NCR verification (correctly — it's an online-only
  back-office action) or for viewing `trading_capital_ledger` history
  directly; the capital-status endpoint only exposes the current computed
  balance, not the entries behind it.
- `performance_reward_ledger` / weekly reward-band posting
  (`performance.reward_posted.v1` in the SDD) was explicitly descoped from
  this slice — it's a distinct sub-feature (reward calculation based on
  NCR performance against weekly targets) not required to prove the core
  capital-governance gate, which was the point of this module.

# Vertical Slice #4 — Accounting & CRM (2026-08-01)

Two platform extensions added at the user's request, alongside the
original 15-module PRD scope: a real Accounting layer on top of the
Unified Ledger (trackable Vendor Bills/Customer Invoices with due dates
and payment status, plus manual journal entries and financial reports),
and a CRM module (Customers/Opportunities/Activities) whose Customer
entity is wired into Sales Orders immediately rather than built standalone
first — both scope decisions confirmed by the user up front, not decided
unilaterally mid-build.

**Important distinction from every prior slice**: `journal_entries`/
`journal_lines` already existed (migration 005) and were already being
posted to by `ledger-service` for every module since Slice #1. This slice
does NOT create a second ledger — `accounting-service` reads and writes
the SAME tables. What was genuinely missing, and what this slice adds, is
the *paperwork layer* above the GL: a bill/invoice record with a due date
and a payment status, which `grn.posted.v1`/`sales.order_fulfilled.v1`
never had before (they posted straight to GL accounts with nothing behind
them).

## 1. Apply migrations + regenerate Prisma clients

```
docker compose -f infra/docker-compose.yml exec -T postgres psql -U metrock -d metrock_erp \
  -f infra/postgres/migrations/014_accounting.sql \
  -f infra/postgres/migrations/015_accounting_rls_and_role.sql \
  -f infra/postgres/migrations/012_crm.sql \
  -f infra/postgres/migrations/013_crm_rls_and_role.sql
```

`016_accounting_extra_grants.sql` was added as its own follow-up migration,
not folded into 015 — by the time it became clear `accounting-service`'s
`grn.posted.v1` consumer needs to resolve `supplier_id`/`payment_terms` off
`po_line_id` (the event payload only carries `po_line_id`/`plant_id`, not
`supplier_id`), migration 015 had already been applied. Rule this project
has followed since Slice #1: never edit an applied migration, always add a
new one.

RLS + role smoke test, same pattern as every prior module:

```
# accounting_svc, wrong tenant -> 0
docker compose exec postgres psql -U accounting_svc -d metrock_erp -c "
  SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM chart_of_accounts;"
# accounting_svc, correct tenant -> 8 (seeded chart of accounts)

# crm_svc, wrong tenant -> 0, correct tenant -> row count of customers created
docker compose exec postgres psql -U crm_svc -d metrock_erp -c "
  SET app.tenant_id = '<some-other-tenant>'; SELECT count(*) FROM customers;"
```

Both confirmed correct before any service code was written.

## 2. Scaffold accounting-service (NestJS, port 3004) and crm-service (port 3005)

Both follow the `packages/backend-common` pattern exactly, including
`.npmrc` with `install-links=true` from the very first `npm install` —
learned the hard way in Slice #3 (Bug #7: a local `file:` dependency
symlinks by default, which breaks Node's module resolution walk-up).
Verified for both services this time before writing any TypeScript: `ls
node_modules/@metrock/backend-common` shows a real directory, not a
symlink.

`accounting-service` is architecturally different from every prior
service in one respect: it runs its own Kafka **consumer**, not just a
producer. `ledger-service` (Go) already consumes `grn.posted.v1` and
`sales.order_fulfilled.v1` off the shared `erp.events` topic to post
journal entries; `accounting-service` consumes the *same* two event types
in a second, independent consumer group (`accounting-service`) to
auto-generate Vendor Bills / Customer Invoices — kafkajs guarantees each
distinct group id gets its own full copy of every message, so this
required zero changes to procurement-service or sales-service. See
`src/kafka/kafka-consumer.service.ts`.

`journals` (manual journal entries) is the one posting path in this whole
platform not mediated by `ledger-service`'s Kafka consumer at all — a
manual entry has no source domain event to react to. Migration 015 grants
`accounting_svc` direct `INSERT` on `journal_entries`/`journal_lines`, a
deliberate, narrow exception documented in that migration's role comment.

## 3. Extend ledger-service (Go) for the two new payment events

One line added to `sourceModuleFor` in
`backend/ledger-service/internal/kafka/consumer.go`:

```go
case "accounting.bill_paid.v1", "accounting.invoice_payment_received.v1":
    return "accounting"
```

Nothing else needed changing — the posting engine (`posting_engine.go`)
was already fully generic (loads `posting_rules` by tenant + event_type,
pulls a named top-level field out of the event payload as the amount).
Migration 014 had already inserted the two new `posting_rules` rows
(`accounting.bill_paid.v1` → Dr 2110/Cr 1100, `accounting.invoice_payment_received.v1`
→ Dr 1100/Cr 1210) with `amount_expression = 'payment_amount'`, matching
the field name `accounting-service` actually publishes. Restarted
ledger-service the same careful way as every prior restart — killed both
the `go run` wrapper PID and the separately-running compiled binary PID
(Bug #6 from Slice #2: killing the wrapper alone leaves a second consumer
racing in the same group).

## 4. Wire `customer_id` into sales-service order creation

`CreateSalesOrderDto.customerId` (optional, `@IsUUID()`), validated
against `customers` (new `Customer` model in sales-service's Prisma
schema, read-only, `sales_svc` already had `SELECT` on `customers` from
migration 013) exactly like the existing `agentId` validation, then passed
through to the raw `INSERT INTO sales_orders` — no change to the capital-
eligibility gate logic itself. Required regenerating sales-service's
Prisma client and letting `nest start --watch` pick up the source change.

## 5. Prove the backend chain — all via curl, both services running live

`accounting-service` subscribes with `fromBeginning: true` — on first
boot, against a database that already had 6 GRNs and 1 sales order from
Slices #1–#3's own testing, it immediately and correctly auto-created 6
Vendor Bills (aggregating GRN lines into one bill per GRN, matching
`totalAmount` to the sum of `accepted_value`) and logged that the one
pre-existing sales order had no `customer_id` — a genuine, free proof that
replay/idempotency works, not staged data.

```
# New sales order WITH a customerId -> accounting-service auto-raises a Customer Invoice
curl -X POST localhost:3003/sales-orders -H "x-tenant-id: <tenant>" -d '{
  "orderNumber": "SO-ACCTG-TEST-001", "agentId": "<agent>", "plantId": "<plant>",
  "customerId": "<customer>", "lines": [{"skuId": "<sku>", "orderedQty": 10, "unitPrice": 500}]
}'
# -> order CONFIRMED; accounting-service's consumer then creates a
#    customer_invoices row: invoiceNumber INV-<salesOrderId>, totalAmount 5000,
#    dueDate = invoiceDate + 30 days, sourceEventId = the event_id (idempotency)

curl -X POST localhost:3004/vendor-bills/<billId>/payments -d '{"amount": 4800, ...}'
curl -X POST localhost:3004/customer-invoices/<invoiceId>/payments -d '{"amount": 5000, ...}'
# both -> bill/invoice status flips to PAID; overpayment beyond the
# outstanding balance correctly rejected with 400

# confirmed directly in Postgres:
#   accounting.bill_paid.v1              -> Dr 2110 (Accounts Payable) / Cr 1100 (Cash)
#   accounting.invoice_payment_received.v1 -> Dr 1100 (Cash) / Cr 1210 (Agent Wallet)
# source_module = 'accounting' on both journal_entries rows, confirming step 3's fix

curl -X POST localhost:3004/journal-entries -d '{"lines": [
  {"accountCode": "1100", "debitAmount": 1000, "creditAmount": 0},
  {"accountCode": "4000", "debitAmount": 0, "creditAmount": 1000}
]}'
# -> balanced entry accepted; an unbalanced entry and a two-sided single
#    line (debit AND credit both > 0) both correctly rejected with 400

curl localhost:3004/reports/trial-balance
# -> totalDebit === totalCredit (5,593,780 = 5,593,780) across every
#    module's accumulated test postings from Slices #1-#4 combined
```

`GET /reports/profit-and-loss` and `/reports/balance-sheet` both return
without error, but their numbers include a lot of accumulated noise from
repeated manual test runs across every prior slice's verification passes
(this dev database has never been reset) — not a defect in the report
logic. One thing IS worth flagging as a real, intentional simplification:
neither report performs a period-close / retained-earnings roll-forward,
so Balance Sheet's `totalAssets` will always differ from
`totalLiabilities + totalEquity` by exactly the unclosed `netIncome` from
the P&L — confirmed this holds exactly in the live numbers, which is the
expected behavior of an all-time snapshot with no period close, not a
calculation bug.

`crm-service` verified separately: `customers` CRUD-lite (create + list +
status update), `opportunities` create + list, and — the one offline-
capturable entity — `activities` through the real `/sync/push` / `/sync/
pull` gateway (same idempotent-push / cursor-pull shape as every prior
module), including a replayed push of the same `clientEventId` correctly
returning "Already applied" with the same `serverEntityId` rather than a
duplicate row.

## 6. Flutter: Customers tab, Activity logging, and the Sales Order customer picker

Fourth tab (`_CustomersTab`), fetched directly online via a new
`ApiClient.fetchCustomers()` — same "no local cache table" simplification
as Purchase Orders/Recipes/Agents (a device needs connectivity at least
once before a customer can be picked; only the capture action itself works
fully offline afterward). Tapping a customer opens `_CustomerDetailScreen`
with the one CRM action this slice implements: **Log Activity**
(`ActivityCaptureCubit`/`ActivityRepository`), CRM's one offline-
capturable entity — new `ActivitiesLocal` Drift table (schema v3 -> v4),
new `SyncModule.crm` entry, `'activity'` push / `'activities'` pull
routing in `sync_service.dart`.

The Sales Order capture screen gained an optional Customer dropdown
(`SalesOrderCaptureState.customerId`, `SalesOrderCaptureCubit
.updateCustomerId`) — `SalesOrdersLocal` gained a nullable `customerId`
column (schema v3 -> v4, via `m.addColumn`, not `m.createTable`, since this
table already existed) and the outbox payload now includes `customerId`
when set.

**Proven exactly like Slices #1–#3** — real device, real kill-the-backend:

1. Customers tab lists both the seeded customer and one created earlier
   via curl in this same session — confirms the tab reads real server
   state, not fixture data.
2. **Killed `crm-service` entirely.** Tapped a customer -> Log Activity ->
   filled in type + notes -> Save. "Saved locally..." — confirmed directly
   in the device's SQLite file (`sqlite3 .../metrock_erp.sqlite`) that the
   `activities` outbox row existed with `sync_status = 'PENDING'` before
   the backend ever came back up.
3. Restarted `crm-service`, tapped sync. Outbox row flipped to `ACKED`;
   `GET /activities` on the backend confirmed the exact same
   `client_event_id` with `created_offline = true`.
4. New Sales Order screen: picked "Sunrise Retail Stores" from the new
   customer dropdown, entered qty/price. **Killed `sales-service`
   entirely.** Saved — "Saved locally...". Restarted `sales-service`,
   synced — order landed with `customer_id` set and `created_offline =
   true`, exactly as scenario #7 (Slice #3) requires for every other
   field on this same order. accounting-service's Kafka consumer then
   auto-raised a `2500`-total `OPEN` Customer Invoice against that order —
   the full five-module chain (Flutter capture -> Sales order ->
   Kafka -> Accounting auto-invoice) working from a single offline tap.

**Two real bugs found and fixed during this pass** (both in code that
predates this slice, surfaced only now because this was the first time
`syncNow()` ran against a database with real accumulated numeric data from
every prior slice's testing):

- **Bug #9 — `_applyGoodsReceiptLinesPage`/`_applyProductionBatchesPage`
  cast pulled numeric fields as `(row[x] as num).toDouble()`**, which
  throws `type 'String' is not a subtype of type 'num'` because the
  backend's `$queryRaw` path returns Postgres `numeric` columns as JSON
  strings (node-pg's default type parser), not JS numbers — exactly the
  class of bug `_applySalesOrdersPage`/`_applyNcrCollectionsPage` had
  already worked around with `double.parse(row[x].toString())`. The GRN/
  batch pull functions were just never fixed to match. This wasn't
  cosmetic: an unhandled exception here aborted the rest of `syncNow()`'s
  pull sequence, which meant the new `activities` pull (added at the end
  of that sequence) never ran either — this one bug was blocking CRM
  verification entirely until fixed. Fix: same `double.parse(...toString())`
  pattern, applied to both functions.
- **Bug #10 — `ActivitiesService.findAll()` (crm-service) returns
  Prisma's native `bigint` for `sync_seq` directly to `GET /activities`**,
  which Express's `JSON.stringify` cannot serialize (`Do not know how to
  serialize a BigInt`) — a 500 on every call. Every other module's
  identical gotcha only ever showed up on the `$queryRaw`-based `/sync/
  pull` path (each service already has its own `serializeBigInts` helper
  there); this is the first GET endpoint anywhere in the platform
  returning a Prisma-typed entity with a `BigInt` column directly, so nothing
  existing caught it. Fix: map `syncSeq` to a string before returning.

## Known gaps still open after this pass (Accounting & CRM)

- **NCR-based and invoice-payment-based AR recovery are unreconciled** —
  flagged in migration 014's header comment when the schema was designed:
  both a Sales NCR verification and a Customer Invoice payment credit the
  same GL account (1210, Agent Wallet / Trading Capital Receivable), with
  no cross-check preventing an order's exposure from being reduced through
  both channels independently. No business rule exists anywhere in the
  original PRD for whether a customer-invoiced order should even
  participate in agent capital at all — that PRD predates the CRM/customer
  concept entirely.
- **No period-close / retained-earnings roll-forward** in
  `reports.service.ts` — see the P&L/Balance Sheet discussion above.
- **CRM has no Lead/Customer conversion workflow, no dedup/merge** — one
  `customers` table serves both "prospect" and "existing customer" via
  `customer_status`, a deliberate simplification noted in migration 012's
  header comment.

# Vertical Slice #5 — Logistics, Fleet & Fuel Management (2026-08-01)

The fourth of the original 15 PRD/FRS modules (docs/SDD.md §3.E), after
Procurement, Manufacturing, and Sales — picking back up on the original
module list rather than another platform extension.

## 1. Apply migrations + seed data

```
docker compose -f infra/docker-compose.yml exec -T postgres psql -U metrock -d metrock_erp \
  -f infra/postgres/migrations/017_fleet.sql \
  -f infra/postgres/migrations/018_fleet_rls_and_role.sql
psql ... -f infra/postgres/seed/fleet_seed.sql
```

Schema: `vehicle_class_fuel_norms` (configurable `litres_per_km` +
tolerance band per class), `drivers`, `vehicles` (tracks
`current_mileage` / `service_threshold_km`), `trip_logs` and
`fuel_records` (both offline-capturable — the two use cases the SDD names
explicitly), and `maintenance_requests` — one shared review queue fed by
both the mileage-threshold check and the fuel-variance check, per the
SDD's explicit instruction not to assume a root cause between "mechanical
fault" and "fuel diversion."

Seed vehicle deliberately starts at `current_mileage = 9850` against a
`service_threshold_km = 10000` — close enough that the first real trip
logged during verification crosses the threshold, proving the auto-
maintenance trigger without needing synthetic setup.

RLS + role smoke test, same pattern as every prior module — wrong tenant
-> 0, correct tenant -> 1 seeded vehicle. Confirmed before any service
code was written.

## 2. Scaffold fleet-service (NestJS, port 3006)

Same `packages/backend-common` pattern, `.npmrc` with `install-links=true`
from the first `npm install`. One new build-time lesson (not a runtime
bug, caught immediately by `nest build`): `TripLog`/`FuelRecord` have a
`bigserial sync_seq` column, and Prisma's typed `.create()` requires that
field in its input type since it has no `@default` Prisma recognizes —
exactly the reason procurement-service/manufacturing-service/sales-service
all write their sync-tracked tables via raw `$executeRaw` INSERT instead
of the typed client. `TripsService`/`FuelService` were initially written
using `.create()` (a fresh mistake, not present in copied code) and fixed
to match the established raw-insert convention before ever running.

Vehicles/Drivers are fetched directly online (no local cache table), same
simplification as every other module's master data. Trip logs use
single-shot capture (start + end mileage together) rather than a
start/then/end two-phase flow — a deliberate scope decision, not required
to prove the offline pattern.

## 3. Extend ledger-service (Go)

One line in `sourceModuleFor`:
```go
case "fleet.fuel_recorded.v1", "fleet.maintenance_completed.v1":
    return "fleet"
```
New GL accounts (migration 017): 5320 Vehicle Fuel Expense, 5330 Vehicle
Maintenance Expense (both EXPENSE). Posting rules: `fleet.fuel_recorded.v1`
-> Dr 5320 / Cr 1100 (Cash and Bank); `fleet.maintenance_completed.v1` ->
Dr 5330 / Cr 2110 (Accounts Payable). The SDD names an "or" on the fuel
credit side (Cash/Fuel Card Payable, or Employee Expense Payable if
reimbursed) — this posting engine only supports one fixed credit account
per event_type (`condition_expression` is still never evaluated, a gap
since Slice #1), so this picks the simplest deterministic path: fuel paid
from company cash immediately. Fuel variance itself is never posted
(SDD's explicit note) — only actual `fuel_cost`/`parts_cost+labour_cost`
ever hit the ledger. Restarted ledger-service the careful way (killed
both the `go run` wrapper and the compiled binary PIDs).

## 4. Prove the backend chain — all via curl

```
# Trip that pushes mileage from the seeded 9850 past the 10000 threshold
curl -X POST localhost:3006/trip-logs -d '{
  "vehicleId": "<vehicle>", "driverId": "<driver>",
  "startMileage": 9850, "endMileage": 10050
}'
# -> vehicle.current_mileage updated to 10050; a SERVICE_THRESHOLD
#    maintenance_requests row auto-created (OPEN)

# Fuel record within tolerance (200km * 0.12L/km = 24L expected; logged 25L)
curl -X POST localhost:3006/fuel-records -d '{"vehicleId":"<v>","tripLogId":"<trip>","litres":25,"fuelCost":15000}'
# -> "Fuel record logged and posted." — no investigation opened

# Fuel record WAY outside tolerance (same trip, 50L vs 24L expected)
curl -X POST localhost:3006/fuel-records -d '{"vehicleId":"<v>","tripLogId":"<trip>","litres":50,"fuelCost":30000}'
# -> "...Fuel variance outside tolerance — a maintenance investigation was opened."
#    a FUEL_VARIANCE_INVESTIGATION row lands in the SAME maintenance_requests
#    queue as the threshold-triggered row above

# Matrix Scenario #9: a second trip, cancelled directly in Postgres after
# creation, then a fuel record submitted against it
curl -X POST localhost:3006/fuel-records -d '{"vehicleId":"<v>","tripLogId":"<cancelled-trip>","litres":6,"fuelCost":3600}'
# -> still ACKED, "...Referenced trip was cancelled — flagged for review."
#    fuel_records.orphaned_trip_reference = true in Postgres — never rejected

# Complete the SERVICE_THRESHOLD request (online-only, mirrors NCR verify)
curl -X POST localhost:3006/maintenance-requests/<id>/complete -d '{"partsCost":12000,"labourCost":5000}'

# confirmed directly in Postgres:
#   3x fleet.fuel_recorded.v1  -> Dr 5320 / Cr 1100  (15000, 30000, 3600)
#   1x fleet.maintenance_completed.v1 -> Dr 5330 / Cr 2110 (17000 = 12000+5000)
# source_module = 'fleet' on all four journal_entries rows
```

## 5. Flutter: Vehicles tab, Trip Log + Fuel Record capture

Fifth tab (`_VehiclesTab`, tab bar now `isScrollable: true` — five tabs no
longer fit unscrolled), fetched directly online via `ApiClient
.fetchVehicles()`. Vehicle detail screen exposes both offline-capturable
actions: **Log Trip** and **Log Fuel**. New `TripLogsLocal`/
`FuelRecordsLocal` Drift tables (schema v4 -> v5), new `SyncModule.fleet`
push/pull routing (`trip_log`/`fuel_record` push, `trip_logs`/
`fuel_records` pull).

Driver is taken from the vehicle's `assignedDriverId` rather than a
driver picker (only one seeded driver — same "hardcode the one option"
simplification as the Sales module's hardcoded order SKU). Fuel capture
has no trip picker (`tripLogId` always null from this screen) — matching
against a specific trip would need a list-trips-for-vehicle endpoint that
doesn't exist client-side; the variance workflow itself is already fully
proven directly against the backend above, and a fuel record with no
trip reference is a legitimate case anyway (e.g. a periodic tank fill-up).

**Proven exactly like every prior slice** — real device, real
kill-the-backend:

1. Vehicles tab correctly showed live server state (10050 km) reflecting
   the curl-based trip logged in step 4 — confirms the tab reads real
   data, not a fixture.
2. **Killed `fleet-service` entirely.** Opened VEH-0001, tapped **Log
   Trip** (start mileage pre-filled from last known mileage), entered an
   end mileage, saved — "Saved locally...". Confirmed directly in the
   device's SQLite file that the `trip_log` outbox row existed with
   `sync_status = 'PENDING'` before the backend ever came back up.
   Repeated for **Log Fuel** — same result, second `PENDING` outbox row.
3. Restarted `fleet-service`, tapped sync. Both outbox rows flipped to
   `ACKED`; confirmed server-side both landed with `created_offline =
   true`.

## Known gaps still open after this pass (Fleet)

- **No driver picker, no trip picker on fuel capture** — see §5 above;
  both are UI scope decisions, not backend limitations (the backend
  endpoints accept any valid `driverId`/`tripLogId`; both variance and
  Scenario #9 code paths are already proven directly).
- **`vehicle_class_fuel_norms` and vehicle/driver master data have no
  CRUD UI anywhere** — seeded directly via SQL, same as every other
  module's master data at this stage (agents, product_skus, suppliers).
- **`maintenance_requests` has no Flutter UI at all** — listing and
  completing a request were only proven via curl. Completion is
  correctly an online-only back-office action by design (mirrors NCR
  verification), but even a read-only "my vehicle's open maintenance"
  view doesn't exist yet.
- **Fuel Card Payable / Employee Expense Payable split is not
  implemented** — the SDD's "or" on the fuel credit account collapses to
  a single deterministic Cash and Bank posting, since `condition_expression`
  is still never evaluated anywhere in this platform (a gap since Slice #1).
- **No fleet dashboard/KPI view** for fuel variance trends across
  vehicles — each variance is investigated individually via
  `maintenance_requests`, but nothing aggregates them into the
  "operational KPI" framing the SDD describes.

# Vertical Slice #6 — HR & Revenue-Based Payroll (2026-08-01)

The fifth of the original 15 PRD/FRS modules (docs/SDD.md §3.F), after
Procurement, Manufacturing, Sales, and Logistics/Fleet — the last one
before Governance is the only original module left unbuilt.

Scope decisions stated up front, same discipline as every prior slice:
`leave_requests` (named in the SDD's data-model list) is NOT built — the
SDD itself says attendance clock-in/out is "the ONLY meaningfully
offline-relevant surface in this module", and leave requests feed neither
the offline-sync pattern nor the revenue-based payroll calculation this
slice exists to prove. `salary_structures` (also named) is implemented as
`salary_grades` (a per-grade `grade_weight`) — a separate fixed-base-
salary table would contradict "revenue-based" payroll, which computes
salary FROM the pool, not from a stored structure.

## 1. Apply migrations + seed data

```
docker compose -f infra/docker-compose.yml exec -T postgres psql -U metrock -d metrock_erp \
  -f infra/postgres/migrations/019_hr_payroll.sql \
  -f infra/postgres/migrations/020_hr_rls_and_role.sql
psql ... -f infra/postgres/seed/hr_payroll_seed.sql
```

Schema: `plants` gains a `payroll_ratio` column (tenant-configurable per
plant, not a new config table — Plant Revenue and the resulting pool are
both plant-scoped); `salary_grades` (per-grade `grade_weight`);
`employees`; `attendance_logs` (the one offline-capturable entity, with
**two independent dedupe layers** — see §2); `payroll_runs` and
`payroll_records` (the calculate/post split — see §2).

Real bug caught and fixed before this ever ran: the first draft of
`attendance_logs.time_bucket` was a `GENERATED ALWAYS AS (date_trunc('hour',
event_time)) STORED` column. Postgres rejected it — `date_trunc(text,
timestamptz)` depends on the session's `TimeZone` setting and so isn't
IMMUTABLE, which a generated column requires. Fixed by making
`time_bucket` a plain column, computed in hr-service (floor to the hour,
in UTC) at insert time instead — no less correct, since hr-service is the
only writer of this table. (Also: cleaning up after the failed first
attempt taught a `psql -c` lesson — multiple semicolon-separated
statements in one `-c` string run as ONE implicit transaction; a later
statement failing rolls back everything earlier in that same call. Fixed
by re-running via separate `-c` invocations instead of one batched
cleanup script.)

RLS + role smoke test, same pattern as every prior module — wrong tenant
-> 0, correct tenant -> row counts. Confirmed before any service code was
written.

## 2. Scaffold hr-service (NestJS, port 3007)

Same `packages/backend-common` pattern. `attendance_logs` has a
`bigserial sync_seq`, so its insert uses raw `$executeRaw`/`$queryRaw`
(not Prisma's typed `.create()`) — same reason as every prior sync-
tracked table; `payroll_runs`/`payroll_records` have no `sync_seq` (no
offline path at all) so Prisma's typed client works fine for those and
was used directly, no raw SQL needed.

**Attendance dedupe has two independent layers**, both in
`AttendanceService.recordAttendance`:
  1. The standard `client_event_id` idempotency check (first, as always).
  2. Matrix Scenario #8's `(employee_id, event_type, time_bucket)` dedupe
     — a genuinely DIFFERENT event (different `client_event_id`,
     different device) representing the same real-world clock-in, e.g. a
     phone and a plant kiosk both firing for one employee. Implemented as
     `INSERT ... ON CONFLICT (tenant_id, employee_id, event_type,
     time_bucket) DO NOTHING RETURNING attendance_log_id` — an empty
     result means the bucket was already claimed, so the handler looks up
     the existing row and returns its ID with a message noting the
     dedupe, still `ACKED` (SDD's framing is "prevents double-counted
     attendance", not "reject the second scan").

**Revenue-Based Payroll** (`PayrollService`) is deliberately split into
two separate, both online-only actions — matching the SDD's explicit
requirement that payroll posting is "online-only, finance-gated... never
executed offline, never eligible for offline queuing":
  - `calculateRun` — Plant Revenue (confirmed `sales_orders` at the plant
    within the period — read directly off sales-service's table, NOT
    derived from `journal_entries`, because `sales.order_fulfilled.v1`
    never carries `plant_id` through to `journal_lines
    .cost_center_plant_id`, which is NULL for every sales-revenue posting
    so far) x Payroll Ratio = Payroll Pool; Payroll Pool x each active
    employee's Grade Weight = their gross/net salary (no statutory
    deduction engine — `total_deductions` is always 0, a real, documented
    gap). One run per (plant, period) — enforced by a UNIQUE constraint,
    surfaced as a clean 400 on retry.
  - `postRun` — the actual `posted_to_books_flag = true` action, online-
    only, mirrors `NcrService.verifyNcr`'s submit-then-verify split
    (Slice #3). Publishes `payroll.run_posted.v1` with
    `net_salary_total` = Σ `payroll_records.net_salary` for the run.

Grade weights are NOT validated to sum to 1.0 across a plant's active
employees — tenant-configurable master data, same "configured, not
enforced" pattern as Fleet's fuel-variance tolerance. A misconfigured set
of weights simply under- or over-allocates the pool.

## 3. Extend ledger-service (Go)

One line in `sourceModuleFor`:
```go
case "payroll.run_posted.v1":
    return "hr"
```
New GL accounts (migration 019): 5340 Salary/Wages Expense (EXPENSE), 2130
Payroll Payable (LIABILITY). Posting rule: `payroll.run_posted.v1` -> Dr
5340 / Cr 2130, amount = `net_salary_total`. Restarted ledger-service the
careful way (killed both the `go run` wrapper and compiled binary PIDs).

## 4. Prove the backend chain — all via curl

Seed data: PLT-1 `payroll_ratio = 0.15`; GRADE_A (Ngozi Adeyemi) weight
`0.6`, GRADE_B (Tunde Bakare) weight `0.3`; PLT-1 had `307500` in
confirmed `sales_orders` for 2026-08 from earlier slices' own testing.

```
curl -X POST localhost:3007/payroll-runs -d '{"plantId":"<plt1>","payrollPeriod":"2026-08"}'
# -> plantRevenue 307500, payrollRatioUsed 0.15, totalPayrollPool 46125
#    (307500 * 0.15) — records: Ngozi grossSalary 27675 (46125*0.6),
#    Tunde grossSalary 13837.5 (46125*0.3). Math confirmed exactly.

# Duplicate run for the same plant+period -> 400 (UNIQUE constraint)

curl -X POST localhost:3007/payroll-runs/<id>/post
# -> netSalaryTotal 41512.5 (27675 + 13837.5)
# Posting the same run again -> 400 (already POSTED)

# confirmed directly in Postgres:
#   source_module='hr': Dr 5340 41512.50 / Cr 2130 41512.50

# Scenario #8: two clock-ins for the same employee, same hour, two
# DIFFERENT clientEventIds (simulating two devices)
curl -X POST localhost:3007/attendance-logs -d '{"employeeId":"<emp>","eventType":"CLOCK_IN"}'
curl -X POST localhost:3007/attendance-logs -d '{"employeeId":"<emp>","eventType":"CLOCK_IN"}'
# -> both ACKED with the SAME serverEntityId; second response says
#    "...deduped, not double-counted (Matrix Scenario #8)."
#    Confirmed only 1 row actually exists in attendance_logs.
```

## 5. Flutter: Employees tab, Clock In/Clock Out

Sixth tab (`_EmployeesTab`), fetched directly online via `ApiClient
.fetchEmployees()`. Employee detail screen exposes the one offline-
capturable HR action: **Clock In** / **Clock Out**. New
`AttendanceLogsLocal` Drift table (schema v5 -> v6), new `SyncModule.hr`
push/pull routing (`attendance_log` push, `attendance_logs` pull).

Unlike every other capture screen in this app, attendance has no form
fields to fill in — just which button was tapped — so `_EmployeeDetail
Screen` calls `AttendanceRepository` directly instead of going through a
Cubit/State pair (nothing to manage beyond a submit-in-flight boolean,
handled with plain `setState`). First deliberate deviation from the
Cubit-per-feature pattern in this app, and a reasoned one: every other
capture screen actually has quantity/price/notes/mileage/litres fields to
track; this one doesn't.

**Proven exactly like every prior slice** — real device, real
kill-the-backend:

1. Employees tab correctly listed both seeded employees with their real
   grade names (Senior Staff / Junior Staff) — confirms live server data,
   not a fixture.
2. **Killed `hr-service` entirely.** Opened Tunde Bakare's detail screen,
   tapped **Clock In** — "Saved locally...". Confirmed directly in the
   device's SQLite file that the `attendance_log` outbox row existed with
   `sync_status = 'PENDING'` before the backend ever came back up.
3. Restarted `hr-service`, tapped sync. Outbox row flipped to `ACKED`;
   confirmed server-side it landed with `created_offline = true`.

## Known gaps still open after this pass (HR & Payroll)

- **`leave_requests` and true `salary_structures` are not built** — see
  this section's opening scope note; both are named in the SDD's data-
  model list but neither is required to prove the offline-capture or
  revenue-based-payroll patterns this slice exists to demonstrate.
- **No statutory deduction engine** — `payroll_records.total_deductions`
  is always 0 (no tax tables, pension, or other withholding logic). A
  real deployment would need this before any real payslip could be cut.
- **Grade weights are not validated to sum to 1.0** — tenant-configurable
  master data, not enforced; a misconfigured set of weights silently
  under- or over-allocates the pool rather than erroring.
- **No employee/attendance CRUD UI** — employees are seeded directly via
  SQL, same as every other module's master data at this stage. There's
  also no UI to view an employee's own attendance history, or a
  supervisor view of clock-in/out records across employees.
- **No payroll run review/approval UI** — `calculateRun` and `postRun`
  were only proven via curl; a real finance user would want a screen
  showing the calculated `payroll_records` before tapping "post."
- **Plant Revenue is read from `sales_orders`, not `journal_entries`** —
  a direct consequence of `sales.order_fulfilled.v1` never carrying
  `plant_id` through to `journal_lines.cost_center_plant_id` (still NULL
  for every sales-revenue posting in this platform). Fixing that gap
  upstream (in sales-service's event payload) would let Plant Revenue be
  derived from the GL itself, which is the more architecturally
  consistent long-term answer.

# Vertical Slice #7 — Governance & Master Data (2026-08-03)

The sixth and final of the original 15 PRD/FRS modules (docs/SDD.md
§3.A). Unlike every prior slice, most of this module's SCHEMA already
existed — `tenant_registry`, `plants`, `warehouses`, `roles`, `users`,
`approval_matrix`, `reason_codes`, and `audit_log` were all created back
in Slice #1 (migrations 002-003) precisely because every other service
has needed them as read-only cross-module master data since day one.
What this slice actually builds is the two things nothing had implemented
yet: an OWNING service for that data, and the two mechanisms the SDD
specifically calls for in §4.2 — hash-chained tamper-evident audit
logging, and posting-authority enforcement with a mandatory audit trail +
alert on any bypass attempt.

Also unlike every prior slice: **no financial trigger, no Kafka producer,
no ledger-service extension, no Flutter offline-capture surface.** SDD
§3.A is explicit on both counts — "Financial Trigger: None directly...
this module supplies the control plane" and "master data is pull-only,
read-cached... never edited offline." governance-service is the first
domain service in this platform with no `KafkaModule` at all.

## 1. Apply migrations + seed data

```
docker compose -f infra/docker-compose.yml exec -T postgres psql -U metrock -d metrock_erp \
  -f infra/postgres/migrations/021_governance_role.sql
psql ... -f infra/postgres/seed/governance_seed.sql
```

The only schema CHANGE (not addition) in this slice: `audit_log` gains a
`chain_seq bigserial` column. `prev_hash`/`record_hash` columns existed
since Slice #1 but nothing had ever written to the table (confirmed 0
rows before this migration) — a deterministic per-insert ordering is
needed to know which row is "previous" when computing a new row's
`prev_hash` and when walking the chain to verify it, and `event_time`
alone isn't safe for that (two inserts in the same millisecond would
tie). Safe to add only because the table was genuinely empty.

`governance_svc` is deliberately the only role in this platform NOT
granted UPDATE on a table it owns — `audit_log` gets SELECT+INSERT only,
on top of the append-only RULEs from migration 003. Belt-and-suspenders:
the RULE already turns any UPDATE/DELETE into a no-op regardless of role,
but not even holding the privilege is a stronger statement about what
this service is allowed to do to its own audit trail.

Seed data reuses the three roles already seeded in Slice #1
(STORES_CLERK: no permissions; PROCUREMENT_MGR: can_approve+can_post;
FINANCE_CONTROLLER: all three) rather than inventing new ones — their
distinct permission combinations turn out to be exactly what's needed to
exercise the authorization-check pattern below. Adds a two-tier
`approval_matrix` (Procurement PO thresholds) and three `reason_codes`
(including `UNAUTHORIZED_POSTING_ATTEMPT`, used automatically, never
user-supplied).

## 2. Scaffold governance-service (NestJS, port 3008)

Same `packages/backend-common` pattern, no `KafkaModule` (first service
without one). CRUD-lite (create+list) for Plants, Warehouses, Roles,
Users, Reason Codes, Approval Matrix — these tables have been read-only
cross-module master data since Slice #1; this is the first time any
service actually WRITES to them.

**Hash-chained audit log** (`AuditService`) — every row's `record_hash`
commits to its own content AND the previous row's hash, so altering any
historical row breaks every subsequent link. `verifyChain` recomputes the
whole chain from scratch and compares against each stored hash — this is
the actual tamper-evidence check, not just a read.

**A real bug, found and fixed during this pass, not hypothetical**: the
first version of `verifyChain` failed on the very first row ever
inserted — `record_hash does not match recomputed hash of this record's
content`. Root cause: `old_value_snapshot`/`new_value_snapshot` are
stored as Postgres `jsonb`, which does **not** preserve original key
order — its binary storage format reorders top-level object keys by
`(length, then lexicographic)` when read back. Confirmed directly:
```sql
SELECT new_value_snapshot::text FROM audit_log WHERE chain_seq=1;
-- inserted as {"requiredPermission":..., "roleCode":..., "result":...}
-- read back as  {"result":..., "roleCode":..., "requiredPermission":...}
```
So the hash computed at insert time (from the pre-jsonb-round-trip
object) could never match the hash recomputed at verify time (from the
jsonb-reordered object read back from Postgres) — a structural
mismatch, not tampering. Fixed with a `canonicalize()` helper
(recursively sorts object keys before `JSON.stringify`) applied
identically on both the insert-time hash and the verify-time
recomputation, so the hash depends only on content, never on incidental
key order. Lesson worth generalizing: prefer plain `json` over `jsonb`
(or canonicalize explicitly) for any column whose exact serialized bytes
need to round-trip identically, e.g. anything feeding a hash or
signature — `jsonb`'s normalization is a feature for querying/indexing
and a hazard for exactly this use case.

**Posting-authority enforcement** (`AuthorizationService`, SDD §4.2's
"Governance warning") — given a user and a required permission
(`can_approve`/`can_post`/`can_override`), correctly authorizes a role
that has it, and correctly DENIES + AUDITS (with `override_flag = true`
and `reason_code = 'UNAUTHORIZED_POSTING_ATTEMPT'`, never silently) + logs
an "ALERT:"-prefixed line (this platform's stand-in for a real alerting
pipeline — no email/Slack/pager integration exists anywhere, same kind of
documented stub as `TenantContextMiddleware` standing in for Keycloak) +
throws 403, for a role that doesn't. This is the one place in the whole
platform that check is actually implemented — the other seven domain
services' posting endpoints do NOT call it before posting; retrofitting
that is real, out-of-scope work (see "Known gaps"), not something this
slice assumes is already true elsewhere.

## 3. Prove the backend chain — all via curl

```
curl -X POST localhost:3008/authorization-check -d '{
  "userId": "<stores-clerk>", "requiredPermission": "can_post",
  "moduleName": "PROCUREMENT", "recordIdRef": "PO-TEST-001"
}'
# -> HTTP 403; server log shows "ALERT: user=... role=STORES_CLERK
#    attempted can_post ... without authority — audited with override_flag=true"

curl -X POST localhost:3008/authorization-check -d '{
  "userId": "<procurement-mgr>", "requiredPermission": "can_post", ...
}'
# -> {"authorized": true, "roleCode": "PROCUREMENT_MGR"}

curl localhost:3008/audit-log/verify
# -> {"valid": true, "totalRecords": 2}   (after the canonicalize fix)
```

**Proved the append-only guarantee is real, not assumed** — attempted a
direct `UPDATE audit_log SET reason_code = 'TAMPERED' ...` as the
`metrock` superuser itself: `UPDATE 0`, row unchanged. The RULE from
migration 003 intercepts UPDATE regardless of role, superuser included.

**Proved `verifyChain` actually detects corruption, not just echoes
`valid: true`** — inserted a row directly via SQL with a deliberately
wrong `prev_hash` (bypassing the service entirely, simulating what a
schema-level tamper attempt would look like): `verify` correctly returned
`{"valid": false, "reason": "prev_hash does not match the preceding
record's record_hash", ...}`. Since `audit_log` truly cannot be
UPDATE/DELETEd, cleaned this up the only way possible — `TRUNCATE` (not
blocked by the RULE, which only intercepts UPDATE/DELETE) — and re-ran
the two legitimate authorization-check calls to leave a real, valid,
inspectable chain behind rather than a poisoned one.

## 4. Flutter: Users tab (read-only)

Seventh tab (`_UsersTab`), fetched directly online via `ApiClient
.fetchUsers()`. Tapping a user shows their role's SDD §4.2 permission
flags (`can_approve`/`can_post`/`can_override`) — the same flags
`AuthorizationService` checks server-side. **No capture screen, no Drift
table, no `SyncModule` entry at all** — the first tab in this app that is
purely read-only by design, not "no offline cache yet." SDD §3.A's
Offline Strategy is explicit that governance master data is pull-only,
read-cached, never edited offline; there is nothing to push or pull for
this module, so nothing was built to push or pull.

## Known gaps still open after this pass (Governance)

- ~~Posting-authority enforcement isn't retrofitted into the other seven
  domain services~~ **Resolved 2026-08-04** — see "Posting-authority
  retrofit" section below for the six online-only endpoints now gated
  and the full verification trail. GRN, batch close, sales order
  creation, and fuel/trip/attendance capture remain deliberately
  ungated (offline field capture, not finalization/posting).
- **`approval_matrix` thresholds are configured but not enforced** —
  seeded, queryable, real data, but no service actually routes a
  transaction through approval-level checks based on it yet.
- **Tenant provisioning is out of scope** — `tenant_registry` is
  read-only from governance-service; tenants are still seeded directly,
  same as every environment so far.
- **No Keycloak integration** — `users.keycloak_subject_id` exists as a
  column but nothing populates or validates it; auth is still the
  `TenantContextMiddleware` stub documented since Slice #1.
- **No real alerting pipeline** — the "raise a real-time alert"
  requirement (SDD §4.2) is a structured log line, not an actual
  email/Slack/pager integration. Swapping it for one is a single-method
  change in `AuthorizationService`.

# Posting-authority retrofit

`governance-service`'s `AuthorizationService.checkAuthority` (Slice #8)
was proven in isolation but not called from anywhere else. This pass wires
it into the six ONLINE-ONLY finalization/posting endpoints — NCR verify
(sales-service), vendor-bill payment + customer-invoice payment + manual
journal entry (accounting-service), maintenance-request completion
(fleet-service), and payroll-run posting (hr-service) — deliberately NOT
into GRN receipt, batch close, sales order creation, or fuel/trip/
attendance capture, which are offline-capturable field actions performed
by operational staff who legitimately hold no `can_post` authority.
Gating those would require a synchronous online call mid-offline-capture,
contradicting the offline-first design and breaking the already-verified
capture flows tested against the same `STORES_CLERK` seed user.

## 1. Shared client: `PostingAuthorityClient` (`packages/backend-common`)

The platform's first synchronous service-to-service call — every prior
cross-service interaction was either a direct read-only DB query or an
async Kafka event, but an authorization decision has to be made and
audited before the caller's own posting transaction proceeds; there's no
sensible way to make that eventually-consistent. Built on Node 20's global
`fetch`, no new dependency. `checkAuthority(...)` either returns (caller
may proceed) or throws — a 403 from governance-service becomes a
`ForbiddenException`, and an unreachable governance-service becomes a
`ServiceUnavailableException` — fail-**closed** either way, never a
silent proceed.

Wired into each of the four consuming services the same way `KafkaModule`
already was: a `@Global()` `GovernanceModule` in `src/common/`, a
`GOVERNANCE_BASE_URL` env var (default `http://localhost:3008`), imported
once in `app.module.ts`.

`governance-service`'s `CheckPostingAuthorityDto.userId` was hardened to
`@IsOptional()` — a caller with no identity at all (no `x-user-id`
header) must resolve to a real denial, not a validation error, since "no
identity" is itself the bypass-attempt scenario SDD §4.2 describes.
`AuthorizationService.checkAuthority` treats a missing/unknown userId
exactly like a real denial: DENIED, audited (`user_id` NULL,
`override_flag = true`, `reason_code = 'UNAUTHORIZED_POSTING_ATTEMPT'`),
and alerted.

**Local `file:` dependency gotcha, again** — after rebuilding
`backend-common`, `npm install` in a consuming service did NOT pick up
the new `posting-authority.client.js` file (stale `install-links=true`
copy from before the file existed). Fixed by removing
`node_modules/@metrock/backend-common` and re-running `npm install` in
each of the four services — a fresh copy, not an incremental one, is
required when a *new file* (not just changed content in an existing one)
is added to a local `file:` dependency.

## 2. Prove the backend chain — all via curl, all six endpoints

Seed data: `STORES_CLERK` (Amaka Obi, `can_post=false`) and
`PROCUREMENT_MGR` (Chidinma Eze, `can_post=true`), same two users every
prior slice's capital/authority gate tests have used. Three scenarios per
endpoint — denied, missing `x-user-id`, authorized — run in that order
specifically *because* `checkAuthority` runs before each service's own
posting transaction, so a denied/missing attempt never mutates the
underlying record and it stays available for the next scenario.

```
# NCR verify (sales-service :3003)
POST /ncr-collections/:ncrId/verify
  clerk  -> 403 "lacks can_post authority for SALES"
  none   -> 403 "User UNKNOWN (role none) lacks can_post authority for SALES"
  mgr    -> 201 {"ncrId":"...","verified":true}

# Vendor-bill payment (accounting-service :3004)
POST /vendor-bills/:billId/payments
  clerk -> 403 / none -> 403 / mgr -> 201 (bill PARTIALLY_PAID)

# Customer-invoice payment (accounting-service :3004)
POST /customer-invoices/:invoiceId/payments
  clerk -> 403 / none -> 403 / mgr -> 201 (invoice PARTIALLY_PAID)

# Manual journal entry (accounting-service :3004)
POST /journal-entries
  clerk -> 403 / none -> 403 / mgr -> 201 (balanced entry POSTED)

# Maintenance-request completion (fleet-service :3006)
POST /maintenance-requests/:id/complete
  clerk -> 403 / none -> 403 / mgr -> 201 {"completed":true,...}

# Payroll-run posting (hr-service :3007)
POST /payroll-runs/:id/post
  clerk -> 403 / none -> 403 / mgr -> 201 {"posted":true,...}
```

All 18 calls (6 endpoints × 3 scenarios) matched expectations exactly.

**Audit trail checked directly, not just inferred from the HTTP response**
— `SELECT ... FROM audit_log WHERE action_type IN
('POSTING_AUTHORITY_DENIED','AUTHORIZATION_CHECK')` for this run's rows
confirmed: every denial has `override_flag = true` and `reason_code =
'UNAUTHORIZED_POSTING_ATTEMPT'`; the missing-userId denials have `user_id
IS NULL` specifically (not the string `"UNKNOWN"` — that's only in the
log line and exception message); every authorized check has
`override_flag = false` and no `reason_code`. `GET /audit-log/verify`
afterward: `{"valid": true, "totalRecords": 23}` — the hash chain absorbed
all of today's rows without breaking.

**Proved fail-closed for real, not just by reading the code** — killed
governance-service, then attempted an authorized (`can_post=true`)
vendor-bill payment against a still-OPEN bill: `503 "Posting-authority
check unavailable — governance-service unreachable"`. Confirmed via SQL
that the bill's `amount_paid`/`bill_status` were untouched — an
authorized user got blocked anyway, and no partial state was left behind,
because the check runs and throws before the domain transaction ever
opens. Restarted governance-service and the same request then succeeded
normally.

## Known gaps still open after this pass (Posting-authority retrofit)

- **GRN receipt, batch close, sales order creation, and fuel/trip/
  attendance capture remain ungated** — by design, not an oversight; see
  this section's intro and the README "Known gaps" entry for the
  offline-first reasoning.
- **No circuit breaker, retry, or explicit timeout** on
  `PostingAuthorityClient`'s `fetch` call — a slow (not just down)
  governance-service will make every gated endpoint slow with it.
  Acceptable for six endpoints in one dev environment; a production
  deployment would want this hardened, or handled by a real API Gateway
  instead of direct service-to-service calls.
- **`approval_matrix` thresholds still aren't enforced** — this retrofit
  only wires the binary `can_post`/`can_approve`/`can_override` check;
  amount-based approval routing is unrelated, still-open work (unchanged
  from the Governance slice's own "Known gaps").

# Keycloak auth retrofit — Phase 1 (governance-service pilot)

`TenantContextMiddleware`'s stub (`x-tenant-id`/`x-user-id`/`x-role-code`
headers, trusted with zero verification) has been the platform's auth
story since Slice #1. This phase replaces it with real Keycloak-issued,
JWKS-verified JWTs — but ONLY for governance-service, proving the pattern
before repeating it six more times. Scoped in four phases (agreed before
starting): **Phase 1** = infra + governance-service pilot (this section).
**Phase 2** = mechanical swap into the other 7 services. **Phase 3** =
Flutter mobile via Authorization Code + PKCE. **Phase 4** = docs cleanup +
drop the now-dead `roleCode`/`x-role-code` field (confirmed by grep before
starting: no authorization logic anywhere reads it — `AuthorizationService`
always re-resolves role by a DB join from `userId`).

## 1. Infra: self-hosted Keycloak + realm config

`infra/docker-compose.yml` gains a `keycloak` service
(`quay.io/keycloak/keycloak:26.0`, `start-dev --import-realm`, admin/admin
— dev-only). `infra/keycloak/realm-export.json` defines:

- Realm `metrock`, a custom `tenant` client scope (default on every
  client) mapping the `tenant_id` user attribute onto issued tokens.
- `metrock-test-client`: public, Direct Access Grants only — for
  curl-minted dev/test tokens. Explicitly NOT the real mobile client;
  Phase 3's client uses PKCE instead.
- `components.org.keycloak.userprofile.UserProfileProvider` with
  `unmanagedAttributePolicy: ENABLED`.

**Two real Keycloak gotchas hit and fixed while building this, both
invisible until a token was actually minted and decoded — the admin API
returned 201/204 success in every case, no error surfaced either time:**

1. **Declarative User Profile silently drops undeclared attributes.**
   Keycloak 24+ realms only persist user attributes declared in the
   realm's User Profile schema (`username`/`email`/`firstName`/
   `lastName` by default) — `attributes: {"tenant_id": [...]}` in a
   create-user call returns `201 Created` and is silently discarded.
   Fixed by setting `unmanagedAttributePolicy: ENABLED` on the realm's
   User Profile config. Found by minting a token and decoding it: no
   `tenant_id` claim, despite the mapper being configured correctly and
   the create call having "succeeded."
2. **A raw realm-JSON import doesn't create Keycloak's own built-in
   client scopes** (`profile`/`email`/`roles`/`basic` — normally created
   by the "New realm" wizard, not by a partial JSON import). One
   consequence: the ACCESS token lacked `sub` even though the ID token
   had it (ID token generation sets `sub` unconditionally; the access
   token's `sub` normally comes via the built-in `basic` scope's mapper,
   which didn't exist here). Fixed with an explicit
   `oidc-usermodel-property-mapper` (`user.attribute: "id"` →
   `claim.name: "sub"`) added to our own custom `tenant` scope, rather
   than trying to hand-reconstruct all of Keycloak's built-in scopes.

Also hit and fixed: `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD` are
deprecated in Keycloak 26 in favor of `KC_BOOTSTRAP_ADMIN_USERNAME`/
`KC_BOOTSTRAP_ADMIN_PASSWORD` — cosmetic (old names still worked, just
logged a warning) but fixed for a clean boot log.

**Proof the realm file is genuinely self-sufficient, not just "worked
after live patching":** after fixing both issues via the Admin REST API
directly against a running container (to confirm the fix before
committing to it), the container was fully torn down and recreated from
a `realm-export.json` with both fixes baked in — a clean `docker compose
up` reproduced a fully working realm, with no manual API calls, before
`seed-users.sh` ran even once.

## 2. `infra/keycloak/seed-users.sh`

Creates one Keycloak user per existing Postgres `users` row (matched by
email, idempotent — safe to re-run), sets the `tenant_id` attribute and a
dev password, and writes the resulting Keycloak user id back into
`users.keycloak_subject_id` — the column the schema has carried unused
since migration `003_governance.sql`. Run against the two existing
Slice #1/#4 seed users (`amaka.obi@metrock.dev` / `STORES_CLERK` /
`can_post=false`, `chidinma.eze@metrock.dev` / `PROCUREMENT_MGR` /
`can_post=true`) — same two users every prior slice's capital/authority
gate tests have used, now with real Keycloak identities layered on top
of the same local role data.

## 3. `packages/backend-common`'s `verifyKeycloakToken`

Built on `jsonwebtoken` + `jwks-rsa`, deliberately NOT `jose` — every
backend service in this monorepo compiles to CommonJS
(`tsconfig.json`'s `"module": "commonjs"`), and `jose`'s ESM-only
packaging in recent major versions would break under a plain `require()`.
Verifies the token's RS256 signature against the realm's JWKS endpoint
(cached by `jwks-rsa`, not fetched per-request), checks `iss`, and
extracts `tenant_id` + `sub` — throwing `UnauthorizedException` on any
failure (malformed token, bad signature, wrong issuer, expired, missing
claims). Rebuilding this package after adding new dependencies surfaced
the `install-links=true` gotcha again, one level deeper than before: a
plain `npm install` in a consuming service did NOT pick up
`backend-common`'s own new dependencies (`jsonwebtoken`/`jwks-rsa`), only
its new source files. Fixed by deleting the consuming service's
`node_modules` AND `package-lock.json` (not just
`node_modules/@metrock/backend-common` — that alone wasn't enough this
time) and reinstalling from scratch, then re-running `prisma generate`
(wiped along with the rest of `node_modules`).

## 4. `KeycloakAuthMiddleware` (governance-service only)

`backend/governance-service/src/common/keycloak-auth.middleware.ts`
verifies the Bearer token, then resolves the JWT's `sub` to this
tenant's LOCAL `users.user_id` via `keycloak_subject_id` (a
tenant-scoped `forTenant` lookup — the same pattern
`AuthorizationService.checkAuthority` already used). Populates the same
`TenantContext` shape `@CurrentTenant()` always returned, so every
existing controller needed zero changes. A verified token with no
matching local user row does NOT get rejected — `tenantId` is already
trustworthy from the signed claim, and `userId` resolving to `undefined`
is exactly the "no identity" case `checkAuthority` already treats as an
automatic, audited denial wherever a posting-authority check actually
gates on it.

**Real regression caught before it shipped**: applying this middleware to
`forRoutes('*')` would have broken the already-completed posting-authority
retrofit — `/authorization-check` is called by the OTHER six services'
`PostingAuthorityClient` with a plain `x-tenant-id` header (service-to-
service, no user Bearer token involved), and requiring Keycloak auth on
that route returned a 401 the instant it was tested end-to-end through
sales-service's real NCR-verify call. Fixed with
`consumer.apply(TenantContextMiddleware).forRoutes('authorization-check')`
+ `consumer.apply(KeycloakAuthMiddleware).exclude('authorization-check')`
— `/authorization-check` deliberately keeps the header stub (a separate,
out-of-scope machine-to-machine auth story), every other route on this
service gets the real thing.

## 5. Verification — all via curl, real Keycloak-issued tokens

```
# Real token, real Bearer auth — tenant-scoped read succeeds
GET /users  Authorization: Bearer <Amaka's real token>
  -> 200, returns this tenant's 2 users

# No token at all
GET /users
  -> 401 "Missing Authorization: Bearer <token>"

# Tampered signature (last char of the token flipped)
GET /users  Authorization: Bearer <tampered>
  -> 401 "Invalid bearer token: invalid signature"

# Expired token (client's access-token lifespan set to 2s for this test,
# reset to default immediately after)
GET /users  Authorization: Bearer <expired>
  -> 401 "Invalid bearer token: jwt expired"

# Spoofed x-tenant-id header ALONGSIDE a valid real Bearer token — the
# header is now completely inert; the JWT's own tenant_id claim wins
GET /users  Authorization: Bearer <valid>  x-tenant-id: 00000000-...
  -> 200, still returns the TOKEN's real tenant's data, not the spoofed one

# Old-style header-only auth (no Bearer at all) — now dead on every
# route except the one deliberately excluded
GET /users  x-tenant-id: <real tenant>
  -> 401 (correctly rejected — the exclusion is scoped to
     /authorization-check only, not a blanket reopening)
```

Then the full `/authorization-check` three-scenario matrix (denied /
missing-userId / authorized) was re-run with the CALLING request itself
authenticated by a real Bearer token instead of the old headers, followed
by a real end-to-end proof through the actual cross-service path — not
just a simulated curl — by submitting a fresh NCR via sales-service and
verifying it, exercising the full sales-service → `PostingAuthorityClient`
→ governance-service chain post-fix. `GET /audit-log/verify` afterward:
`{"valid": true, "totalRecords": 29}` — hash chain intact through the
entire session's testing.

## Known gaps still open after this pass (Keycloak auth retrofit, Phase 1)

- ~~7 of 8 backend services still use the header stub~~ **Resolved** —
  see "Keycloak auth retrofit — Phase 2" below.
- **No Flutter mobile integration yet** — Phase 3. The mobile app still
  sends plain `x-tenant-id`/`x-user-id`/`x-device-id` headers
  (`apps/mobile/lib/core/sync/api_client.dart`).
- **No machine-to-machine auth for service-to-service calls** —
  `/authorization-check` (and any future internal-only endpoint) still
  trusts a plain header from a caller assumed to be another backend
  service on the same trusted network. A real deployment would want a
  client-credentials grant (one Keycloak client per calling service)
  instead of trusting an unauthenticated header, even internally.
- **No self-service signup, password reset, or MFA rollout** —
  provisioning stays `seed-users.sh`-driven, matching every other
  master-data table in this platform. `users.mfa_enabled` still exists
  but nothing reads it.
- **Dev password (`DevPassw0rd!`) is shared across all seeded users and
  committed in a script default** — fine for a local dev realm nobody
  else can reach, would need to change for anything shared.

# Keycloak auth retrofit — Phase 2 (the other 7 services)

Phase 1 proved the pattern on governance-service alone. This phase rolls
`KeycloakAuthMiddleware` out to procurement/manufacturing/sales/
accounting/crm/fleet/hr-service — the mechanical-sounding part of the
retrofit that turned out to need the same care as Phase 1's one
exclusion, just multiplied.

## 0. A regression Phase 1 actually shipped, caught before Phase 2 could repeat it

Auditing every service's real mobile dependency (see §1 below) surfaced
that Phase 1's blanket `KeycloakAuthMiddleware.forRoutes('*')` on
governance-service had ALREADY broken the Flutter app's read-only Users
tab — `apps/mobile/lib/core/sync/api_client.dart`'s `fetchUsers()` calls
`GET /users` with the old header stub, and nothing in Phase 1's own
testing exercised that path (it tested curl-based auth and the
cross-service posting-authority chain, never the mobile app itself).
Fixed by adding `{ path: 'users', method: RequestMethod.GET }` to
governance-service's stub-middleware exclusion, alongside
`authorization-check` — `POST /users` (never called by mobile) keeps
real Keycloak auth. This is the exact reason Phase 2 started with a full
routes-vs-mobile-callers audit instead of repeating the same class of
mistake seven more times.

## 1. Mapping every service's actual mobile dependency, not assuming it

`apps/mobile/lib/core/sync/api_client.dart` is the app's ENTIRE HTTP
surface — exactly 9 methods, no more: 7 read-only master-data fetches
(one per module: `fetchPurchaseOrders`, `fetchRecipes`, `fetchAgents`,
`fetchCustomers`, `fetchVehicles`, `fetchEmployees`, `fetchUsers`) plus
`syncPush`/`syncPull`. Every offline-capturable domain action
(GRN receipt, production batch, sales order, NCR, activity, trip log,
fuel record, attendance log) is dispatched through `/sync/push`'s
`entityType` routing — confirmed by grepping every service's
`sync.service.ts` for its dispatch table, not assumed from the
architecture pattern. This means each domain controller's OWN direct
POST route (e.g. `POST /goods-receipts`, `POST /ncr-collections`) is
curl/dev-testing-only — the real mobile app never calls it — so gating
those with real Keycloak auth doesn't touch mobile at all.

Net result: exactly one GET list route plus `/sync/push` + `/sync/pull`
per service must stay on the stub; everything else — including every
route this platform's posting-authority retrofit already gates — gets
real Keycloak auth. `accounting-service` has no `SyncModule` and no
mobile-called route at all (matches its pre-existing "no Flutter UI"
known gap), so it needed zero exclusions — the one genuinely mechanical
case of the seven.

## 2. A second design gap: only governance-service owns `users`

Porting governance-service's `KeycloakAuthMiddleware` (DB lookup by
`keycloak_subject_id`) verbatim doesn't work for the other 7 — grep
confirmed none of their Postgres roles have any GRANT on `users` at all,
and `accounting-service`'s own `schema.prisma` has no `User` model
whatsoever. Adding a DB grant + Prisma model to 6 services just to
answer "who is this" would have been real scope creep for what should be
a middleware swap.

Fixed by extending the JWT itself: a second custom claim,
`local_user_id`, added via a new protocol mapper on the realm's `tenant`
client scope, sourced from a new Keycloak user attribute set once by
`seed-users.sh` (mirroring exactly how `tenant_id` already works) — not
resolved per-request. This makes `packages/backend-common`'s new
`KeycloakAuthMiddleware` fully dependency-free (no constructor
injection, unlike governance-service's DB-backed version), so it's one
truly shared class rather than a bespoke file duplicated into 7
services. governance-service's own existing, already-shipped,
already-tested DB-lookup middleware was left untouched — no reason to
add risk to working code for a consistency win with no functional
benefit this pass.

**Backfilling existing users hit the exact same landmine as Phase 1**:
existing Keycloak users (Amaka, Chidinma, seeded in Phase 1) needed
`local_user_id` added retroactively. `seed-users.sh` now fetches the
FULL existing user representation, merges the new attribute in, and PUTs
the complete object back — never a partial `{"attributes": ...}` PUT,
which (as Phase 1 discovered) silently wipes every field Keycloak
doesn't see in the request body.

**Keycloak's `--import-realm` does NOT re-import an already-existing
realm on a plain container restart** (`docker compose restart`) —
logged `Realm 'metrock' already exists. Import skipped` instead of the
`OVERWRITE_EXISTING` strategy a fresh container CREATE uses. The new
`local-user-id-mapper` protocol mapper was added directly via the Admin
REST API to the live realm instead (and is already baked into
`realm-export.json` for the next clean install) — same "live-patch, then
make sure the exported file matches" pattern Phase 1 established.

## 3. A NestJS route-matching gotcha: wildcard exclusions silently no-op

The first attempt at excluding a service's sync routes used
`exclude('purchase-orders', 'sync/(.*)')` — copying a regex-group
pattern that seemed like the obvious way to match both `/sync/push` and
`/sync/pull` in one entry. It compiled fine and threw no error, but
`GET /sync/pull` came back `{"message":"Tenant context not resolved"}`
instead of either succeeding (stub) or clearly failing (real auth) —
neither middleware was actually running on that route: the string
`'sync/(.*)'` was being matched (or not) as something other than what
was intended, for both the inclusion AND exclusion sides. Fixed by
listing the two real routes explicitly — `'sync/push'`, `'sync/pull'` —
which is unambiguous and matches exactly the literal-string pattern that
already worked correctly for governance-service's `'authorization-check'`
exclusion. Applied consistently across all 6 remaining services rather
than debugging path-to-regexp version behavior further.

## 4. Method-precise exclusion where a path serves both reads and writes

`crm-service`'s `/customers` has both `@Get()` (mobile's `fetchCustomers`)
and `@Post()` (never called by mobile) at the same literal path — a bare
string exclusion would have left the CREATE mutation on the header stub
too, for no reason. Used `{ path: 'customers', method: RequestMethod.GET }`
instead, verified precisely: `GET /customers` works via the old header,
`POST /customers` requires (and correctly accepts) a real Bearer token.

## 5. Verification — every service, both categories of route

For each of the 7 services: confirmed the excluded mobile-facing routes
(the one GET list + `/sync/push` + `/sync/pull`) still work with the OLD
`x-tenant-id`/`x-device-id` headers exactly as before, and confirmed
every OTHER route now rejects a request with no Bearer token and accepts
one with a real Keycloak-issued token. Then re-ran the full posting-
authority six-endpoint verification (NCR verify, vendor-bill payment,
customer-invoice payment, manual journal entry, maintenance-request
completion, payroll-run posting) end-to-end with real Bearer tokens
authenticating the HTTP call itself (replacing the old
`x-tenant-id`/`x-user-id` headers from that retrofit's original
verification pass) — all six denied/authorized correctly, proving
`local_user_id` threads all the way from the JWT through
`PostingAuthorityClient` to governance-service's role resolution. Two of
the six (customer-invoice payment, manual journal entry) were verified
directly against accounting-service; the rest went through their real
owning service (sales/fleet/hr), not simulated.

`GET /audit-log/verify` afterward: `{"valid": true, "totalRecords": 41}`
— hash chain intact through this entire pass, on top of everything
Phase 1 had already written.

## Known gaps still open after this pass (Keycloak auth retrofit, Phase 2)

- ~~No Flutter mobile integration yet~~ **Resolved** — see "Keycloak auth
  retrofit — Phase 3" below.
- **No machine-to-machine auth** — `/authorization-check` still trusts a
  plain header from a caller assumed to be another backend service on
  the same trusted network, unchanged from Phase 1's gap list.
- **`roleCode`/`x-role-code` is still a dead field** — confirmed unused
  by grep before Phase 1 even started; dropping it is Phase 4 cleanup,
  still not done.
- **Curl/dev-testing-only direct capture routes now require a real
  token where they previously didn't** (`POST /goods-receipts`,
  `/production-batches`, `/sales-orders`, `/ncr-collections`,
  `/activities`, `/trip-logs`, `/fuel-records`, `/attendance-logs`) —
  intentional, not a gap, but worth noting for anyone who scripted curl
  verification against these directly in earlier RUNBOOK sections: those
  exact commands now need `Authorization: Bearer <token>` instead of
  `x-tenant-id`/`x-user-id`.

# Keycloak auth retrofit — Phase 3 (Flutter mobile via PKCE)

Phases 1-2 got every backend service onto real Keycloak JWTs, but the
Flutter mobile app itself (`apps/mobile`) still had no concept of a
signed-in user at all — `main.dart` never even passed a `userId` to any
`ApiClient` (confirmed by grep before starting: only `tenantId`/`deviceId`
were ever set), which is *why* every online-only posting-authority-gated
action in this platform has "no Flutter UI" as a documented known gap —
there was no identity for a capture screen to act as. This phase gives
the app a real login.

## 1. `metrock-mobile` Keycloak client

`infra/keycloak/realm-export.json` gains a second client alongside
`metrock-test-client`: `publicClient: true`, `standardFlowEnabled: true`,
`directAccessGrantsEnabled: false` (PKCE only, never password grant),
`pkce.code.challenge.method: S256`, redirect URI
`com.metrock.metrockMobile:/oauth2redirect` (matching the app's actual
iOS bundle id, registered as a custom URL scheme in
`ios/Runner/Info.plist`'s `CFBundleURLTypes` — Android's equivalent
`appAuthRedirectScheme` manifest placeholder is wired in
`android/app/build.gradle.kts` for correctness but not tested on an
emulator this pass, since the iOS Simulator has been this project's
established testing surface since Slice #1). `offline_access` is
requested as an optional scope so the refresh token Keycloak issues is
long-lived and revocable — the right shape for a native app that should
stay signed in across restarts, not tied to a short browser-SSO session.

## 2. `AuthClient` (`apps/mobile/lib/core/auth/auth_client.dart`)

Wraps `flutter_appauth`'s `authorizeAndExchangeCode` (login),
`endSession` (logout), and `token` with `refreshToken` (silent refresh),
storing access/refresh/id tokens in `flutter_secure_storage` (platform
keychain/keystore) rather than plain prefs. `getValidAccessToken()` is
what every `ApiClient` call awaits before attaching its Authorization
header — it only actually calls out to Keycloak when the current token
is within 30 seconds of expiry, so it's not a network round-trip on
every request.

**Deliberate design choice, not an oversight**: a refresh that fails
because the device is offline (or the realm is briefly unreachable)
rethrows the underlying exception and does NOT clear the session or log
the user out — going offline must never be indistinguishable from being
signed out. Only a genuine `invalid_grant` from the server (the refresh
token itself rejected — revoked, or expired past its own lifetime) clears
the stored session and forces a real re-login. This mirrors the same
"network failure ≠ auth failure" principle `PostingAuthorityClient`
already established server-side in the posting-authority retrofit.

## 3. `ApiClient` redesign

`tenantId` and `userId` constructor params are gone entirely — both now
live inside the JWT as claims and the backend derives them server-side,
so the client never manages either. `deviceId` stays a plain header
(`x-device-id`) — it's a per-install sync-idempotency correlation id, not
an identity credential, so it never needed to move into the token. Every
method builds its headers via `await auth.getValidAccessToken()` instead
of a synchronous getter.

## 4. A real bug caught before it could ship: unauthenticated background sync

Wiring `AuthClient` into `main.dart` and rebuilding surfaced an unhandled
`Bad state: Not logged in` exception at app launch, thrown from
`SyncService`'s connectivity-triggered `syncNow()` — `main.dart` called
`_sync.startWatchingConnectivity()` unconditionally in `initState()`,
before `restoreSession()` even resolved, and connectivity can regain (or
already be present) before any session exists. Fixed two ways, both
belt-and-suspenders: `SyncService` gained `stopWatchingConnectivity()`
and made `startWatchingConnectivity()` idempotent, and `main.dart` now
starts/stops watching from inside its `authStateChanges` listener instead
of unconditionally — so a sync attempt can never fire without a session
backing it. `syncNow()` itself also gained a top-level `catch` (previously
absent) since both its callers (the connectivity listener and the manual
"Sync now" button) invoke it unawaited/fire-and-forget with no error
handling of their own — any exception escaping it, including a mid-sync
`invalid_grant`, would otherwise crash as an unhandled Future rejection.

## 5. Verified end-to-end on the iOS Simulator, not just unit-level

Built and ran the real app (`flutter run`, not just `flutter analyze`)
against the booted simulator:

- Login screen renders; tapping "Sign In" launches the real system
  browser (`ASWebAuthenticationSession`/`SafariViewService` — confirmed
  via `xcrun simctl ... log show`, not assumed) showing Keycloak's own
  hosted login page for the `metrock` realm.
- Signed in as `chidinma.eze@metrock.dev` / the seeded dev password —
  real credentials against the real realm, not a mock.
- App landed on the tab UI; Purchase Orders loaded real data using a
  genuine Bearer token (no `x-tenant-id` header sent at all anymore).
- **Killed procurement-service** (same "kill the backend" proof every
  prior vertical slice has used) and captured a GRN — "Saved locally.
  Will sync automatically once connected" — offline capture is
  completely unaffected by any of this, exactly as designed, since Drift
  writes never touch the network.
- Restarted procurement-service, triggered sync, and confirmed via SQL
  that the offline-captured GRN (`GRN-OFFLINE-e560d7bf`) actually landed
  server-side through `/sync/push` authenticated by a real Bearer token.
- Tapped "Sign out" — triggered Keycloak's real end-session flow (its
  own consent screen, same as login) and returned cleanly to the login
  screen.
- Relaunched the app cold: `restoreSession()` found the persisted tokens
  in secure storage and skipped straight to the tab UI with no re-login
  needed, then correctly returned to the login screen after logout in a
  separate run.

## 6. The blocking discovery: Phase 2's exclusions had to come out immediately, not later

The very first real login attempt hit `ApiException(401):
"Missing x-tenant-id header (stub auth)"` on the Purchase Orders tab.
This wasn't a bug in the login flow — it's the direct, entirely
predictable consequence of `ApiClient` no longer sending `x-tenant-id`
at all once it has a real token, hitting the Phase 2 routes that were
deliberately left on the OLD header stub (one GET list + `/sync/push`/
`/sync/pull` per service) because mobile didn't have a real token yet.
The moment mobile HAS one, those routes become unreachable BY mobile,
which meant retiring the Phase 2 exclusions wasn't the "nice-to-have
final cleanup" it was originally scoped as — it was a hard blocker on
finishing this section's own verification. Removed the exclusion from
all 7 services in one pass (`consumer.apply(KeycloakAuthMiddleware)
.forRoutes('*')`, no `.exclude()`), rebuilt, restarted, and confirmed via
curl that the old header now fails everywhere except
governance-service's `/authorization-check` (deliberately permanent —
service-to-service, unrelated to mobile) before returning to finish the
simulator verification above.

## Known gaps still open after this pass (Keycloak auth retrofit, Phase 3)

- ~~`roleCode`/`x-role-code` is still a dead field~~ **Resolved** — see
  "Keycloak auth retrofit — Phase 4" below.
- **No machine-to-machine auth** — `/authorization-check` still trusts a
  plain header from a caller assumed to be another backend service on
  the same trusted network, unchanged since Phase 1. Permanent, not
  scheduled for any phase — see Phase 4's own gap list below.
- **Android redirect scheme wired but not tested** — `build.gradle.kts`'s
  `appAuthRedirectScheme` placeholder matches the iOS URL scheme, but no
  Android emulator run has verified the actual PKCE round-trip on that
  platform.
- **No biometric re-auth / app-lock** — a device left unlocked with a
  valid stored session has standing access until the access token
  expires and a refresh genuinely fails; out of scope for this pass.

# Keycloak auth retrofit — Phase 4 (cleanup)

The last piece of the four-phase retrofit — no new auth mechanism, just
retiring what real Keycloak auth made obsolete.

## 1. Dropping `roleCode`/`x-role-code`

Confirmed dead one final time before touching anything: grepped every
`.ts`/`.dart` file in the platform for `roleCode`/`x-role-code`. The only
hits outside `packages/backend-common/src/tenant-context.middleware.ts`
were governance-service's `Role.roleCode` — a completely different,
legitimate concept (the domain field holding values like
`STORES_CLERK`/`PROCUREMENT_MGR`, read via a DB join in
`AuthorizationService`) that was never at risk and was left untouched.
Neither `KeycloakAuthMiddleware` variant (governance-service's DB-backed
one, or the shared one in `packages/backend-common`) ever populated
`TenantContext.roleCode` — only the old `TenantContextMiddleware` stub
did, from an `x-role-code` header that `PostingAuthorityClient` (the
stub's one remaining caller, via `/authorization-check`) never actually
sends. Removed the field from the `TenantContext` interface and the
header read from `TenantContextMiddleware` itself.

`TenantContextMiddleware` is not deleted — it still has its one real
caller (governance-service's `/authorization-check`, service-to-service)
— but its doc comment was rewritten to describe what it actually is now:
a single-purpose remnant, not "the platform's auth," with a clear pointer
to why it's still there and what would need to change (a client-
credentials grant) for it to finally go away entirely.

## 2. Verified nothing broke across all 8 services

Rebuilt `packages/backend-common`, reinstalled it into all 8 backend
services, rebuilt each with `nest build` (clean, no compile errors —
expected, since the grep above confirmed zero other references to the
removed field), restarted all 8, and re-ran the full-stack sanity check:
a real Bearer token against one representative route per service (all
`200`), and `GET /audit-log/verify` afterward
(`{"valid": true, "totalRecords": 42}`) — hash chain intact through
everything Phases 1-3 had already written, confirming this pass touched
nothing it shouldn't have.

## Known gaps still open after this pass (Keycloak auth retrofit, Phase 4 — retrofit complete)

The four-phase Keycloak auth retrofit is done. What's left is genuinely
out of scope for this retrofit, not deferred work within it:

- **No machine-to-machine auth** — `/authorization-check` is, by design,
  the one place left on the pre-Keycloak header stub. A real
  client-credentials grant (one Keycloak client per calling service)
  would retire it; nothing currently plans to build that.
- **Android PKCE flow untested** — wired (`appAuthRedirectScheme` in
  `build.gradle.kts` matches the iOS URL scheme) but never run against
  an actual Android emulator.
- **No biometric re-auth / app-lock, no self-service signup or password
  reset, no MFA rollout** — provisioning stays `seed-users.sh`-driven;
  `users.mfa_enabled` still exists but nothing reads it. All unchanged
  since Phase 1.
- **`approval_matrix` thresholds still aren't enforced** — real,
  configured data, unrelated to auth mechanism; the binary
  `can_post`/`can_approve`/`can_override` check this retrofit rides on
  top of was never meant to cover amount-based routing. (Closed — see
  "Approval-matrix enforcement" below.)

## Approval-matrix enforcement

The gap immediately above: `approval_matrix` (module + transaction_type +
optional plant_id + threshold_min/max + up to three `approval_level_N_role_id`
columns, `infra/postgres/migrations/003_governance.sql`) was configured and
seeded since the Governance module shipped, but nothing resolved a real
transaction's amount against it. The binary `can_approve` flag the posting-
authority retrofit rides on can't express "which tier" on its own — in the
seeded data both `PROCUREMENT_MGR` and `FINANCE_CONTROLLER` have
`can_approve=true`; only `approval_matrix` says which one is required for a
given amount.

### 1. `governance-service`: `checkApprovalAuthority`

A new method on the existing `AuthorizationService`, deliberately NOT a
variant of `checkAuthority` — genuinely different question, same audit sink.
Given `{moduleName, transactionType, amount, plantId?, stage?}`:

- Resolves the matching `approval_matrix` band via `PrismaService.forTenant`,
  preferring a plant-specific row over the tenant-wide one (`plant_id IS
  NULL`) when the caller supplies a `plantId` — two sequential `findFirst`
  calls, not one `OR` query, so the plant-specific match always wins.
- Treats `threshold_max` as an EXCLUSIVE upper bound: an amount exactly at
  500,000 falls into the *next* band up, matching this repo's original
  Governance-slice seed comment ("at or above it, Finance Controller sign-off
  is required").
- No matching band at all → fail-closed DENY, `reason_code
  NO_APPROVAL_MATRIX_CONFIGURED` — a configuration gap is not the same thing
  as "no approval needed," so it must never silently pass.
- A band exists but the caller's role isn't the exact
  `approval_level_{stage}_role_id` → DENY, `reason_code
  INSUFFICIENT_APPROVAL_TIER` (a REAL role, just the wrong tier) or the
  existing `UNAUTHORIZED_POSTING_ATTEMPT` (no identity at all).
- Success → audits `action_type APPROVAL_CHECK`, returns `{authorized: true,
  roleCode, hasNextStage}` — `hasNextStage` tells the caller whether
  `approval_level_{stage+1}_role_id` is populated, i.e. whether to advance
  its own stage counter or finalize.

Exposed at `POST /approval-check` via a new, separate
`ApprovalAuthorityController` (not a method added to the existing
`AuthorizationController`, whose own `@Controller('authorization-check')`
decorator would have nested the route under
`authorization-check/approval-check` instead of a clean top-level path).
`app.module.ts`'s `TenantContextMiddleware`/`KeycloakAuthMiddleware`
exclusion list, previously just `authorization-check`, now covers both —
still exactly the two permanent, deliberate service-to-service routes (see
the "No machine-to-machine auth" gap above; nothing here changes that).

### 2. `PostingAuthorityClient`: `checkApprovalAuthority`

Same class in `packages/backend-common`, a new method alongside the existing
`checkAuthority` — same fail-closed-on-403-or-unreachable pattern, but unlike
`checkAuthority` (resolves to `void`) this one returns the parsed
`{authorized, roleCode, hasNextStage}` body, since the caller needs
`hasNextStage` to decide what to do next.

### 3. `procurement-service`: PO approve/reject

The only module wired up so far — the one whose schema
(`purchase_orders.current_approval_stage`, `.pending_approver_role_id`,
`.total_po_value`) was designed for exactly this from
`004_procurement.sql` onward. `ProcurementModule` provides
`PostingAuthorityClient` as an inline factory provider (this service has no
`common/governance.module.ts` wrapper the way accounting/sales/fleet/hr do —
it already provides `KafkaProducerService` the same inline-factory way, so
this follows that existing convention rather than introducing a new file).

- `POST /purchase-orders/:poId/approve` — 404 if missing, 400 if not
  `PENDING`, else calls `checkApprovalAuthority` for the PO's value at its
  `currentApprovalStage`. On success: advances `currentApprovalStage` if
  `hasNextStage`, otherwise sets `approvalStatus = APPROVED`.
- `POST /purchase-orders/:poId/reject` (body: `{reasonCode}`) — same
  authority gate as approve (a Procurement Manager can reject what they
  could have approved, not what's above their tier), sets `approvalStatus =
  REJECTED`.

### 4. Seed data

`infra/postgres/seed/governance_seed.sql` already had the two-tier
`approval_matrix` bands (below 500,000 → `PROCUREMENT_MGR`, at/above →
`FINANCE_CONTROLLER`) plus two new `reason_codes` rows
(`INSUFFICIENT_APPROVAL_TIER`, `NO_APPROVAL_MATRIX_CONFIGURED`).
`infra/postgres/seed/procurement_approval_seed.sql` is new: three fresh
`PENDING` POs straddling both bands (PO-2026-00002 at 320,000, PO-2026-00003
at 750,000, PO-2026-00004 at 200,000) — `dev_seed.sql`'s original
PO-2026-00001 is already `APPROVED` and can't exercise the approve/reject
flow from a clean state. `dev_seed.sql` also gained two users that had
drifted out of sync with the live dev database (Chidinma Eze, PROCUREMENT_MGR,
previously only ever inserted ad hoc via `psql` during an earlier phase) and
one brand new one (Tunde Bakare, FINANCE_CONTROLLER) — needed because proving
tier-specific routing requires a real user in each tier, not just the one
`STORES_CLERK` seed user.

### 5. Verification — real Keycloak tokens, all five scenarios

Using `metrock-test-client` (the realm's `directAccessGrantsEnabled: true`
client, for scripted password-grant token minting — `metrock-mobile` is
PKCE-only and rejects direct grants by design):

1. **Correct-tier approval succeeds**: Chidinma (`PROCUREMENT_MGR`) approves
   PO-2026-00002 (320,000, below threshold) → `201`, `approvalStatus:
   APPROVED`.
2. **Wrong-tier attempt denied**: Chidinma tries PO-2026-00003 (750,000,
   above threshold) → `403`, message names her role, the amount, and the
   stage.
3. **Correct high tier succeeds**: Tunde (`FINANCE_CONTROLLER`) approves the
   same PO-2026-00003 → `201`, `approvalStatus: APPROVED`.
4. **No approval authority at all denied**: Amaka (`STORES_CLERK`,
   `can_approve=false`) tries PO-2026-00004 → `403`.
5. **Reject works**: Chidinma rejects PO-2026-00004 with `reasonCode:
   MANUAL_ADJUSTMENT` → `201`, `approvalStatus: REJECTED`.

`audit_log` shows exactly the expected five rows —
`APPROVAL_CHECK`/`override_flag=false` for the two successes,
`APPROVAL_DENIED`/`override_flag=true`/`reason_code
INSUFFICIENT_APPROVAL_TIER` for both denials, correct `user_id` and
`record_id_ref` (the PO id) on every row. `GET /audit-log/verify` still
returns `{"valid":true}` afterward — the new rows extend the same hash chain
cleanly.

### Known gaps after this pass

- Only Procurement POs are wired up. (Closed — see "Approval-matrix
  enforcement — expansion beyond Procurement" further down.)
- No multi-stage escalation has actually been exercised — the mechanism is
  stage-aware (`hasNextStage`, `approval_level_2/3_role_id`) from day one,
  but no seed data populates a second or third tier yet, so it's untested
  beyond single-stage bands.
- No plant-specific `approval_matrix` row exists in seed data either — the
  plant-preferred-over-global resolution logic is implemented and
  `purchase_orders.plant_id` is real, but nothing currently exercises the
  plant-specific branch.

## CI + test suite, Phase 1: pilot on governance-service

Every module in this platform up to now has been verified by hand — curl,
psql, `docker exec`, re-run every phase. Nothing regresses automatically.
This is the first step of a 4-phase plan to fix that: stand up the CI
pipeline shape on one service before multiplying it across the other 7 Node
services and the Go `ledger-service` (Phase 2), then turn the manual
curl/psql verification this session has been doing by hand into an
automated integration suite against real Postgres (Phase 3), then Flutter
tests + branch protection (Phase 4).

governance-service is the pilot, not an arbitrary starting point: it is the
security-critical service, and it already holds the two most interesting
things to test — `checkAuthority` (the posting-authority retrofit) and
`checkApprovalAuthority` (this session's approval-matrix enforcement),
plus the hash-chained audit log both of them write to.

Running the suite locally: `cd backend/governance-service && npm test`
(needs `packages/backend-common` built first — `cd packages/backend-common
&& npm install && npm run build` — since it's a `file:` dependency with a
gitignored `dist/`, same as the CI job below).

### 1. `jest.config.js`

None of the 8 NestJS services had one — `package.json`'s `"test": "jest"`
script was Nest CLI scaffolding, never actually wired to run TypeScript
(`npx jest --listTests` found zero tests, silently, rather than failing —
would have kept silently finding zero tests forever without a `ts-jest`
preset telling Jest how to transform `.spec.ts` files at all). Added
`backend/governance-service/jest.config.js`: `ts-jest` preset, `rootDir:
'src'`, matching `*.spec.ts` files colocated with the code they test (the
same layout Nest's own schematics template already assumes, just never
actually used in this repo before now).

### 2. `authorization.service.spec.ts` — 16 tests

Unit-level, no real Postgres: `PrismaService.forTenant` and `AuditService`
are both hand-rolled `jest.fn()` fakes, not a `TestingModule` — cheaper to
read and reason about for pure business logic with only two collaborators.

Covers `checkAuthority`: authorized/denied paths, denial audits with
`override_flag=true`, missing `userId` treated as automatic denial (not a
validation error — this is explicitly the bypass-attempt scenario SDD
§4.2 describes, not a special case).

Covers `checkApprovalAuthority` — the newer, stricter check — more
thoroughly, since it has more real branches to get wrong: correct-tier
authorization, wrong-tier denial (`INSUFFICIENT_APPROVAL_TIER`), no
identity (`UNAUTHORIZED_POSTING_ATTEMPT`), no matching band at all
(`NO_APPROVAL_MATRIX_CONFIGURED`, fail-closed), plant-specific-band
short-circuit (asserts `findFirst` is called exactly once, not that the
result merely looks right — a regression that queried both bands
unconditionally would pass a looser assertion), fallback to the
tenant-wide band when no plant-specific one matches, the
`thresholdMax: { gt: amount }` exclusive-boundary query shape (asserted
directly on the constructed `where` clause, since a real Postgres
boundary check needs Phase 3, not a mock), `hasNextStage` resolved
correctly across all three stages via `it.each`, and out-of-range stage
values (0, 4) rejected with `BadRequestException`.

### 3. `audit.service.spec.ts` — 7 tests

The interesting design choice here: these tests do NOT reimplement SHA-256
hashing or canonical-JSON serialization to compute an "expected" hash and
compare — that would test the test's own copy of the algorithm, not
`AuditService`'s. Instead they call the REAL `recordEntry` to produce real
chained rows (mocking only the Prisma `tx` boundary — `$queryRaw` and
`findFirst`/`findMany`), then feed those real rows into the REAL
`verifyChain` and assert it reports them valid. Tampering with a field or
splicing a `prevHash` after the fact is what proves `verifyChain` actually
detects a broken chain, the same property `GET /audit-log/verify` proves
in every prior phase's curl-based verification — now exercised without a
running Postgres.

### 4. `.github/workflows/ci.yml`

Triggers on push/PR to `master`. Single job for now (`governance-service`
— Phase 2 turns this into a matrix). The one non-obvious step:
`@metrock/backend-common`'s `dist/` is gitignored and every service depends
on it via `file:../../packages/backend-common`, so a fresh CI checkout has
to `npm install && npm run build` that package FIRST, before
`governance-service`'s own `npm install` can resolve it. `prisma generate`
needs a syntactically valid `DATABASE_URL` in the job env even though it
never connects to it — generate reads the schema statically.

Verified the whole pipeline locally before trusting the YAML: wiped
`packages/backend-common/dist` and `backend/governance-service/node_modules`
entirely and re-ran every step from scratch in order — install, build,
prisma generate, build, test — all green, service still healthy afterward
(`curl localhost:3008/health` still `401`, not `ECONNREFUSED`).

### Known gaps after this pass

- Only governance-service has tests. The other 7 Node services and
  `ledger-service` (Go) have none yet — Phase 2.
- No integration tests against a real database — everything here mocks the
  Prisma transaction boundary. The actual SQL-level behavior this session
  spent time proving manually (RLS isolation, the `gt` vs `gte` threshold
  boundary, the five approval-matrix curl scenarios) is still unverified
  by anything automated — Phase 3.
- No lint in CI — none of the 8 services has a working ESLint config
  despite every `package.json` shipping a `"lint": "eslint ..."` script
  (`npx eslint` fails immediately: no `eslint.config.js` anywhere in the
  repo, pre-existing and repo-wide, not introduced by this pass). Fixing
  it is a separate task from standing up tests; the CI workflow here only
  builds and tests.
- No coverage threshold enforced — `collectCoverageFrom` is configured but
  nothing fails the build on a coverage drop yet.

## CI + test suite, Phase 2: the other 7 Node services + the Go ledger-service

Same shape as Phase 1, applied everywhere: `jest.config.js` + a spec file
per service, `.github/workflows/ci.yml` turned into a matrix job. Not
chasing coverage percentage — each service gets tests for the logic that's
actually risky to get wrong, identified the same way Phase 1 picked
governance-service's two methods: read the service's own doc comments for
what it says matters, then test that.

### What each service actually tests

- **procurement-service** (8 tests) — the over-receipt guard in
  `createGoodsReceipt` (within-quantity posts and publishes; over-quantity
  routes to `NEEDS_REVIEW` with no Kafka publish), this session's PO
  approve/reject stage transitions (finalizes to `APPROVED` vs. advances
  `currentApprovalStage` depending on `hasNextStage`, rejects a non-PENDING
  PO without even calling the authority check), and idempotent GRN replay.
- **manufacturing-service** (9 tests) — the yield-percent formula
  (`output / input * 100`), including the real historical bug it guards
  against: converting output through the SKU's `standardWeightKg` before
  computing yield, since 870 discrete loaves against 348kg of ingredients
  is a meaningless raw ratio (caught during manual verification as a
  nonsensical 250% — see `production.service.ts`'s own comment). Also: an
  unapproved recipe version routes to `NEEDS_REVIEW` with no ledger
  postings; yield below threshold still closes and posts, only flags;
  favorable vs. unfavorable variance event selection; idempotent replay.
- **sales-service** (5 tests) — the capital gate, the module's entire
  reason for existing: within-capital confirms and posts, over-capital
  blocks with `NEEDS_REVIEW` and no ledger publish, existing outstanding
  exposure is correctly subtracted from approved capital before the
  comparison (not just checked against the raw approved figure), the
  boundary is inclusive (`<=`, an order landing exactly on available
  capital is NOT blocked), and idempotent replay.
- **accounting-service** (4 tests) — `ReportsService`'s Trial
  Balance/P&L/Balance Sheet arithmetic, using a genuinely balanced trial
  balance fixture (total debits == total credits) so the
  Assets-vs-Liabilities+Equity+NetIncome identity documented in the class's
  own doc comment can actually be asserted as an equality, not just
  eyeballed.
- **fleet-service** (5 tests) — the fuel-variance tolerance check (within
  tolerance opens no maintenance request; outside tolerance does), Matrix
  Scenario #9 (a fuel record against a since-CANCELLED trip is still
  accepted and posted, only flagged via `orphanedTripReference`, never
  rejected), 404 on missing vehicle, idempotent replay.
- **hr-service** (5 tests) — Payroll Pool = Plant Revenue x Payroll Ratio
  and per-employee salary = Pool x Grade Weight, computed from confirmed
  sales orders; duplicate run for the same plant+period rejected;
  `postRun` calls `checkAuthority` before posting and publishes the net
  salary total; already-POSTED run rejected.
- **crm-service** (3 tests) — customer-not-found 404 and idempotent
  replay on Activities, plus a regression test for a real bug fixed during
  this platform's build (`docs/RUNBOOK.md`'s "Vertical Slice #4" §6):
  `findAll`'s `syncSeq` BigInt-to-string conversion, asserted against the
  actual failure mode (`JSON.stringify` throwing on a raw BigInt), not
  just the type of the returned value.
- **ledger-service (Go, 5 sub-tests across 2 test functions)** —
  `amountFromPayload` (extracts a named float64 field; returns false on
  missing, wrong-typed, or nil payload) and `nullableUUID`. Deliberately
  NOT `PostingEngine.Handle` itself: it takes a real `*pgxpool.Pool`, a
  concrete struct rather than an interface, so it can't be mocked at the
  boundary the way `PrismaService.forTenant` was for every Node service —
  exercising it needs a real Postgres, which is Phase 3's job, not this
  one's.

62 Node tests + 5 Go sub-tests total, all passing. Every service's `npm
install && prisma generate && npm run build && npm test` was also run from
a full clean `node_modules` wipe (spot-checked on sales-service and
crm-service, matching Phase 1's own clean-slate verification) before
trusting the CI matrix, and all 8 running dev services stayed healthy
(`curl .../health` still returning `401`, not `ECONNREFUSED`) throughout —
none of this touched anything at runtime.

### `.github/workflows/ci.yml` becomes a matrix

The single `governance-service` job from Phase 1 is now a
`strategy.matrix.service` job (`fail-fast: false`, so one service's failure
doesn't cancel the other seven mid-run) looping the same five steps
(install `backend-common`, install, `prisma generate`, build, test) across
all 8 Node services. `ledger-service` gets its own separate job since it's
Go, not Node — `go build`, `go vet`, `go test`.

### Known gaps after this pass

- Still no integration tests against a real database anywhere — every test
  in both Phase 1 and Phase 2 mocks the Prisma transaction boundary (or, for
  Go, tests only the DB-independent pure functions). Phase 3.
- Coverage is uneven by design, not by oversight: some services have one
  well-chosen test file covering their single riskiest method
  (`sales-service`, `hr-service`'s calculateRun/postRun), others have none
  of their secondary services tested at all (e.g. `AgentsService`,
  `NcrService`, `InvoicesService`/`BillsService`/`JournalsService`,
  `VehiclesService`/`MaintenanceService`/`TripsService`,
  `EmployeesService`/`AttendanceService`, `CustomersService`,
  every `sync.service.ts`). This pass targeted the highest-value logic per
  service, not full coverage of every controller/service pair.
- The Flutter mobile app and `apps/mobile/test/` remain untouched — Phase 4.

## CI + test suite, Phase 3: real Postgres, not a mock

Phase 1 and 2's 62 Node tests + 5 Go sub-tests all mock the Prisma
transaction boundary (or, for Go, test only DB-independent pure
functions) — deliberately, and documented as a gap in both phases'
"Known gaps" sections. This phase closes the two things that gap
concretely could not catch: whether RLS actually isolates tenants (a
claim this repo has only ever verified by hand, going back to the very
first vertical slice — see "Least-privilege app role + RLS verification"
above), and whether the real SQL a service issues (raw `$executeRaw`
inserts, Prisma `update` calls, composite keys) is actually correct
against a real database, not just correct against a mock that can't
notice a wrong column name or WHERE clause.

### 1. Where the tests live, and why they're not in the Phase 1/2 suite

`backend/procurement-service/test/*.integration-spec.ts`, run via a new
`npm run test:integration` script and a separate `jest-integration.config.js`
(`rootDir: 'test'`, matching `*.integration-spec.ts` — the existing
`jest.config.js` scopes to `rootDir: 'src'` and `*.spec.ts`, so there's no
overlap; the unit suite and the integration suite can never accidentally
run together). This mirrors Nest's own `test/*.e2e-spec.ts` convention,
named `integration` rather than `e2e` here since nothing HTTP is involved
— these call `ProcurementService` methods directly against a real
`PrismaService`, not a running server.

Piloted on procurement-service alone, same reasoning as Phase 1 picking
governance-service: it's the module docs/RUNBOOK.md has already manually
verified RLS against (the exact 3-scenario proof this phase automates),
and this session's own approval_matrix work gives it the freshest,
best-understood SQL to test.

### 2. `rls.integration-spec.ts` — the 3-scenario RLS proof, automated

The exact three `psql` scenarios documented as a MANUAL check since this
repo's first vertical slice ("Least-privilege app role + RLS verification"
above: wrong tenant → 0, correct tenant → N, no context → 0), run through
the real `procurement_svc` least-privilege role (not `metrock`, which is a
Postgres superuser and bypasses RLS unconditionally — running this through
the wrong role would prove nothing):

- Correct (seeded) tenant context → returns the real seeded
  `purchase_orders` rows.
- A freshly-generated, syntactically-valid UUID as tenant context —
  deliberately not a real second `tenant_registry` row, since the RLS
  policy (`tenant_id = current_tenant_id()`) never joins out to validate
  the tenant exists — returns zero rows, even though the table
  demonstrably has data.
- No tenant context set at all (bypassing `forTenant` entirely) → also
  zero rows, proving the fail-CLOSED default: `current_tenant_id()` reads
  `current_setting('app.tenant_id', true)`, NULL when unset, and
  `tenant_id = NULL` is never true under SQL's three-valued logic.

### 3. `procurement.integration-spec.ts` — real SQL, two collaborators still faked

Each test inserts its own fresh throwaway PO (`randomUUID()` po_id, real
seeded supplier/plant/warehouse ids) rather than depending on this
session's already-mutated seed POs (PO-2026-00002 through 00004 are no
longer all `PENDING` after the manual approval-matrix verification earlier
this session). `procurement_svc` has no DELETE grant
(`007_app_role.sql` — SELECT/INSERT/UPDATE only), so these rows are never
cleaned up; harmless, since each run uses a fresh id and CI's Postgres
service container is destroyed with the job regardless.

`KafkaProducerService` and `PostingAuthorityClient` are still `jest.fn()`
fakes — this file is testing procurement-service's own SQL, not whether a
Kafka broker or governance-service is reachable, the same boundary
ledger-service's own `PostingEngine.Handle` deferral draws in Phase 2.

Three tests: an over-receipt persists as `NEEDS_REVIEW` in real
`goods_receipts` WITHOUT advancing `purchase_order_lines.received_qty`
(verified via a follow-up raw `SELECT`, not by trusting the service's own
return value); replaying the same `clientEventId` against real Postgres
inserts exactly one `goods_receipts` row; `approvePurchaseOrder` actually
flips `purchase_orders.approval_status` to `APPROVED` in the database.

### 4. `.github/workflows/ci.yml` gains a `procurement-integration` job

A `postgres:16-alpine` service container (same image/credentials as
`infra/docker-compose.yml`), then the exact same migration+seed sequence
`docs/RUNBOOK.md`'s "2. Run migrations + seed data" has documented as a
manual step since the start of this project — run for real in CI for the
first time.

**A real bug this surfaced immediately**: a naive `for f in
infra/postgres/seed/*.sql` loop glob-sorts alphabetically —
`crm_seed.sql` before `dev_seed.sql` — but `crm_seed.sql`'s `INSERT INTO
customers` depends on the `tenant_registry` row `dev_seed.sql` creates.
`psql` does not fail the shell on a SQL error by default, so the loop
reported success while `customers` silently stayed empty — caught only
by explicitly counting rows after seeding, not by trusting a clean exit
code. Fixed two ways: `dev_seed.sql` now runs explicitly first, then
every other seed file in any order; every `psql` invocation (migrations
and seed) now passes `-v ON_ERROR_STOP=1`, so this whole class of bug
fails the CI job loudly instead of producing quietly incomplete data.

Verified the entire job's logic locally against a genuinely fresh
`postgres:16-alpine` container (not the long-running dev one, which has
drift from this session's own manual testing) before trusting the YAML —
same rigor as Phase 1/2's clean-`node_modules` checks, extended here to a
clean database: migrations, seed (with the ordering bug caught and fixed
mid-verification), `prisma generate`, and all 6 integration tests, all
green from cold. The 8 running dev services and the persistent dev
Postgres container were confirmed unaffected throughout.

### Known gaps after this pass

- Only procurement-service has real-Postgres integration tests. The RLS
  proof is table-agnostic in principle (the same 3-scenario pattern
  applies to every RLS-protected table in the schema) but only exercises
  `purchase_orders` so far.
- No full HTTP-level test exists anywhere — these integration tests call
  service classes directly, not through a running Nest server + Bearer
  token. The five approval-matrix scenarios this session proved by hand
  with real Keycloak tokens (docs/RUNBOOK.md's "Approval-matrix
  enforcement" section) remain a manual curl proof, not an automated one
  — standing up Keycloak + governance-service + procurement-service
  together in CI is a meaningfully bigger lift than a single Postgres
  service container, and is the natural next slice here, not Phase 4's.
- Offline-sync idempotency is proven for `createGoodsReceipt` specifically,
  not for the `/sync/push` HTTP path or any other service's sync handler.
- Still Go: `PostingEngine.Handle` itself remains untested against a real
  Postgres — the same deferral from Phase 2, not yet picked up here.

## CI + test suite, Phase 4: the Flutter mobile app (plan complete)

The last phase of the 4-phase plan. Two files under `apps/mobile/test/`,
alongside the one real test that already existed there
(`widget_test.dart`'s `PoLineDraft` unit test — this app was never
entirely untested, just untested outside that one file).

### 1. `auth_client_test.dart` — the PKCE login/refresh/logout flow, mocktail fakes

`AuthClient` (Phase 3 of the Keycloak retrofit) already took both its
collaborators — `FlutterAppAuth`, `FlutterSecureStorage` — via optional
constructor injection, the same testability pattern this whole CI project
has leaned on since governance-service's `PrismaService.forTenant` mocks.
Added `mocktail` as a dev dependency (no code generation, unlike
`mockito`) and wrote `MockFlutterAppAuth`/`MockFlutterSecureStorage`.

Eight tests: `restoreSession` with and without a persisted session;
`login` persisting all four tokens from a successful PKCE exchange;
`getValidAccessToken` returning the current token without refreshing when
it's still valid (asserted via `verifyNever`, not just a returned value);
silently refreshing when within 30 seconds of expiry; and the two
divergent failure paths the class's own doc comment calls out as the
whole point of this method existing — an `invalid_grant` refresh failure
logs the user out and throws, while a plain network failure during
refresh REthrows without logging out, because going offline must never
be indistinguishable from being signed out. `logout` clearing the local
session even when the server-side end-session call itself fails.

### 2. `goods_receipt_repository_test.dart` — outbox-event creation, a real database

`captureGoodsReceipt` is the offline-capture write path (SDD §2.1): never
touches the network, only the local Drift/sqlite cache. Run against a
REAL in-memory sqlite database (`NativeDatabase.memory()`), not a mock —
same "real where it's cheap" reasoning as Phase 3's Postgres tests, and
cheap here too: `AppDatabase`'s constructor gained an optional
`QueryExecutor` parameter purely for this (the real `_openConnection()`
needs `path_provider`'s platform channel, unavailable under plain
`flutter test`).

Three tests: a capture commits the GRN row, both its lines, and EXACTLY
ONE `PENDING` outbox event in one local transaction — asserting the
outbox row's `client_event_id` is literally the same value as the GRN's
own (the outbox idempotency key IS the entity's own client event id, not
a separate one), and that the JSON payload decodes to the right shape;
two captures produce two fully independent GRNs and outbox rows; omitting
`receiverUserId` leaves the key OUT of the payload entirely rather than
serializing it as `null` (asserted via `containsKey`, not just checking
the value).

### 3. `.github/workflows/ci.yml` gains a `mobile` job

`subosito/flutter-action@v2` pinned to `3.44.8` (the version this session
verified locally), `flutter pub get`, then `dart run build_runner build
--delete-conflicting-outputs` — `database.g.dart` is gitignored
(`apps/mobile/**/*.g.dart`), so a fresh CI checkout has to regenerate it,
same shape as `packages/backend-common`'s gitignored `dist/` needing a
build step in every other job. `flutter analyze` runs before `flutter
test`, since neither `test` nor `build` alone catches every static issue.

Verified the whole job locally from a genuinely clean state — deleted
`.dart_tool` and `build`, then `pub get` → `build_runner` → `analyze` →
`test`, all green — before trusting the YAML, same rigor as every prior
phase's clean-slate check.

### Known gaps after this pass (the 4-phase plan is now complete)

- No widget-level tests anywhere — both new test files exercise
  service/repository classes directly, never a rendered widget tree.
  `main.dart`'s own root widget hits sqlite/network in `initState`, which
  the original `widget_test.dart` comment already flagged as needing real
  mocking infrastructure to test meaningfully — still true.
- `SyncService` itself (the push/pull orchestration, connectivity
  watching, retry-on-failure grouping) has no tests — only the
  `GoodsReceiptRepository` write path that feeds its outbox queue.
- Every other feature's repository (`ProductionBatchRepository`,
  `SalesOrderRepository`, `NcrRepository`, `ActivityRepository`,
  `TripLogRepository`, `FuelRecordRepository`, `AttendanceRepository`, if
  each has its own like `GoodsReceiptRepository` does) is untested —
  `goods_receipt_repository_test.dart` proves the PATTERN works, not that
  every capture screen's own outbox-event shape is correct.
- Stepping back to the whole plan: only procurement-service has real-
  database integration tests (Phase 3); most services' secondary
  controllers across the whole backend still have zero tests (Phase 2's
  own "Known gaps"); nothing anywhere exercises the actual HTTP + Keycloak
  layer end-to-end in an automated way — the five approval-matrix
  scenarios and the Flutter app's real device/simulator verification both
  remain manual proofs, not CI-enforced ones. Real, deliberate coverage
  of the highest-value logic per surface, not comprehensive coverage —
  the CI + test suite plan closes the "nothing regresses automatically"
  gap for the riskiest logic, it does not eliminate manual verification
  from this project.

## API Gateway (nginx path-based reverse proxy)

The "No API Gateway yet" line from README's Known Gaps, closed to the
extent that's actually proportionate right now — see `infra/nginx/
nginx.conf`'s own header comment for the full reasoning on what this
deliberately is and is not. Short version: the SDD's full Edge layer
(subdomain tenant resolution, per-tenant rate limiting, a separate Sync
Gateway microservice) is infrastructure for a multi-tenant, multi-client
platform this repo isn't yet — one tenant, one client. What was actually
broken: `apps/mobile/lib/main.dart` hardcoded 7 separate `localhost:PORT`
base URLs, one per module. This closes exactly that, nothing more.

### 1. `infra/nginx/nginx.conf` + `infra/docker-compose.yml`'s new `gateway` service

nginx, not a hand-rolled NestJS proxy — path-based routing is nginx's
core competency, and every other piece of shared infra in this stack
(Postgres, Keycloak, Redpanda) is already an off-the-shelf component, not
custom-built. One `location` block per module (`/procurement/`,
`/manufacturing/`, `/sales/`, `/crm/`, `/fleet/`, `/hr/`, `/governance/` —
`accounting-service` excluded, no Flutter dependency), each proxying to
`host.docker.internal:PORT` (the 8 services still run on the host, not
containerized). A transparent proxy: no JWT verification, no tenant
resolution, no rate limiting — every header, including `Authorization`,
passes through untouched, and each backend service keeps verifying its
own Bearer token exactly as before.

**Two real bugs found while verifying this against real traffic, not
theoretical ones:**

- **IPv6 connection failures on the first request after every restart.**
  Docker's embedded DNS (`127.0.0.11`) resolves `host.docker.internal` to
  BOTH an IPv6 and an IPv4 address. A plain `proxy_pass
  http://host.docker.internal:PORT` resolves that hostname once at config
  load and round-robins across every address returned — including the
  IPv6 one, which has no route from inside the container and fails with
  "Network unreachable" (self-healing via nginx's automatic retry on the
  next address, but a wasted connection attempt and a scary log line every
  time). Fixed with `resolver 127.0.0.11 ipv6=off valid=30s;` plus a
  variable in each `proxy_pass`, which forces per-request resolution
  through that resolver instead of nginx's static startup-time lookup —
  the only way to actually skip the IPv6 record rather than just
  tolerating the failure. Verified fixed across 3 fresh `docker compose
  restart gateway` cycles with zero IPv6 errors in the logs.
- **Using a variable in `proxy_pass` silently stopped stripping the
  location prefix.** The first working version of the IPv6 fix above made
  every request 404 — a well-documented but easy-to-miss nginx behavior:
  static `proxy_pass` with a literal URI automatically replaces the
  matched `location` prefix with that URI, but switching to a variable
  disables that rewriting entirely, so `/procurement/purchase-orders`
  arrived at procurement-service as the literal, unmatched path
  `/procurement/purchase-orders` instead of `/purchase-orders`. Fixed with
  an explicit `rewrite ^/procurement/(.*)$ /$1 break;` before each
  `proxy_pass`, doing by hand what static `proxy_pass` used to do
  automatically.

### 2. `apps/mobile/lib/main.dart`

7 hardcoded `_devProcurementBaseUrl`-style constants collapsed into one
`_devGatewayBaseUrl = 'http://localhost:8000'`; each `ApiClient` now gets
`'$_devGatewayBaseUrl/<module>'` instead of its own port.
`core/sync/sync_service.dart`'s client-side `SyncModule` routing table
didn't need to change at all — it routes to an `ApiClient` instance, and
only which URL that instance points at changed.

### 3. Verification

Real HTTP calls with real Keycloak-issued Bearer tokens, not just
"the config parses":

- Unauthenticated request through the gateway returns the same `401` as a
  direct call to the service — proves it actually reached the real
  service's own `KeycloakAuthMiddleware`, not a gateway stub.
- An authenticated `GET /procurement/purchase-orders` through the gateway
  returns byte-identical data (same `po_id` set) to the same call made
  directly to `procurement-service:3001` — proves the Bearer token and
  full response body pass through unmodified.
- All 7 routed module prefixes reach their real backend service
  (confirmed via nginx's own access log, not just HTTP status codes).
- 3 fresh `docker compose restart gateway` cycles, each followed
  immediately by an authenticated request, all clean — no IPv6 errors,
  correct routing.
- Full interactive proof on the iOS Simulator: real login via the actual
  Keycloak PKCE browser flow (not a mocked one), then the Purchase Orders
  list loads real data — including PO-2026-00001 through 00004 AND the
  throwaway `PO-TEST-*` rows this session's own Phase 3 integration-test
  verification created — entirely through `localhost:8000`, and a PO
  detail screen (a second, different endpoint) loads correctly too.

### Known gaps after this pass

- accounting-service isn't routed — no client calls it yet, add a
  `location /accounting/` block the same way as the others if that
  changes.
- The SDD's other Edge-layer component, a separate Sync Gateway service,
  remains unimplemented — `/sync/push`/`/sync/pull` stay inside each
  domain service, correctly so until sync logic genuinely needs
  deduplication across services.
- Still no tenant resolution, rate limiting, or auth at the gateway layer
  — meaningful only once a second tenant or a real multi-client
  deployment exists to justify them.
- Not part of `.github/workflows/ci.yml` — this is a local dev-stack
  convenience layer, not something the automated test suite exercises
  (procurement-service's own CI integration tests still hit the service
  directly on its own port, not through the gateway).

## `helmet` security headers + opt-in CORS

All 8 `main.ts` files were byte-identical boilerplate around this
concern (same as `ValidationPipe` before it), confirmed by diffing all 8
before touching any of them — so the fix lives once in
`@metrock/backend-common`, not 8 times.

### 1. `packages/backend-common/src/security-middleware.ts`

One new export, `applySecurityMiddleware(app)`, called from each
service's `main.ts` right after `NestFactory.create(AppModule)`, same
place `ValidationPipe` was already wired up. Two genuinely different
gaps, addressed differently — see the function's own doc comment for the
full reasoning:

- `helmet()` with its defaults — an ACTIVE gap, always on. These are
  pure JSON APIs with no server-rendered views, so no per-service CSP
  tuning was needed.
- CORS gated behind a new `CORS_ALLOWED_ORIGINS` env var (comma-
  separated). NOT an active gap today — a browser enforces same-origin
  with zero server config, and nothing today calls these APIs from a
  browser (only the native Flutter app + curl, neither subject to CORS).
  Left unset on every service (each `.env.example` documents it,
  commented out), which is exactly today's behavior — this makes the
  capability ready for the SDD's Web Console client without changing
  anything before it exists, and ensures whoever adds it later reaches
  for an explicit allow-list instead of a bare `app.enableCors()` (which
  permits every origin).

`helmet` added as a real dependency of `packages/backend-common`
(alongside `jsonwebtoken`/`jwks-rsa`, the same pattern), not a peer
dependency — it's used directly inside the shared function, not just
referenced by type.

### 2. Rolling it out to all 8 services

Same propagation gotcha this session has hit before with
`packages/backend-common` changes, but sharper this time: a partial
`rm -rf node_modules/@metrock/backend-common && npm install` picked up
the new export's *code* but silently skipped `helmet` itself — the
existing `package-lock.json` didn't know backend-common's own
`package.json` had gained a new dependency, so npm reinstalled the
stale locked tree rather than resolving it fresh. Confirmed missing via
`find node_modules -iname helmet` coming up empty even though the build
succeeded (TypeScript only checks types, not runtime `node_modules`
presence). Fixed by doing a full `rm -rf node_modules package-lock.json
&& npm install` per service instead of the partial version — the
reliable one, not the fast one.

### 3. Verification — real headers on real responses, not just "it compiles"

- Restarted all 8 dev services, confirmed all healthy.
- `curl -I` against a real running service shows the actual headers:
  `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security`, and more —
  checked on all 8 ports, not just one.
- Confirmed CORS stays OFF by default: a request with an `Origin` header
  and no `CORS_ALLOWED_ORIGINS` set gets no `Access-Control-Allow-Origin`
  header back, exactly today's behavior.
- Confirmed the opt-in path actually works when enabled: restarted
  procurement-service with `CORS_ALLOWED_ORIGINS` set to one origin,
  confirmed the header appears for that exact origin and stays absent
  for a different one. First attempt at this specific check gave a false
  negative — chased down to a stale process from an earlier restart in
  this session still squatting on port 3001 under a different process
  name (`node dist/src/main`, not matched by a `pkill -f
  ".../node_modules/.bin/nest"` pattern), so the new instance with the
  env var set had actually crashed on `EADDRINUSE` and never took the
  request at all. Found via `lsof -i :3001 -sTCP:LISTEN -t` plus `ps eww
  -p $PID` to inspect the actual running process's environment directly,
  not by trusting that "I started a process" meant "that process is the
  one answering." Killed the correct PID, reran, confirmed clean.
- All 8 services' existing Jest suites (Phases 1-3) still pass — the new
  middleware sits ahead of everything else in the request pipeline but
  changes no business logic.

## Rate limiting — two independent layers

Flat, non-tenant-aware flood/DoS protection — NOT the SDD's per-tenant-
tier rate limiting (§1.1's API Gateway responsibilities), which still
doesn't apply: one tenant, nothing to tier by. Same "the mechanism
doesn't need to wait for the prerequisite it's usually paired with"
reasoning as CORS.

### 1. `infra/nginx/nginx.conf` — gateway layer

`limit_req_zone $binary_remote_addr zone=gateway_limit:10m rate=100r/m;`
plus `limit_req zone=gateway_limit burst=20 nodelay;` in the `server`
block, applying to every routed location at once. `limit_req_status 429;`
so rejections return the correct status code (nginx defaults to `503`
otherwise).

### 2. `packages/backend-common/src/rate-limit.module.ts` — per-service layer

A SEPARATE layer, not a duplicate of the gateway one: every service is
still directly reachable on its own port (`:3001`–`:3008`), the same
dev-convenience pattern this whole session's own manual curl verification
has relied on throughout — gateway-only protection would leave that path
completely open. `ThrottlerModule.forRoot()` (100 requests/60s per client
IP) plus `ThrottlerGuard` registered as a global `APP_GUARD`, exported as
one `RateLimitModule` and imported into all 8 `AppModule`s right after
`ConfigModule.forRoot(...)` — same shared-bootstrap-once pattern as
`applySecurityMiddleware`, just at the module level instead of `main.ts`
since Nest Guards have to be wired through the DI system, not `app.use()`.
`@nestjs/core` added as a new peer dependency of `packages/backend-common`
(needed for `APP_GUARD`) — the same package every consuming service
already has installed as the actual NestJS framework, so no new
requirement in practice, just an explicit one.

### 3. Verification — real `429`s under real load, both layers, plus a real methodology mistake caught along the way

- **Gateway**: fired 150 rapid unauthenticated requests through
  `localhost:8000/procurement/...` — 27 succeeded (burst allowance plus a
  few admitted at the steady rate during the loop's real wall-clock
  duration), 123 came back `429`. Confirmed recovery (not a hard block)
  after a few seconds' pause.
- **Per-service**: first attempt fired 150 unauthenticated requests
  directly at `procurement-service:3001` and got 150×`401`, zero `429`s —
  looked like the throttle wasn't working at all. Root cause:
  `KeycloakAuthMiddleware` rejects unauthenticated requests inside Nest's
  middleware phase, which runs BEFORE the Guard phase where
  `ThrottlerGuard` lives — an unauthenticated flood never reaches the
  throttler at all, it's already rejected by auth first. Redid the test
  with a real Keycloak-issued Bearer token; the token's 2-second lifetime
  (this realm's `metrock-test-client` setting, established earlier this
  session) then cut a SEQUENTIAL 150-request loop short at 58 successes
  before the token expired mid-test. Fixed by firing the same 150
  requests with 30-way concurrency (`xargs -P 30`) so the whole burst
  completed in under 400ms, comfortably inside the token's lifetime: 42
  succeeded, 108 came back `429` — and 58 (the earlier sequential run) +
  42 = exactly 100, confirming the IP-based 60-second counter had
  correctly persisted across both separate test invocations from the same
  source IP, not reset between them.
- Confirmed normal single-request traffic on every OTHER service stayed
  completely unaffected (still `401` for auth reasons, never `429`) — the
  limit is per-service-instance, one flooded service doesn't touch the
  others.
- All 8 services' existing Jest suites still pass.

### Known gaps after this pass

- Limits (100 req/min at both layers) are generous, clearly-dev-
  appropriate defaults, not real production SLA numbers — the SDD ties
  those to a tenant tier that doesn't exist yet.
- Both layers track by client IP, not by authenticated user/tenant —
  correct for flat, non-tenant-aware flood protection, but means a shared
  NAT/proxy in front of many real users would share one limit. Revisit
  once there's a real tenant-tier concept to key by instead.
- Not part of `.github/workflows/ci.yml` — same reasoning as the gateway
  itself not being CI-exercised; this is dev-stack flood protection, not
  something the automated test suite needs to prove on every push.

## TLS termination (Part A — gateway + Keycloak, mobile app still on HTTP)

Scoped deliberately narrow: TLS at the two things the Flutter client
actually talks to directly (the nginx gateway, Keycloak), proven working
with real handshakes — not the whole internal mesh, and not yet the
mobile app itself. See the scoping conversation for why: the 8 backend
services became internal-only the moment the gateway existed, so TLS in
front of *them* specifically isn't the active gap the gateway/Keycloak
are; Postgres/Kafka/Redis/MinIO are internal data-plane traffic, each
with its own separate TLS mechanism, a distinctly bigger and lower-
priority lift; and switching the mobile app to `https://` needs the iOS
Simulator to trust a self-signed cert, its own real piece of work with
its own verification story, not something to rush into the same pass.

### 1. `infra/certs/generate-dev-certs.sh`

Plain `openssl req -x509`, not `mkcert` — deliberately. `mkcert` gives a
nicer no-browser-warning dev experience, but only because it installs a
local CA into the machine's own system trust store, a real change to the
host, not just this project. That's the kind of action this session
checks with you about rather than doing quietly, so this generates a
plain self-signed cert instead: `CN=localhost`, SANs `localhost` +
`127.0.0.1`, 825 days validity. Output (`dev-cert.pem`, `dev-key.pem`)
is gitignored — regenerable per-machine on demand, and a private key,
even a throwaway dev one, shouldn't be committed regardless. Run it once
before first use:

```bash
infra/certs/generate-dev-certs.sh
```

### 2. `infra/nginx/` — a second listener, not a replacement

`nginx.conf` gained a `:8443 ssl` server block alongside the existing
plain `:8000` one — both stay up. All 7 module `location` blocks were
about to be duplicated across two server blocks for no reason (the
routing logic doesn't depend on which listener a request arrived on), so
they moved into a new `infra/nginx/locations.conf`, `include`d by both
server blocks instead — the actual maintenance-friendly fix, not just
"paste it twice." The rate-limiting zone from the previous pass
(`limit_req_zone`, defined once at `http` level) is automatically shared
across both listeners, no extra wiring needed.

`docker-compose.yml`'s `gateway` service gained a `8443:8443` port
mapping and a new `./certs:/etc/nginx/certs:ro` volume mount (plus the
`locations.conf` mount, since it's a separate file now).

### 3. Keycloak — additive, not a switch

`--https-certificate-file`/`--https-certificate-key-file` added to the
existing `start-dev --import-realm` command, same cert as the gateway.
This does NOT change the realm's canonical issuer URL — every service's
`KEYCLOAK_ISSUER` and `realm-export.json` itself still say
`http://localhost:8080/realms/metrock`, unmodified. Keycloak's own
default HTTPS port (`8443`, container-internal) would collide with the
gateway's own `8443` host mapping if mapped straight through, so
`docker-compose.yml` maps it to host port `8543` instead — two separate
containers, two separate host ports, container-internal config
untouched.

### 4. A real gap this surfaced, unrelated to TLS itself

Verifying this required restarting the whole stack, which revealed
Docker Desktop's VM (and, separately, all 8 host-run Node services) had
been down entirely — a long system sleep/wake cycle, not anything this
pass changed. Bringing everything back up also revealed that
`chidinma.eze@metrock.dev`/`tunde.bakare@metrock.dev` (created ad hoc via
`infra/keycloak/seed-users.sh` earlier this session, not part of the
committed `realm-export.json`) don't survive a Keycloak realm re-import —
`--import-realm`'s `OVERWRITE_EXISTING` strategy replaces the whole
realm from the file on every fresh start, and those two users only ever
existed as live Keycloak Admin API calls, never in the file itself.
Re-running `infra/keycloak/seed-users.sh` recreated them (idempotent,
matches existing Postgres `users` rows by `local_user_id`) — but this is
a real, standing operational gap worth naming: after any full Keycloak
restart, `seed-users.sh` needs re-running for every user beyond what's
baked into `realm-export.json`, and nothing currently automates or
even flags that step.

### 5. Verification — real handshakes, not config review

- `openssl s_client -connect localhost:8443` and `...:8543`, both
  returning the same self-signed cert with the expected `CN=localhost`
  and validity dates — the handshake actually completes.
- `curl -sk https://localhost:8543/realms/metrock/.well-known/openid-configuration`
  — real `200` with a genuine OIDC discovery document from Keycloak's
  HTTPS listener.
- A full authenticated round-trip through the gateway's HTTPS listener —
  real Keycloak token, `https://localhost:8443/procurement/purchase-orders`
  — returning real data, not just a handshake.
- Confirmed the plain `:8000`/`:8080` listeners still work unmodified
  (this is additive, not a cutover) and spot-checked 3 more module
  routes through `:8443` to confirm the shared `locations.conf` include
  actually applies to all of them, not just the one tested first.

### Known gaps after this pass

- The 8 backend services, Postgres, Kafka, Redis, and MinIO remain fully
  plaintext (Part B below covers the mobile app itself, not the rest of
  the mesh).
- No automated reminder that `seed-users.sh` needs re-running after a
  Keycloak realm reset — found and worked around this pass, not fixed.
- Not part of `.github/workflows/ci.yml` — same reasoning as the gateway
  and rate-limiting passes before it; this is dev-stack infrastructure,
  not something the automated test suite exercises.

## TLS termination (Part B — the Flutter app itself)

Closes the gap Part A named: the mobile app now speaks HTTPS to both the
gateway (`ApiClient`'s data calls) and Keycloak (`AuthClient`'s native
login flow), not just plain HTTP with a TLS listener sitting unused
alongside it. The two networking stacks trust the dev cert through two
different mechanisms, because they're fundamentally different pieces of
iOS plumbing:

- **`ApiClient`** (Dart `http`/`IOClient`) is pinned to the one specific
  dev cert via a `SecurityContext` — no system trust store involved.
- **`AuthClient`**'s login (`flutter_appauth`) drives a native
  `ASWebAuthenticationSession` (real system browser) — its TLS
  validation is the OS's, not reachable from Dart at all. The iOS
  Simulator's own keychain has to trust the cert instead.

### 1. Bundling the cert into the app

`infra/certs/generate-dev-certs.sh` now also copies `dev-cert.pem` (never
the key) into `apps/mobile/assets/certs/dev-cert.pem`, registered as a
Flutter asset in `pubspec.yaml`. Gitignored the same way as
`infra/certs/*.pem` — regenerate/copy again any time the script re-runs;
`flutter build`/`flutter test` fail on a missing asset, so this has to
exist before the first build on a fresh clone.

### 2. `ApiClient`'s pinned `SecurityContext`

`main.dart`'s `main()` is now `async`, loads the bundled cert via
`rootBundle.load(...)` before `runApp()`, and builds one
`IOClient(HttpClient(context: SecurityContext(withTrustedRoots: false)
..setTrustedCertificatesBytes(certBytes)))` shared by all 7
`ApiClient` instances (`withTrustedRoots: false` deliberately — this
client only ever talks to our own gateway, so it trusts exactly one cert
and nothing else, not the full system CA list plus one addition).
`_devGatewayBaseUrl` moved to `https://localhost:8443`.

### 3. Trusting the cert for the native login flow

`_devKeycloakIssuer` moved to `https://localhost:8543/realms/metrock`.
`AuthClient`'s three AppAuth calls (`login`, `logout`'s `endSession`,
token refresh) had `allowInsecureConnections` flipped from `true` to
`false` — that flag permits plain HTTP, which no longer applies now that
this is genuine TLS.

For `ASWebAuthenticationSession` to accept the handshake, the iOS
Simulator's own keychain needs the dev cert as a trusted root — a
one-time step per simulator, not something the app or its build can do
for itself:

```bash
xcrun simctl keychain <device-udid> add-root-cert infra/certs/dev-cert.pem
```

This is simulator-scoped state (`xcrun simctl erase` wipes it, a fresh
simulator doesn't have it), not a change to the real macOS Keychain —
the same reasoning Part A used to rule out `mkcert`. Every new simulator
used for this app needs the command re-run once.

### 4. Two bugs this surfaced, unrelated to the mobile-side work itself

Verifying the real end-to-end login (not just a handshake) surfaced two
pre-existing issues that had nothing to do with switching to HTTPS —
they'd have bitten the HTTP flow too, just never got exercised this
precisely before:

- **`metrock-mobile`'s `tenant` scope wasn't actually assigned.**
  `realm-export.json` relied on the realm's `defaultDefaultClientScopes`
  (`["tenant"]`) applying automatically since the client didn't list
  `defaultClientScopes` at all — but the live realm's client had an
  *explicit* empty list, which doesn't inherit anything, and a real login
  failed with `invalid_scope`. Fixed by making the assignment explicit in
  `realm-export.json` (`"defaultClientScopes": ["tenant"]`) and applying
  it live via the Admin API to unblock verification without another
  restart. This wasn't a TLS issue — the same failure would hit an HTTP
  login through the same client once the realm was re-imported.
- **Keycloak's issuer claim follows whichever URL the client used.**
  Logging in via `https://localhost:8543` gets tokens stamped
  `iss: https://localhost:8543/realms/metrock`, not the
  `http://localhost:8080` the 8 backend services were still configured
  to expect — so every request failed with `jwt issuer invalid` even
  though the login itself succeeded. Keycloak's `frontendUrl` realm
  attribute can pin the issuer to one fixed value regardless of which
  listener served the request, but pins the `authorization_endpoint`/
  `token_endpoint` right along with it — setting it to the HTTP URL
  would silently route the whole login flow back over plain HTTP,
  defeating the point of this pass, so that approach was reverted after
  confirming it via the discovery document. The real fix: `KEYCLOAK_ISSUER`
  in all 8 backend services' `.env`/`.env.example` now reads
  `https://localhost:8543/realms/metrock`, and each service's process
  gets `NODE_EXTRA_CA_CERTS=infra/certs/dev-cert.pem` set before start so
  `jwks-rsa`'s own HTTPS fetch of Keycloak's signing keys
  (`${issuer}/protocol/openid-connect/certs`) trusts the same dev cert —
  without it, every service would reject the token trying to verify its
  signature, not just its issuer. This is the one piece of this pass that
  reaches outside the mobile app: switching the login endpoint to HTTPS
  changes what's stamped into every token, which every verifier has to
  agree on.

### 5. Verification — real login, not just a handshake

- `flutter analyze` (no issues) and `flutter test` (all 12 existing
  tests, unaffected — they mock `FlutterAppAuth`/`FlutterSecureStorage`
  directly rather than hitting the network).
- `xcrun simctl keychain ... add-root-cert`, then a real interactive
  login on a booted "iPhone 17 Pro" simulator: `ASWebAuthenticationSession`
  rendered Keycloak's actual themed login page over HTTPS with no cert
  warning at all (confirming the keychain trust took effect), and
  `chidinma.eze@metrock.dev` signed in for real.
- Purchase Orders list and a Goods Receipt detail screen both loaded real
  data through `https://localhost:8443/procurement/...` post-login —
  confirms `ApiClient`'s pinned `SecurityContext` works for genuine data
  calls, not just discovery.
- Direct `curl` against a freshly-minted token, both through the gateway
  and straight to `procurement-service:3001`, to isolate the issuer/JWKS
  fix from the app-level verification above.

### Known gaps after this pass

- Postgres, Kafka, Redis, and MinIO remain fully plaintext — unchanged
  from Part A, still a distinctly bigger, lower-priority lift.
- `NODE_EXTRA_CA_CERTS` has to be set on every host-run backend service's
  process at start, same as `seed-users.sh` above — nothing currently
  automates that either; the ad hoc restart loop used for verification
  sets it manually.
- Not part of `.github/workflows/ci.yml`, same reasoning as every other
  dev-stack infra pass.

## Secrets in production

Fixes the one concrete credential leak in this repo — the 8 Postgres
role passwords were hardcoded directly into committed SQL migration
files (`infra/postgres/migrations/*_role.sql`), permanently in git
history, unlike `infra/.env`/every service's own `.env` (already
gitignored, already overridable). Everything else credential-shaped in
this repo was already either gitignored or an explicitly-labeled,
publicly-known local-dev default (`infra/.env.example`'s header comment
covers the Postgres/MinIO/Keycloak-admin ones) — no Keycloak client
secrets exist anywhere (both `metrock-test-client` and `metrock-mobile`
are public/PKCE clients), so the SQL files were the only actual gap.

Deliberately did NOT stand up a real secrets manager (Vault, AWS Secrets
Manager, Doppler) to close this — there's no cloud deployment target for
this platform yet (no AWS/GCP account, no k8s cluster, no deploy
pipeline beyond this repo's own CI), so wiring one up now would be
infrastructure for an environment that doesn't exist, the same trap
tenant-subdomain resolution and per-tenant rate limiting avoided
elsewhere in this codebase (see the API Gateway and rate-limiting
sections above). The actual fix needed here is narrower and doesn't
require picking a vendor.

### The fix: psql variables with a default, not a hardcoded literal

Each of the 8 `*_role.sql` files now reads its role's password from a
psql variable instead of a string literal, falling back to the exact
same well-known dev value as before when nothing overrides it:

```sql
\if :{?procurement_svc_password}
\else
  \set procurement_svc_password 'procurement_svc_dev_password'
\endif
CREATE ROLE procurement_svc WITH LOGIN PASSWORD :'procurement_svc_password';
```

`:{?varname}` (true/false: is this variable defined) and `\if`/`\else`/
`\endif` have been in psql since Postgres 10 — safe on the `postgres:16-
alpine` image this stack already uses. `:'varname'` (colon + quotes)
substitutes the value as a properly-escaped SQL string literal, which is
what's needed inside `PASSWORD '...'`.

This means:
- **Local dev and CI need zero changes** — running `psql -f
  007_app_role.sql` with no `-v` flag falls through to the `\else`
  branch and creates the exact same `procurement_svc_dev_password` as
  before. Every existing verification step in this RUNBOOK, and
  `.github/workflows/ci.yml`'s `procurement-integration` job, works
  unmodified.
- **A real deployment overrides via `-v`, never by editing this file** —
  `psql -v procurement_svc_password=<real-secret-from-wherever> -f
  007_app_role.sql`. The real secret never touches a file in this repo,
  committed or otherwise; it only ever exists in whatever process invokes
  psql (a deploy script, a CI job with the value injected from a secrets
  manager as a masked pipeline variable, etc.) — see the "what a real
  deployment still needs" note below for why this repo can't provide
  that invoking process itself.

### Verification — real hash comparison, not just "the syntax parses"

- Ran the identical isolated pattern against a scratch role, confirmed
  via `pg_authid.rolpassword` that the stored SCRAM hash actually
  differs between a no-override run and a `-v`-overridden run (proving
  the substitution takes effect, not just that psql accepts the syntax).
- Ran all 21 migration files, in order, against a genuinely fresh
  `postgres:16-alpine` container (not the long-running dev one) with no
  `-v` overrides at all — the exact same invocation CI uses — confirmed
  every file including all 8 parameterized ones runs cleanly start to
  finish.
- Repeated `007_app_role.sql` alone against that same fresh container
  with `-v procurement_svc_password=a_totally_different_real_secret`,
  compared `pg_authid.rolpassword` before/after: the hash changed,
  confirming the override path works on the real file, not just the
  isolated mimic above.

### What a real deployment still needs (not built here, on purpose)

Every backend service was already 12-factor before this pass — Postgres/
Keycloak/Kafka credentials all come from `process.env`
(`@nestjs/config`), never a hardcoded value in application code. That
means the actual remaining gap isn't in this repo's code at all: a real
deployment needs an out-of-band provisioning step — a secrets manager
generating real per-environment credentials and injecting them as
environment variables (and as `psql -v` flags for the migration step
above) at container/job start, without ever writing them to a file this
repo tracks. Which specific tool (Vault, AWS Secrets Manager, Doppler, or
whatever the eventual hosting platform's own native mechanism is) is a
decision that depends entirely on where this actually gets deployed —
premature to pick now, and the code doesn't need to change regardless of
which one gets chosen later.

## Observability

Before this pass, `curl http://localhost:3001/health` returned a bare
`401` — there was no route at all, so `KeycloakAuthMiddleware` rejected
it like any other unauthenticated request, meaning nothing that isn't
already holding a Bearer token (not `docker-compose`'s own healthcheck
mechanism, not a real orchestrator's liveness probe, not a plain `curl`
during incident triage) could ever check if a service is up. Logging was
a single unstructured `console.log` on startup plus NestJS's default
plain-text framework output — the Go `ledger-service` was already ahead
here, logging structured JSON via `log/slog`. No request could be
followed across a service boundary (the platform's one synchronous
service-to-service call, `PostingAuthorityClient` -> governance-
service's `/authorization-check`, left two separate, uncorrelated log
streams). No metrics, no dashboards, nothing.

Scoped in two tiers, following the same reasoning as the TLS and secrets
passes before it: health checks, structured logs, and correlation ids
aren't speculative — every eventual deployment target needs them
regardless of which one gets chosen, and dev already benefits from them
today. A full Prometheus + Grafana stack is more debatable with no real
production traffic yet to make the dashboards load-bearing, but was
explicitly requested as a proof-of-pattern rather than deferred the way
a real secrets manager was in the previous pass — the scrape/dashboard
pipeline itself is real, verified against live-generated traffic below,
not just config that parses.

### 1. `packages/backend-common`'s new observability primitives

- **`request-context.ts`** — an `AsyncLocalStorage<{requestId}>`, not a
  request-scoped Nest provider: the logger needs to read the current
  request id from plain functions with no DI context of their own, and
  Nest's request-scoped providers add a per-request instantiation cost
  to the whole injection chain that this platform's request volume has
  no reason to pay for.
- **`request-id.middleware.ts`** — reuses an incoming `x-request-id` if
  the caller already set one, otherwise generates one with
  `crypto.randomUUID()` (Node stdlib, no new dependency for something
  this small); echoes it back as a response header. Registered FIRST in
  every service's `AppModule.configure()`, before `KeycloakAuthMiddleware`
  — a request that fails auth still gets a request id on its log line.
- **`structured-logger.ts`** — `StructuredLogger implements LoggerService`,
  one JSON object per line, hand-rolled instead of pulling in
  `pino`/`winston` (~80 lines, zero third-party dependency, matching this
  repo's established preference — see `keycloak-auth.ts`'s doc comment on
  choosing `jsonwebtoken`/`jwks-rsa` over `jose` for the same reason).
  `app.useLogger(new StructuredLogger(serviceName))` in each `main.ts`
  retroactively affects every `new Logger(context)` call already in that
  service's code — Nest's `Logger` class delegates every instance's
  methods to whatever `useLogger` installs (`Logger.overrideLogger`,
  what `useLogger` calls internally), so no individual call site anywhere
  needed to change. `{ bufferLogs: true }` on `NestFactory.create` holds
  Nest's own bootstrap logs until `useLogger` runs, so even module-
  loading output comes out as JSON instead of a few lines of the old
  format slipping through first.
- **`health.controller.ts`** — `GET /health`, `@SkipThrottle()`'d (opts
  out of `RateLimitModule`'s flat per-IP cap, since a health check can
  legitimately be polled far more often than real traffic). The route
  alone doesn't make it unauthenticated — each service's
  `KeycloakAuthMiddleware` exclusion does that.
- **`metrics.module.ts`** — `GET /metrics` in Prometheus's text exposition
  format. One `prom-client` `Registry` per service process
  (`MetricsModule.forRoot(serviceName)`, a dynamic module, same pattern
  `ThrottlerModule.forRoot(...)` already uses in `rate-limit.module.ts`),
  seeded with `collectDefaultMetrics` (process CPU/memory/event-loop-lag/
  GC, all free) plus an `http_requests_total` counter and
  `http_request_duration_seconds` histogram a global `APP_INTERCEPTOR`
  fills in for every request, both labeled `method`/`route`/`status_code`
  plus a `service` default label so Prometheus can tell services apart
  without relying on the scrape target address alone.
- **`posting-authority.client.ts`** — now forwards the caller's own
  `x-request-id` (read from `request-context.ts`) as a header on both its
  outbound calls to governance-service, so one inbound request's logs can
  be followed into governance-service's own log stream too — the
  platform's first and so far only synchronous service-to-service call,
  exactly the case correlation ids exist for.

### 2. Wired into all 8 Node services

Each service's `main.ts` and `app.module.ts` follow the identical new
pattern (`governance-service` is the one exception, layering this
alongside its own bespoke `KeycloakAuthMiddleware`/
`TenantContextMiddleware` rather than the shared one):

```ts
// main.ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(new StructuredLogger('procurement-service'));
```

```ts
// app.module.ts
imports: [..., HealthModule, MetricsModule.forRoot('procurement-service'), ...],
// configure():
consumer.apply(RequestIdMiddleware).forRoutes('*');
consumer.apply(KeycloakAuthMiddleware).exclude('health', 'metrics').forRoutes('*');
```

`prom-client` and `rxjs` (the latter already present transitively via
`@nestjs/core` but never declared) were added to `backend-common`'s
`package.json` — `dependencies` and `peerDependencies` respectively — so
this required the same full clean reinstall
(`rm -rf node_modules package-lock.json && npm install`) per consuming
service already established as this monorepo's standing playbook for any
backend-common dependency change (bitten twice before: `helmet`, then
`@nestjs/throttler`).

### 3. `ledger-service` (Go) — a health/metrics server it never had

Unlike the 8 Node services, `ledger-service` had zero HTTP surface before
this — a pure Kafka consumer, blocking loop, no `net/http` anywhere. A
new `internal/observability` package adds a side HTTP server
(`internal/observability/server.go`, started in its own goroutine
alongside the consumer loop in `cmd/ledger-service/main.go`, port
`OBSERVABILITY_PORT` / default `9101`) exposing `/health` and `/metrics`
(`github.com/prometheus/client_golang`'s `promhttp.Handler()`), plus
three metrics meaningful to what this service actually does — it has no
request traffic for a generic HTTP counter to measure the way the Node
services' does:

- `ledger_events_consumed_total` — every message read off the topic.
- `ledger_events_failed_total` — events that hit an error (the posting
  engine's own separate `failed_posting_review` queueing, SDD §4.2, is
  unrelated data-layer bookkeeping this metric doesn't replace).
- `ledger_posting_duration_seconds` — a histogram wrapping each
  `handle()` call, Kafka delivery to commit/failure-record.

**A real constraint this surfaced**: the latest `client_golang` (v1.24.x)
pulls in transitive dependencies whose own `go.mod` require Go 1.25+,
and `go get`/`go mod tidy` silently bumped this module's `go` directive
to match — which would have broken `.github/workflows/ci.yml`'s pinned
`go-version: '1.22'` the next time CI ran. Pinned to `client_golang
v1.20.5` instead (confirmed via a real `go mod tidy` run that the `go`
directive stays at `1.22`), the newest release that doesn't drag the
toolchain requirement up. A real Go 1.25 upgrade across this module is a
separate, deliberate decision, not something this pass should force as a
side effect of adding a metrics client.

### 4. Prometheus + Grafana in `docker-compose.yml`

`infra/prometheus/prometheus.yml` — a static target list (this
platform's own fixed, known set of services, nothing that needs service
discovery), scraping all 8 Node services + `ledger-service` via
`host.docker.internal` on their existing ports, the same pattern the
nginx gateway already uses to reach them (they run on the host, not in
this compose network). `grafana` is pre-provisioned
(`infra/grafana/provisioning/`) with the Prometheus datasource (fixed
`uid: prometheus-ds`, referenced explicitly by every panel) and one
dashboard (`infra/grafana/dashboards/metrock-platform-overview.json`,
tracked as a real file, not clicked together in the UI and lost on
container recreation): HTTP request rate/5xx error rate/p95 latency per
service, process RSS per service, and `ledger-service`'s three custom
metrics. Both new host ports — `9090` (Prometheus) and `3000` (Grafana)
— confirmed free against everything else this stack already uses.
`GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` follow the exact same
override-via-`infra/.env` convention as the Postgres/MinIO/Keycloak-admin
credentials (`infra/.env.example`, "Secrets in production" above) —
default `admin`/`admin`, not a real secret, same reasoning.

### 5. Verification — real data, not just config that parses

- All 8 Node services' `/health` returned real `200`s unauthenticated
  after restarting with the new wiring; `/metrics` returned real
  Prometheus-format text with the correct `service` label.
- Structured JSON confirmed in each service's actual log output,
  including Nest's own bootstrap lines (module loading, route mapping)
  coming out as JSON via the `bufferLogs` + `useLogger` sequencing, not
  just the one hand-written startup message.
- **Correlation id, both directions, proven separately for real:**
  - *Receiving*: sent a real request to governance-service's
    `/authorization-check` with a manually-set `x-request-id` and a
    tenant id that doesn't exist, deliberately forcing a real error deep
    in `AuditService`'s Prisma transaction — the resulting structured
    error log, several async layers past the middleware, carried the
    exact `x-request-id` supplied, proving the id survives real nested
    async/await chains, not just a flat request handler.
  - *Sending*: `request-context.ts`'s `AsyncLocalStorage` mechanism
    (what `PostingAuthorityClient` relies on to forward the current
    request's id) tested directly with real Node execution — two
    concurrent simulated requests, each with its own id, resolved
    correctly and without cross-contamination after multiple `await`
    hops, confirming the context is safely isolated per-request under
    concurrency, not just correct in a single sequential case.
- `docker compose up -d prometheus grafana` — both started cleanly;
  `curl http://localhost:9090/api/v1/targets` showed all 9 scrape targets
  (`up`, zero errors) once every service was restarted with the new
  `/metrics` route.
- Logged into Grafana for real (`http://localhost:3000`, dev default
  credentials) and viewed the actual provisioned dashboard rendering real
  scraped data — then generated real HTTP traffic against
  procurement-service and watched the "HTTP request rate by service"
  panel spike live, confirming the whole pipeline end-to-end rather than
  trusting that scrape configs and panel JSON were merely well-formed.

### Known gaps after this pass

- **No real alerting pipeline** — still a structured log line for things
  like an authorization bypass attempt, not an actual email/Slack/pager
  integration (unchanged from the pre-existing "known, not solved" gap;
  Grafana can alert off these same Prometheus metrics, but no alert
  rules or a notification channel are configured).
- **No distributed tracing** (OpenTelemetry spans) — correlation ids let
  you grep the same id across two services' logs by hand; there's no
  automatic trace visualization tying a request's full cross-service
  timeline together the way Jaeger/Tempo would.
- **No log aggregation** — each service's structured JSON still only
  goes to its own stdout/log file; nothing centralizes it (Loki, ELK, or
  similar) for cross-service querying without SSHing/grepping each one.
- **Prometheus/Grafana have no persistence/backup story of their own** —
  `.prometheus-data`/`.grafana-data` are plain bind-mounted directories,
  gitignored, with no retention policy tuned beyond Prometheus's default.
- Not part of `.github/workflows/ci.yml` — same reasoning as every other
  dev-stack infra pass; nothing in the automated test suite exercises
  `/health`/`/metrics` or the Prometheus/Grafana containers.

## Machine-to-machine auth

Closed the platform's one remaining stub-auth path: governance-service's
`/authorization-check` and `/approval-check` — called by
`PostingAuthorityClient` from `procurement-service`, `sales-service`,
`accounting-service`, `fleet-service`, and `hr-service` — used to trust a
plain `x-tenant-id` header with zero verification of who was actually
calling. Everything ELSE in the platform, including every user-facing
route, already verified a real Keycloak token; this was the single
exception, and its own doc comment said as much (`TenantContextMiddleware`:
"this class now has exactly one caller left in the whole platform").

Unlike TLS/observability/secrets, this gap didn't split into a
narrower-vs-broader scope choice — one architectural seam (one call
pattern, two endpoints, five callers), so there was no smaller slice to
carve off; fixing it meant fixing it completely.

### 1. Five Keycloak service-account clients

`infra/keycloak/realm-export.json` gained one confidential client per
calling service (`procurement-service`, `sales-service`,
`accounting-service`, `fleet-service`, `hr-service`) — `publicClient:
false`, `serviceAccountsEnabled: true`, no redirect URIs (not a browser
flow), a well-known dev secret (`<service>-m2m-dev-secret`) following the
same "documented non-secret local default, override via a real
deployment's secrets manager" pattern the "Secrets in production"
section above established. The client id doubles as the value Keycloak
stamps into the `azp` claim of any token it mints — that's what
governance-service checks against its allow-list, not a separate role or
scope.

### 2. `packages/backend-common`'s new M2M primitives

- **`keycloak-auth.ts`'s `verifyM2MToken`** — a deliberately SEPARATE
  function from `verifyKeycloakToken`, not a branch inside it. A
  service-account token carries no `tenant_id`/`local_user_id` (those
  are USER attributes, set at provisioning time by
  `infra/keycloak/seed-users.sh`; a service account is a synthetic
  identity with none), so requiring them the way `verifyKeycloakToken`
  does would reject every valid M2M token. This verifies signature +
  issuer (same JWKS client/cache as the user-token path) and extracts
  `azp` (falling back to `client_id`) — proving the token is genuine and
  naming who issued it, nothing more; checking that name against an
  allow-list is the CALLER's job.
- **`m2m-token.client.ts`'s `M2MTokenClient`** — mints and caches a
  client-credentials-grant token for one service's own registered
  client, re-minting only within 30 seconds of expiry (Keycloak's
  client-credentials default lifetime is 5 minutes) — the same
  early-refresh margin `AuthClient` uses on the Flutter side
  (`getValidAccessToken`), so a burst of calls doesn't mint a token per
  request.
- **`m2m-auth.middleware.ts`'s `M2MAuthMiddleware`** — replaces
  `TenantContextMiddleware` in front of governance-service's two
  service-to-service routes. Verifies the bearer token
  (`verifyM2MToken`), checks its `azp` against
  `M2M_ALLOWED_CLIENT_IDS` (comma-separated, governance-service's own
  `.env` — not shared globally, this is specifically "who am I willing
  to accept calls from"), THEN populates `req.tenantContext` from
  `x-tenant-id`/`x-user-id`/`x-device-id` exactly like
  `TenantContextMiddleware` used to — that data still travels as plain
  headers (a service-account token has no tenant of its own to assert;
  it authenticates WHICH SERVICE is calling, not a user or tenant), now
  just gated behind proof of the caller's identity instead of trusted on
  its word alone. No constructor dependencies, like the shared
  `KeycloakAuthMiddleware` — reads both env vars directly, so
  `consumer.apply(M2MAuthMiddleware)` needs no factory provider.
- **`posting-authority.client.ts`** — `PostingAuthorityClient` now takes
  an `M2MTokenClient` as a second constructor arg; its `headers()`
  helper (already forwarding the caller's correlation id, from the
  observability pass) became `async` and attaches
  `Authorization: Bearer <token>` alongside the still-present
  `x-tenant-id`.

### 3. `TenantContextMiddleware` — deleted, not deprecated

Once `M2MAuthMiddleware` took over its one remaining caller, the class
had zero callers left anywhere in the platform — removed outright rather
than left as unreachable code with a comment explaining why nobody calls
it. The `TenantContext` interface and its Express `Request` augmentation
stayed (still genuinely used — by `M2MAuthMiddleware`, by
`@CurrentTenant()`, by `AuthorizationService`), so `tenant-context.middleware.ts`
keeps its name and its exports, just without the middleware class that
originally justified the filename.

### 4. Wiring — five calling services, one receiving service

Each calling service's `common/governance.module.ts` (or, for
`procurement-service`, its inline factory provider — it has no
`governance.module.ts` wrapper) now builds an `M2MTokenClient` from
`KEYCLOAK_ISSUER` (already set, reused as-is — the SAME issuer every
service already verifies USER tokens against, so a minted M2M token's
`iss` automatically matches what governance-service expects, no new
issuer config needed) plus two new env vars, `M2M_CLIENT_ID` and
`M2M_CLIENT_SECRET`, and passes it into `PostingAuthorityClient`.
`governance-service/.env` gained `M2M_ALLOWED_CLIENT_IDS` — the five
client ids, comma-separated. This required the same full clean reinstall
(`rm -rf node_modules package-lock.json && npm install`) per consuming
service already established as this monorepo's standing playbook for
any backend-common dependency/export change.

### 5. Verification — real tokens, a real allow-list bypass attempt, a real transaction

- `curl` with no `Authorization` header → real `401`; with a
  syntactically-garbage bearer token → real `401`.
- Minted a real client-credentials token for `procurement-service`
  (`grant_type=client_credentials` against the actual HTTPS Keycloak
  listener) and sent it → passed the auth layer (reached real business
  logic, which itself 500'd on a deliberately fake tenant id — the same
  downstream error the observability pass used to prove correlation-id
  propagation, here repurposed to prove this request got PAST
  `M2MAuthMiddleware` rather than being rejected by it).
- **Allow-list bypass attempt, not just "does auth work at all"**:
  registered a throwaway sixth Keycloak client
  (`not-a-real-backend-service`, real `serviceAccountsEnabled: true`,
  genuinely mintable token, real valid signature) NOT on
  `M2M_ALLOWED_CLIENT_IDS`, minted a real token for it, and confirmed
  governance-service rejected it with a real `403` naming the rejected
  client — proving the allow-list is actually enforced, not just that
  token verification works. Deleted the throwaway client afterward.
- **A real, complete business transaction**, not a synthetic curl
  simulating one: recorded a real payment against a seeded OPEN vendor
  bill through `accounting-service` (a real user's Keycloak token,
  `POST /vendor-bills/:billId/payments`) — this only succeeds if
  `BillsService` → `PostingAuthorityClient` → `M2MTokenClient` (mint) →
  governance-service's `M2MAuthMiddleware` (verify + allow-list) →
  `AuthorizationService.checkAuthority` (the real can_post decision) all
  worked, in that exact order, through the ACTUAL code path — not
  hand-constructed headers. The bill's status flipped from `OPEN` to
  `PAID` in the database, real proof, not a mocked assertion.
- Confirmed no regression on governance-service's unrelated user-facing
  routes (`GET /plants` with a real Bearer token still `200`s, still
  `401`s with none) — this pass touched shared middleware ordering in
  `AppModule.configure()`, worth checking nothing else moved.
- All 50 existing Jest tests across the 6 touched services (governance,
  procurement, sales, accounting, fleet, hr) still pass unmodified —
  they mock `PostingAuthorityClient` at the boundary, so the M2M token
  change is invisible to them, as it should be.

### Known gaps after this pass

- `M2M_ALLOWED_CLIENT_IDS` is governance-service's own env var, manually
  kept in sync with which Keycloak clients actually exist — nothing
  automatically derives one from the other.
- The 5 new client secrets follow the same "well-known local dev
  default, real deployment rotates via a secrets manager" story as every
  other credential in this repo (see "Secrets in production" above) —
  not yet parameterized the SQL-migration way (`psql -v` with a
  same-as-before fallback); these live in realm-export.json as literals
  and each service's own gitignored `.env`, matching how `metrock-mobile`
  and `metrock-test-client` are already defined in the same file.
- No token refresh/retry hardening beyond `M2MTokenClient`'s own 30-second
  early-refresh margin — `PostingAuthorityClient`'s own doc comment
  already flags "no circuit breaker, retry, or explicit timeout" as an
  accepted gap for this one synchronous call, unchanged by this pass.
- Not part of `.github/workflows/ci.yml` — same reasoning as the other
  infra passes; nothing in the automated test suite mints a real
  Keycloak token end-to-end (Phase 1-2's mocked unit tests stub
  `PostingAuthorityClient` entirely, Phase 3's real-Postgres integration
  tests don't touch governance-service).

## NestJS 10→11 migration

Closes the npm audit reachability analysis's own conclusion: real
exposure was "one DoS chain worth eventually patching," and the honest
fix — a real major-version migration, verified with the same rigor as
everything else in this repo — "hasn't been scheduled." It's scheduled
now.

### Why this couldn't be staggered service-by-service

`@metrock/backend-common` declares `@nestjs/common`/`@nestjs/core` as
`peerDependencies` — every one of the 8 services installs it via
`file:` (copied, not symlinked, `install-links=true`, this monorepo's
established gotcha). Widening those peer ranges is a change to
`backend-common` itself, which every consumer picks up on its next
install regardless of whether IT was "supposed" to be touched yet — so
there's no clean way to migrate one service while backend-common stays
on v10. The migration is one coordinated pass by construction, not a
choice to batch it that way.

### The real risk: Express 4→5, and one pattern used by every service

`@nestjs/platform-express@11` bundles Express 5 (was Express 4) — a
major version with real breaking changes, chief among them a new
path-to-regexp release that changed route-pattern matching syntax.
That matters here specifically because `consumer.apply(...).forRoutes('*')`
is the pattern gating every service's `RequestIdMiddleware` and
`KeycloakAuthMiddleware`/`M2MAuthMiddleware` — the wildcard IS the
auth-and-observability backbone across this whole platform. If Express
5's matching engine silently stopped matching that wildcard the way
Express 4 did, it would not fail a build or throw an exception — it
would just mean middleware silently stopped running, i.e. a platform-
wide auth bypass indistinguishable from "everything looks fine" until
someone noticed unauthenticated requests succeeding. That single
possibility shaped the whole rollout order below: prove it on one
service with real live requests before touching the other seven.

Confirmed the other likely friction points before starting, not
assumed away:
- Node 20+ required by `@nestjs/core@11` — CI and local dev already on
  Node 20 (`.github/workflows/ci.yml`), no change needed.
- `@nestjs/throttler@6.5.0` (already pinned, the rate-limiting pass)
  already declares peer support for `@nestjs/core@^11.0.0` — confirmed
  via `npm view`, no version bump needed for that package at all.
- `@types/express` is a DIRECT devDependency in all 8 services'
  `package.json` (the standard Nest CLI scaffold default) plus
  `backend-common` — not just inherited transitively from
  `@nestjs/platform-express` — so all 9 needed an explicit 4→5 bump for
  the 5 files that `import { Request, Response, NextFunction } from
  'express'` directly (`backend-common`'s middleware files,
  `governance-service`'s own bespoke `keycloak-auth.middleware.ts`) to
  typecheck against the new Express types.

### Version set (all 9 packages, identical)

`@nestjs/common`/`@nestjs/core`/`@nestjs/platform-express` →
`^11.2.1`, `@nestjs/config` `^3.3.0` → `^4.0.4`, `@nestjs/cli`
`^10.4.5` → `^11.0.24` (this is the literal `nest build`/`nest start`
command every service's `package.json` scripts and this whole session's
own dev-restart loop depend on, not a peripheral dev tool),
`@nestjs/testing` → `^11.2.1`, `@types/express` `^4.17.21` → `^5.0.6`.
`backend-common`'s own `peerDependencies` for `@nestjs/common`/
`@nestjs/core`/`express` bumped to match (`express` peer range to
`^5.0.0`).

### Rollout: pilot first, then the rest

1. Bumped `backend-common` + `procurement-service` together (the
   smallest possible coordinated unit, per the constraint above). Full
   clean reinstall, clean `tsc --noEmit`, a real `nest build` (exercises
   the CLI bump, not just the library packages), all 8 existing Jest
   tests passing unmodified.
2. **Live-verified the one real risk before rolling further** — restarted
   procurement-service for real and hit it with actual HTTP requests:
   `GET /purchase-orders` with no token → real `401` (wildcard-gated auth
   still blocking); `GET /health` and `GET /metrics` → real `200`s with no
   token (`.exclude()` still bypassing correctly); `GET /purchase-orders`
   with a real Keycloak token → real `200`. The wildcard match held under
   Express 5 — confirmed, not assumed from "the tests passed."
3. Rolled the identical version set to the remaining 7 services. Full
   clean reinstall + `tsc --noEmit` + real `nest build` for each — all
   clean.
4. All 62 existing Jest tests across all 8 services still pass,
   unmodified — these mock at layer boundaries that don't touch Express
   routing directly, so this was the expected (and confirmed) outcome,
   not the risky part.
5. Re-ran procurement-service's real-Postgres integration suite (Phase
   3's RLS cross-tenant-isolation proof + real-SQL over-receipt/approval
   persistence checks) — all 6 passing against actual Postgres, not
   mocked.
6. Restarted the full 8-service stack and spot-checked the cross-cutting
   things earlier passes built that also touch routing/middleware, since
   this migration's blast radius genuinely does cover all of them:
   - TLS gateway routing (`https://localhost:8443/procurement/purchase-orders`
     with a real token) — real `200`.
   - `helmet` response headers (`X-Content-Type-Options`,
     `X-Frame-Options`) — still present.
   - The full machine-to-machine auth chain, end to end, through actual
     application code: a real vendor-bill payment via accounting-service
     (`POST /vendor-bills/:billId/payments`) that only succeeds if
     `M2MTokenClient` mints a token, `PostingAuthorityClient` sends it,
     governance-service's `M2MAuthMiddleware` verifies + allow-lists it,
     and `AuthorizationService.checkAuthority` grants it — real `201`,
     real `billStatus` change in the database (`OPEN` → `PARTIALLY_PAID`),
     not a hand-built curl standing in for the real code path.
7. `npm audit` across all 9 packages: **0 vulnerabilities**, down from
   23-24 each — confirmed after the full migration, not assumed from the
   package.json diff alone.

### Known gaps after this pass

- `@nestjs/config`'s v3→v4 migration notes were reviewed for breaking
  changes but this repo's own usage (`ConfigModule.forRoot({ isGlobal:
  true })`) is about as minimal as that API gets — no behavior change
  observed or expected beyond what the test/live-request verification
  above already covers.
- Not part of `.github/workflows/ci.yml` as its own gate — the existing
  `node-services` matrix job's `npm install`/`npm run build`/`npm test`
  steps exercise the new versions on every future push the same way they
  exercised v10 before, so no separate CI step was needed; this is a
  dependency version change, not new infrastructure.

## Backup & restore

Before this pass: Postgres data lived only in `infra/.pgdata/`, a
bind-mounted directory on the host — survives a container restart or
`docker compose down`/`up`, but not a lost/reformatted disk, and with no
tested procedure for getting it back regardless. Scoped narrow on
purpose, the same reasoning as the secrets-manager and observability
passes before it: a real production DR story (continuous WAL archiving,
point-in-time recovery, automated retention) depends entirely on
whichever managed Postgres or self-hosted setup this eventually runs on,
none of which exists yet — building that now would be real
infrastructure for an environment that doesn't exist. What's genuinely
useful regardless of hosting target: an on-demand backup/restore
capability, actually proven to work, not just a script that's never
been run against a real recovery scenario.

### `infra/postgres/backup.sh` / `restore.sh` — data only, not schema

Both run `pg_dump`/`pg_restore` inside the running postgres container
via `docker exec` — no local psql/pg_dump client needed (this machine
doesn't have one; every SQL verification earlier in this project went
through the container the same way). Custom format (`-F custom`),
compressed, dependency-ordered restore.

Deliberately **data-only**, not schema+data. Schema already has a
canonical source of truth — `infra/postgres/migrations/*.sql`, reviewed
and tested far more rigorously than anything a point-in-time dump could
claim to be. Baking a second copy of the schema into every dump would
just be a second thing that can drift out of sync with the first
(a dump taken before a migration lands would silently disagree with
`HEAD`). `restore.sh` assumes the target database's schema is already
current — run the migrations first, exactly like setting up any fresh
environment — then restores exactly the data, with
`--disable-triggers` to skip FK re-validation during the restore
itself (safe: the data was already valid at the source, and this
doesn't change any of it).

This is real DR discipline, not incidental — it also means a stale
dump can never "win" against the current schema by accident the way a
schema+data dump restored onto an older migration state could.

### Verification — a real backup, a real disposable recovery, not just "the script ran"

An untested backup is not a backup; the whole point of this pass was
proving the restore path actually works, not just that `pg_dump` exits
0.

1. Ran `backup.sh` for real against the live dev database (56K,
   compressed) — `pg_dump` itself warned about a genuine circular FK
   between `recipes`/`recipe_versions` needing `--disable-triggers` to
   restore, confirming that flag in `restore.sh` isn't defensive
   boilerplate, it's necessary for this exact schema.
2. Spun up a genuinely fresh, disposable `postgres:16-alpine` container
   (not the persistent dev one) — no data, no schema, nothing carried
   over.
3. Ran all 21 migration files against it, recreating schema and all 8
   least-privilege roles from scratch.
4. Ran `restore.sh` against that freshly-migrated, still-empty-of-data
   container — restored cleanly, no errors.
5. Compared row counts, table by table, between the restored database
   and the live source it was backed up from
   (`purchase_orders`/`goods_receipts`/`customers`/`vehicles`/
   `employees`/`journal_entries`/`recipes`) — every single one matched
   exactly.
6. **The real proof**: started an actual `procurement-service` instance
   pointed at the restored database (a scratch port, `DATABASE_URL`
   aimed at the disposable container) and hit its real
   `GET /purchase-orders` endpoint with a real Keycloak-authenticated
   request — got real business data back (`PO-2026-00001`, `OPEN`,
   among 10 real purchase orders), served through the actual
   application code path, not a `SELECT count(*)` standing in for "the
   app can use this." Confirms the restored database isn't just
   byte-identical rows sitting in tables — it's genuinely usable by a
   running service.
7. Cleaned up the disposable container and scratch service instance
   afterward; confirmed the port was actually freed, not just that the
   `pkill` command returned success.

### Known gaps after this pass

- On-demand only — no scheduled/automated backups. A dev stack that
  isn't running unattended 24/7 has less need for this than a real
  deployment would, and adding a cron sidecar now would be exactly the
  kind of speculative always-on infrastructure this pass deliberately
  scoped away from.
- No off-host copy — `infra/.backups/` is still on the same disk as
  `infra/.pgdata/` itself. A real deployment needs backups shipped
  somewhere else entirely (object storage, a different region/host) to
  actually survive the failure modes backups exist for; this local
  dump-file mechanism doesn't attempt that.
- Restore is scoped to "recover into an empty, freshly-migrated
  database," not "merge a backup on top of already-live data" — a
  harder, higher-stakes operation (conflict resolution, partial
  restores, point-in-time selection) this pass didn't try to solve
  generically. `restore.sh`'s own header comment says as much.
- The 5 migration files that mix schema DDL with reference-data
  `INSERT`s (`008_manufacturing.sql`, `010_sales_agent_capital.sql`,
  `014_accounting.sql`, `017_fleet.sql`, `019_hr_payroll.sql`) mean a
  full-database restore could in principle hit a primary-key conflict
  on those specific reference rows if the dump also captured them —
  didn't happen in this pass's real test (the restored dump apparently
  didn't collide with the migration-seeded rows), but isn't
  structurally guaranteed against for every possible future migration;
  worth knowing about rather than assuming away.
- Not part of `.github/workflows/ci.yml` — same reasoning as every
  other dev-stack infra pass; this is an operational script, not
  something the automated test suite exercises on every push.

## Finance connector — a new custom module, not Zoho/QuickBooks

`integration_queue` (005_finance.sql) has existed since the Unified Ledger
shipped: ledger-service's Go `PostingEngine` already wrote a `PENDING` row
for every posted journal entry, keyed by `tenant_registry
.finance_connector_type`. Nothing ever consumed those rows — the SDD
scoped the consuming side as an optional "Finance Connector Framework"
targeting Zoho Books/QuickBooks/Xero/SAP, none of which this platform
actually integrates with. The dev seed's tenant had `finance_connector_type
= 'ZOHO_BOOKS'` since the very first Governance-slice seed, purely
aspirational — there was never a real Zoho account behind it, so 49 real
journal entries across every module sat `PENDING` indefinitely, silently
never synced anywhere.

This pass builds the consuming side for real, but targeting Metrock's own
custom-built finance module instead of a third-party SaaS product —
explicit user direction, not a default assumption. `integration_queue`'s
schema doesn't hardcode Zoho at all (`external_system` is a plain text
column, `'NONE'` default), so this isn't fighting the design; it's
finishing the half that was never built.

### 1. Why a new standalone service, not a module bolted onto an existing one

Three placements were considered: inside `accounting-service` (financially
adjacent), inside `ledger-service`'s existing Go codebase (already owns the
producer side), or a new standalone NestJS service. The new service won:
`ledger-service` is a trusted background batch consumer that intentionally
runs as the Postgres superuser (007_app_role.sql's comment) — a different
trust model than a request-serving module with its own least-privilege
role, RLS-scoped reads, and a real HTTP surface (`/health`, `/metrics`,
`GET /external-postings`). Bolting a sync worker onto accounting-service
would couple its uptime and blast radius to the accounting API's. A new
service, `finance-connector-service` (port 3009), follows the exact same
scaffold every other domain service already uses — see `backend/crm-
service` as the closest template (no M2M client, no `PostingAuthorityClient`,
just Prisma + Keycloak auth + the observability primitives).

### 2. `tenant_registry.finance_connector_type` gets a new value, not a replacement

`025_finance_connector.sql` adds `'CUSTOM_MODULE'` to the existing CHECK
constraint (`NONE`, `ZOHO_BOOKS`, `QUICKBOOKS`, `XERO`, `SAP`) rather than
replacing those values — a real resold tenant on this platform may
genuinely want an actual Zoho/QuickBooks connector later, and the SDD's
per-tenant connector choice should keep room for that. `dev_seed.sql`'s
Metrock row moves from `'ZOHO_BOOKS'` to `'CUSTOM_MODULE'`; the 49 real
`PENDING` rows already queued under the old, never-consumed value were
backfilled live (`UPDATE integration_queue SET external_system =
'CUSTOM_MODULE' WHERE external_system = 'ZOHO_BOOKS' AND queue_status =
'PENDING'`) so the new connector actually has the full historical backlog
to prove itself against, not just a synthetic test row.

### 3. `external_ledger_postings` — what the custom module actually stores

A new table (`025_finance_connector.sql`), owned by `finance-connector-
service`, RLS-enabled the same way as every other tenant table. One row
per synced `integration_queue` row, not a live join back to
`journal_entries`/`journal_lines` — a real external system's own ledger
mirror wouldn't stay joined to the Unified Ledger after ingesting a
posting, so `lines_json` snapshots that entry's full set of GL lines
(`account_code`/`debit_amount`/`credit_amount`/`cost_center_plant_id`) at
sync time. `UNIQUE (tenant_id, queue_id)` is the idempotency backstop —
see below for why it matters more than it looks like it should.

### 4. `FinanceConnectorService` — the first cross-tenant background job in this codebase

Every other NestJS service in this platform is request-scoped: an
incoming call carries `x-tenant-id`, `KeycloakAuthMiddleware` verifies it,
and `PrismaService.forTenant` scopes the rest of that one request. A
background poller has no request to inherit a tenant from, so
`pollAllTenants` enumerates `tenant_registry` itself each tick (a plain,
non-RLS-scoped query — `tenant_registry` was never in `006_rls.sql`'s
`tenant_tables` array) for tenants configured with
`financeConnectorType = 'CUSTOM_MODULE'`, then runs one `forTenant`-scoped
pass per tenant — same session-variable RLS mechanism every request-scoped
service already relies on, just driven by a `setInterval` instead of a
controller. No `@nestjs/schedule` dependency — this is the only scheduled
job anywhere in the codebase, so a new package for one timer would be
exactly the premature abstraction this codebase avoids elsewhere.

Per pending row (`POLL_INTERVAL_MS`, default 5000ms; batch size 20 per
tenant per tick), each processed in its OWN transaction so one bad row
never blocks the rest of the batch:

1. Looks up the source `journal_entries` row (+ its `journal_lines`) by
   `integration_queue.source_record_id` — not `payload_json`, which is the
   raw domain event, not a GL-shaped posting. Missing entry → treated as a
   processing failure (see retry/escalation below); this should never
   happen in practice (ledger-service writes the queue row in the same
   transaction as the journal entry, 005_finance.sql/posting_engine.go),
   so a real occurrence would mean something is genuinely wrong, not a
   normal race to tolerate silently.
2. `externalLedgerPosting.upsert` (not `.create`) against the
   `(tenantId, queueId)` unique constraint, `update: {}` on conflict — the
   idempotency mechanism. A plain `.create()` + catching the resulting
   `P2002` inline would NOT work here: Prisma's interactive transactions
   don't savepoint each statement, so a caught constraint violation still
   leaves the surrounding transaction unusable for any further query
   (Postgres marks the whole transaction block aborted, not just the one
   statement) — the queue-status update immediately after would itself
   fail with "current transaction is aborted." `upsert` sidesteps this
   entirely: no exception is ever thrown, and its return value is
   whichever row actually exists — freshly inserted, or already there from
   a prior attempt that crashed between this insert and the next step.
3. Marks `integration_queue` `POSTED`, using the `postedExternalId` FROM
   THAT RETURNED ROW, not a freshly generated one — so a crash-and-retry
   converges on the id that was actually stored, not a new orphaned one.

On failure: `retryCount` increments; below `MAX_RETRIES` (3) the row stays
`PENDING` with `lastErrorMessage` set, for the next tick to retry; at the
threshold, `queueStatus` becomes `FAILED` and a `failed_posting_review` row
opens — reusing the exact table `ledger-service`'s own Go `recordFailure`
already writes to for its own, unrelated failure class (no posting rule
found), giving Operations one review queue instead of two.

### 5. `GET /external-postings`

Read-only verification endpoint, same list-endpoint convention as every
other module (`@CurrentTenant()`, standard Keycloak auth, no special
role/approval gate — this is a read, like `GET /production-batches` or
`GET /purchase-orders`). No M2M client anywhere in this service — unlike
every request-serving domain service's `PostingAuthorityClient`, this
poller never calls `governance-service`: it's an automated background
relay, not a user-initiated posting action, the same reasoning
`ledger-service`'s own `PostingEngine` already relies on to skip
authority checks entirely.

### 6. Verification — real backlog, real failure, real RLS

Against the actual dev database, not mocks:

1. Applied `025_finance_connector.sql` live; confirmed the new
   `finance_connector_svc` role, `external_ledger_postings` table, and RLS
   policy all exist as expected.
2. Flipped the live tenant's `finance_connector_type` to `'CUSTOM_MODULE'`
   and backfilled the 49 real orphaned `PENDING` rows (procurement,
   manufacturing, accounting, fleet, sales, hr — every module that had
   ever posted through `ledger-service`) to the new connector type.
3. Started `finance-connector-service` for real
   (`NODE_EXTRA_CA_CERTS`-aware, same restart pattern as every other
   service). Within one poll tick, all 49 backlogged rows synced: `queue_
   status` flipped to `POSTED` on every one, and `external_ledger_postings`
   gained exactly 49 rows. Spot-checked one (a real GRN posting,
   `procurement`/`grn.posted.v1`) — `lines_json` carried the actual
   account codes (`1310`/`2110`), amounts, and plant id from the real
   journal entry, `posted_external_id` correctly `CUSTOM-<uuid>`-shaped.
4. `GET /external-postings` with a real Keycloak token
   (`chidinma.eze@metrock.dev`) returned exactly that data; the same
   request with no token returned a real `401`.
5. Forced a real failure: inserted a synthetic `PENDING` row pointing at a
   nonexistent `journal_entry_id`. Watched three real poll cycles (~15s)
   escalate it — `retry_count` incrementing 1 → 2 → 3 in the structured
   logs and the database in lockstep, `queue_status` finally flipping to
   `FAILED` with a matching `failed_posting_review` row (`review_status =
   OPEN`) — then cleaned up the synthetic row.
6. RLS smoke test: `finance_connector_svc` connecting directly and setting
   `app.tenant_id` to an unrelated tenant returned `0` rows from
   `external_ledger_postings` despite 49 real rows existing for the actual
   tenant.
7. Jest suite (`finance-connector.service.spec.ts`, 5 tests, mocked
   Prisma): the happy path's `lines_json` shape, the idempotent-upsert
   case (asserting the queue update uses the upsert's RETURNED
   `postedExternalId`, not a freshly generated one — the specific
   behavior the aborted-transaction gotcha above makes worth locking
   down), under-threshold retry, and threshold escalation with the
   `failed_posting_review` row. Added to `.github/workflows/ci.yml`'s
   Node-services matrix.

### Known gaps after this pass

- Single connector type wired up end-to-end (`CUSTOM_MODULE`) — `ZOHO_
  BOOKS`/`QUICKBOOKS`/`XERO`/`SAP` remain valid `tenant_registry` values
  for a future real tenant, but no actual connector logic exists for any
  of them; a tenant configured with one today would queue rows forever
  with nothing to consume them, exactly the bug this pass just fixed for
  `CUSTOM_MODULE`.
- No dead-letter reprocessing UI — `failed_posting_review` rows can be
  read via SQL but there's no endpoint to retry or resolve one; the
  review table exists (shared with ledger-service's own failure class)
  but nothing acts on `review_status = OPEN` yet.
- Poll interval and batch size are fixed dev-appropriate defaults
  (5000ms / 20 rows per tenant per tick), not tuned against any real
  production volume or SLA.
- Single-instance only — no leader election or advisory locking. Two
  instances of this service running against the same database would both
  poll and could race on the same queue row; `upsert`'s idempotency means
  a race can't cause a double-post, but it could cause redundant work.
  Not a real risk today (this service isn't deployed more than once
  anywhere), worth knowing before it ever is.

## Approval-matrix enforcement — expansion beyond Procurement

The gap left open above: `checkApprovalAuthority` only ever resolved
Procurement PO amounts. This pass asked whether the same amount-routed
tiering makes sense anywhere else and, deliberately, didn't assume the
answer is "wire it in identically everywhere." Three modules were chosen —
Accounting, Fleet, Manufacturing — and each required its own real look at
whether it even has a natural fit, not a mechanical copy-paste of
Procurement's shape.

### 1. Why Manufacturing doesn't fit the Procurement shape at all

Every other candidate module has an obvious amount-bearing, pre-posting,
two-party transaction: a journal entry, a maintenance bill. Manufacturing's
`production_batches` doesn't — batch close is offline-capturable (a
production operator closes a batch on a device with no guaranteed
connectivity) and, per the posting-authority retrofit above, is
deliberately NOT gated behind any authority check, online or offline,
because gating an offline-capturable action would require a synchronous
network call mid-capture. There is no natural moment to insert "wait for
approval before this posts."

The resolution: don't gate the post. Batch close still posts unconditionally
and immediately, exactly as before this pass. Separately, it now computes
`batch_cost = actualOutputQty * recipeVersion.standardCost` (an existing
field — `recipe_versions.standard_cost`, already "cost per unit of output"
— so this needed zero new pricing logic) and does a plain, read-only
`$queryRaw` lookup against `approval_matrix` for a `MANUFACTURING`/
`BATCH_COST` band matching that cost. `checkApprovalAuthority` itself is
deliberately NOT used for this lookup: its fail-closed behavior on "no
matching band" (`NO_APPROVAL_MATRIX_CONFIGURED`) is correct for Procurement,
where every amount must land in some band, but wrong here, where MOST
batches fall below the single seeded band and "no match" simply means "no
review needed" — using the fail-closed check would have turned nearly
every batch close into a spurious denial. `manufacturing_svc` was granted
plain `SELECT` on `approval_matrix` (migration 024) for this.

The result is a genuinely different shape: `cost_review_status`
(`NOT_REQUIRED` / `PENDING_APPROVAL` / `APPROVED` / `REJECTED`) is
retrospective, not gating. `POST /production-batches/:batchId/approve` and
`.../reject` — which DO call the real `checkApprovalAuthority`, since by
this point it's a genuine per-user authority decision, not a threshold
lookup — never affect what already posted; they only ever move
`cost_review_status`. The seeded band is deliberately single-tier and
high (150,000+, `FINANCE_CONTROLLER` only) rather than mirroring
Procurement's full-range two-tier bands, since review here is meant to
catch the unusual expensive batch, not gate routine ones.

### 2. Why Accounting and Fleet DO fit, and the schema decision each forced

Both have the same shape Procurement does — a discrete amount proposed by
one person, decided by another, before it takes effect — so both got the
full two-party workflow: creation/submission calls no authority check,
only `approve`/`reject` do, and `reject` requires the identical tier-check
as `approve` (the same precedent as Procurement's own reject).

**Accounting** (`journal_entries`, migration 022) forced a real decision
Procurement never had to make. A PO can sit `po_status = OPEN` while
`approval_status = PENDING` — fulfillment and approval are independent
columns tracking independent concerns. A journal entry can't: it IS the
ledger (`reports.service.ts`'s trial balance sums `journal_lines` directly),
so it cannot exist in a POSTED-but-unapproved state without corrupting the
report. `status` itself therefore now carries `PENDING_APPROVAL` and
`REJECTED` as first-class values (new default: `PENDING_APPROVAL`), rather
than adding a redundant column that duplicates what `status` already means
for this table. `createManualJournalEntry` no longer calls any authority
check at all — it just creates with `status: PENDING_APPROVAL` — and
`reports.service.ts`'s trial-balance query was changed to filter
`journalEntry: { status: 'POSTED' }` instead of summing every entry
regardless of status, which is the actual correctness fix this pass made
to real financial reporting (verified below, not assumed).

**Fleet** (`maintenance_requests`, migration 023) is the closest match to
Procurement structurally. The old `completeMaintenanceRequest` (single
step, immediately `COMPLETED`, immediately published
`fleet.maintenance_completed.v1` — the event that triggers GL posting) is
now `submitMaintenanceRequest`: same route (`POST
:maintenanceRequestId/complete`, same DTO), but now records
`partsCost`/`labourCost`, moves to `PENDING_APPROVAL`, and does NOT publish
anything yet. The Kafka publish — the actual GL-posting trigger — only
happens inside `approveMaintenanceCompletion`, after `checkApprovalAuthority`
succeeds and there's no next stage, so a rejected or still-pending
completion can never post to the GL.

### 3. Two real bugs, found only by hitting a live database

Both of Phase 1-2's mocked unit-test suites stub Prisma entirely and
cannot catch either of these — they only surfaced from real curl calls
against real running services with a real Postgres behind them.

- **`accounting_svc` had no `UPDATE` grant on `journal_entries`.** Correct
  historically — before this pass, an entry was created once, immediately
  `POSTED`, and never touched again, so migration 015's `GRANT SELECT,
  INSERT` was sufficient at the time. The first live approve call after
  this pass's changes returned a real `42501 permission denied for table
  journal_entries` — not a TypeScript error, not a failing unit test, a
  live Postgres privilege check. Fixed by adding `GRANT UPDATE ON
  journal_entries TO accounting_svc;` to migration 022 (with the failure
  documented directly in the migration's own comment), applied live, and
  the same approve call retried successfully.
- **BigInt/JSON.stringify crash on manufacturing-service's first
  `sync_seq`-returning GET endpoint.** `findAllBatches` (new — the first
  endpoint in this service ever exposing the `production_batches` list)
  reads `sync_seq` via `$queryRaw`, which returns Postgres `bigserial`
  columns as native JS `BigInt`; Nest's default response serializer calls
  `JSON.stringify` on the way out, which throws `TypeError: Do not know
  how to serialize a BigInt` — a runtime failure at response-send time,
  invisible to `tsc`. This is the identical class of bug `crm-service`'s
  `ActivitiesService.findAll` hit first, earlier in this platform's
  history; fixed with the identical established pattern (`.map(r => ({
  ...r, sync_seq: typeof r.sync_seq === 'bigint' ? r.sync_seq.toString() :
  r.sync_seq }))`), plus a new regression test in
  `production.service.spec.ts` that asserts `JSON.stringify(result)`
  doesn't throw — mirroring CRM's own regression test for the same bug.

### 4. `manufacturing-service`'s new M2M client

`manufacturing-service` never called `governance-service` before this pass
(batch close was never gated), so it needed its own confidential Keycloak
client (`manufacturing-service`, `serviceAccountsEnabled: true`) — the
sixth, following the exact pattern the earlier M2M-auth pass established
for procurement/sales/accounting/fleet/hr. Added to
`governance-service`'s `M2M_ALLOWED_CLIENT_IDS` allow-list, and
`GOVERNANCE_BASE_URL`/`M2M_CLIENT_ID`/`M2M_CLIENT_SECRET` added to
`manufacturing-service`'s own `.env`/`.env.example`.

### 5. Verification — real Keycloak tokens, real data, all three modules

Using the same `metrock-test-client` password-grant minting as every prior
pass, against chidinma (`PROCUREMENT_MGR`), tunde (`FINANCE_CONTROLLER`),
and amaka (`STORES_CLERK`, `can_approve=false`):

**Accounting**: created a low entry (30,000, below the 50,000 threshold)
and a high one (80,000, at/above it). Confirmed via a real trial-balance
call that the pending entry is excluded (427,200 total) and, once
approved by the correct tier, included with an exact match (457,200 —
the 30,000 delta). The high entry was denied `403` by chidinma (wrong
tier) and approved `201` by tunde (correct tier).

**Fleet**: inserted a fresh `OPEN` maintenance request (none existed in
seed data), submitted with a real cost (7,000, below the 15,000
threshold) → correctly `PENDING_APPROVAL` with no GL-triggering publish;
approved by the correct tier (chidinma, since 7,000 is below-threshold) →
`COMPLETED`, `totalCost` present in the response.

**Manufacturing**: closed a batch whose computed cost (171,000) exceeds
the single 150,000+ band, confirming via the real API response and a
direct DB read that the batch posted unconditionally AND was flagged
`PENDING_APPROVAL` for cost review in the same operation. Chidinma's
approval attempt was correctly denied `403`
(`INSUFFICIENT_APPROVAL_TIER`). Tunde's attempt at the correct tier
returned `AUTHORIZED` and the batch reached a terminal `APPROVED` state —
confirmed against both the live row (`cost_review_status = APPROVED`,
`pending_approver_role_id = NULL`) and governance-service's hash-chained
`audit_log`, which shows exactly the two expected rows for this batch:
chidinma's `APPROVAL_DENIED` at `21:33:59.196`, immediately followed by
tunde's successful `APPROVAL_CHECK` at `21:33:59.236`. (A subsequent
manual re-approval attempt against the same, now-`APPROVED` batch
correctly returned `400` — not a bug, just confirmation that the terminal
state holds.)

### Known gaps after this pass

- No multi-stage escalation exercised in any of the three new modules —
  all seeded bands (Accounting, Fleet, Manufacturing alike) are single-
  role-per-tier; `hasNextStage` logic is implemented and shared with
  Procurement's already-tested code path, but nothing here specifically
  proves a 3-tier escalation end-to-end.
- Manufacturing's `BATCH_COST` band is a single tier (150,000+ only) —
  amounts below have no matching row and never trigger review at all,
  by design; this is intentionally different from Procurement/
  Accounting/Fleet's full-range coverage and hasn't been re-examined
  against real production cost data, only the seeded dev threshold.
- All three modules reuse `PROCUREMENT_MGR`/`FINANCE_CONTROLLER` as their
  approving roles rather than module-named roles (`FLEET_MANAGER`,
  `PRODUCTION_MANAGER`) — correct given `checkApprovalAuthority` only
  ever checks `can_approve` + the matrix's role_id, never a role's name
  or category, but a real deployment with dedicated fleet/production
  managers would need its own roles seeded, not a reuse of Procurement's.
- No plant-specific `approval_matrix` row exists for any of the three new
  modules either — same gap noted in the original Procurement-only pass,
  still untested beyond the tenant-wide band.

## SKU catalog and pricing

Sales Order capture has hardcoded a single finished-good SKU
(`_devOrderSkuId`, a Dart constant pointing at BRD-500G) and let the agent
type any unit price since the vertical slice first shipped — the
cubit/screen's own comments said as much: "A real SKU catalog picker
needs a product listing endpoint on sales-service, which doesn't exist
yet." `product_skus` (008_manufacturing.sql) never carried a selling
price either, and nothing on any service ever exposed the table over an
API — `sales-service`'s own Prisma schema already had a read-only
`ProductSku` model (needed for `order_lines`' foreign key), but no
controller anywhere ever queried it.

### 1. `list_price` on `product_skus`, owned by manufacturing-service

`026_product_sku_pricing.sql` adds a single nullable `list_price
numeric(14,2)` column — deliberately not a versioned or effective-dated
price list; nothing in this platform's scope needs multi-tier or
time-bound pricing, and `order_lines.unit_price` already stays a free,
agent-entered field per line, exactly as before. `list_price` is only
ever a suggested default the client pre-fills from, never a constraint
the server enforces or validates against. No grant changes needed —
`manufacturing_svc` already has table-wide `SELECT` on `product_skus`
(009_manufacturing_rls_and_role.sql), which covers the new column
automatically, and nothing in the application ever writes `list_price`
(set directly via seed/reference-data SQL, same as every other
`product_skus` column).

Seed data (`manufacturing_seed.sql`) sets `list_price = 250.00` on the
existing BRD-500G row (above its recipe's `standard_cost` of 190.00/unit,
a plausible margin) and adds a second `FINISHED_GOOD` row, BRD-1KG
(`list_price = 480.00`), with no recipe of its own — it exists purely so
the picker has more than one real choice to prove itself against, not to
extend Manufacturing's own scope.

### 2. `GET /product-skus` on manufacturing-service

Added to the same `ProductionController` that already hosts `GET
/recipes` (this service has always kept related read endpoints in one
controller rather than a separate module per resource — see its own
`@Controller()` with no prefix). `listProductSkus` returns every active
SKU, not filtered to `FINISHED_GOOD` server-side — raw materials are
useful catalog data too (e.g. a future Procurement picker), and filtering
to one category is a trivial client-side concern for a handful of rows,
not worth a query parameter here. Standard Keycloak-authenticated GET,
same as every other list endpoint — no special role or approval gate,
this is a read.

### 3. Mobile: a real picker, not a hardcoded constant

`ApiClient.fetchProductSkus()` — same shape and same online-only
simplification as `fetchRecipes()` (called directly, not through the
cursor-based sync/pull path; see README "Known gaps"). Threaded through
`main.dart` exactly the way `crmApi`/`fetchCustomers()` already was for
the Customer picker on this same screen: `_AgentsTab` and
`_AgentDetailScreen` both gained a `manufacturingApi` parameter, and
`_AgentDetailScreenState.initState` fetches the catalog alongside
customers, with the same graceful-degradation-to-empty-list on failure.

`SalesOrderCaptureState` gained `productSkus` (the fetched list) and
`skuId` (the selection); `SalesOrderCaptureCubit.updateSkuId` looks up
the chosen SKU and pre-fills `unitPrice` from its `listPrice` when one is
set — `updateUnitPrice` can still freely override it afterward, since
agents negotiate real prices in the field, same as before this picker
existed. `submit()` now validates `skuId != null` (a new failure mode
that didn't exist when the SKU was a hardcoded constant) alongside the
existing quantity/price checks. The screen adds a `DropdownButtonFormField`
for Product, filtered to `FINISHED_GOOD` client-side, mirroring the
existing Customer dropdown's structure; the Unit price `TextFormField` is
re-keyed on `state.skuId` (`key: ValueKey(state.skuId)`) so its
`initialValue` — otherwise only honored on first build — actually
refreshes to show the new pre-fill when the agent picks a different
product.

### 4. A real bug only running the app caught

Unit tests (mocked Prisma, mocked HTTP) and `flutter analyze` both passed
clean, but neither exercises actual widget layout. Running the real app
in the iOS Simulator surfaced a genuine `DropdownButtonFormField`
right-overflow — "RIGHT OVERFLOWED BY 42 PIXELS," rendered as Flutter's
diagonal warning stripe — on product labels long enough to exceed the
field's intrinsic width (e.g. "BRD-1KG — Standard White Bread 1kg
(480)"). The Customer dropdown never hit this because customer names
happened to be short enough; nothing about the code made that safe by
design. Fixed with `isExpanded: true` on the dropdown (so it sizes to the
available row width instead of its widest item) plus
`overflow: TextOverflow.ellipsis` on each item's `Text`.

### 5. Verification — the real app, a real device picker, a real synced order

Built and ran the actual Flutter app (not just its unit tests) on a
booted iPhone 15 Pro simulator, with the dev TLS cert trusted into its
keychain (same one-time step as the TLS Part B pass):

1. Signed in for real through the native `ASWebAuthenticationSession`
   flow against Keycloak, confirming the persisted session also restores
   correctly on a subsequent app relaunch (no re-login needed).
2. Opened New Sales Order for the seeded agent, opened the Product
   dropdown, and confirmed both real `FINISHED_GOOD` SKUs appeared with
   their real catalog prices — first with the overflow bug visible,
   confirmed fixed after the `isExpanded: true` change and an app
   restart.
3. Picked BRD-500G, watched Unit price pre-fill to `250.0` from the
   catalog (not typed), entered a quantity of 5, confirmed the on-screen
   order total computed correctly (`1250.00`).
4. Saved the order (a local, offline-capable Drift write, per this
   screen's existing design) and triggered a manual sync from the app
   bar.
5. Queried the real database afterward: the synced order
   (`SO-OFFLINE-fbbfd5e4`) matched exactly what was entered on screen —
   `sku_id` for BRD-500G, `ordered_qty = 5.000`, `unit_price = 250.00`,
   `total_order_value = 1250.00` — proof the entire chain (picker →
   pre-fill → local save → sync → real backend order creation → real
   persisted row) works end to end, not just that each piece compiles.

Also verified directly against the API with a real Keycloak token,
independent of the mobile app: `GET /product-skus` returns all 6 seeded
SKUs correctly ordered and shaped (2 `FINISHED_GOOD` with prices, 4
`RAW_MATERIAL` with null), and a `POST /sales-orders` against the new
BRD-1KG SKU succeeds and persists correctly — confirming the picker's
second choice is a genuinely real, orderable SKU, not just a display-only
addition.

### Known gaps after this pass

- Single current price per SKU, no price history or effective-dating —
  changing `list_price` has no audit trail and no way to know what an
  order was priced against after the fact beyond `order_lines.unit_price`
  itself.
- No server-side validation that a submitted `unit_price` is anywhere
  close to `list_price` — by design (agents negotiate real prices), but
  worth knowing if abuse/fraud detection is ever in scope.
- `list_price` is only set via seed/reference-data SQL — no endpoint
  exists to create or update a SKU's price (or a SKU at all) from the
  application; `product_skus` remains entirely reference data managed
  outside the app, same as before this pass.
- The picker is Sales-only — Procurement's PO line entry and
  Manufacturing's own batch-close flow still don't use `GET
  /product-skus` for their own SKU selection, even though the endpoint
  is now generically available to any caller.

## Statutory payroll deductions

`payroll_records.total_deductions` has been hardcoded to `0` since the
HR/Payroll slice shipped — migration 019's own header comment said so
explicitly ("no statutory deduction engine (tax/pension) in this
slice"). This pass builds that engine for real, scoped to the two
deductions every Nigerian private-sector employer of this platform's
size is universally subject to: PAYE income tax (Personal Income Tax
Act, as amended by the Finance Act 2020) and pension (Pension Reform
Act 2014, 8% employee contribution). NHF (National Housing Fund) is
deliberately NOT modeled — inconsistently enforced in Nigerian SME
payroll practice, a separate judgment call this pass doesn't try to
make.

### 1. Configuration: reusing `approval_matrix`'s own shape, not inventing a new one

`027_statutory_payroll_deductions.sql` adds two new configuration
sources:

- `tenant_registry.pension_employee_rate` — a single flat rate
  (default `0.08`), same shape as `finance_connector_type`: one column
  on the tenant's own row, since there's only ever one rate per tenant.
- `payroll_tax_bands` — progressive PAYE bands, tenant-scoped, with the
  EXACT same threshold-band shape `approval_matrix`
  (003_governance.sql) already established: an order, an inclusive
  lower bound, a nullable exclusive upper bound (`NULL` = "and above",
  the top band), and a rate. Reused deliberately rather than inventing
  a parallel banding mechanism — this codebase already had exactly the
  right shape for progressive-threshold data, just for approval routing
  instead of tax.

The band *rates* are data; the Consolidated Relief Allowance formula
and the annualize/de-annualize computation shape are Nigeria-specific
application logic, not data — a real multi-country deployment would
need to generalize that part too, a known gap this pass doesn't solve
(same "known, not solved yet" treatment as the missing secrets manager
elsewhere in this README).

`hr_svc` gained `SELECT` on both `tenant_registry` (table-wide, not
RLS-protected — same as `finance-connector-service`'s read of the same
table) and the new `payroll_tax_bands` (RLS-enabled, same
`tenant_isolation` policy as every other tenant table).

`payroll_records` gained a `deductions_breakdown jsonb` column — an
auditable snapshot of the computation (`{payeAmount, pensionAmount}`),
alongside the existing `total_deductions` sum which keeps its original
meaning and type; nothing downstream reads the breakdown (the GL
posting rule sums `net_salary`, not `total_deductions`), so this is
purely for inspectability, same reasoning as `grade_weight_used`/
`payroll_ratio_used` already snapshotting their own inputs.

### 2. `payroll-tax.ts` — a pure function, kept out of the database layer on purpose

`computeStatutoryDeductions(grossMonthly, pensionEmployeeRate, bands)`
takes plain numbers and a plain band array in, returns
`{payeAmount, pensionAmount, totalDeductions}` out — no Prisma, no
`tenantId`, no I/O of any kind. This mirrors `ledger-service`'s
`amountFromPayload`/`nullableUUID` pure-helper precedent: tax-law edge
cases (a zero-income employee, an employee whose entire income falls
within the tax-free relief threshold, an employee whose income spans
every band) are exactly the kind of thing worth testing directly and
exhaustively, without a mocked Prisma transaction in the way.

The computation, standard Nigerian monthly PAYE practice:

1. Annualize gross monthly pay (`x12`).
2. Compute the Consolidated Relief Allowance: the greater of ₦200,000
   or 1% of annual gross, PLUS 20% of annual gross.
3. Compute the annual pension contribution (gross x
   `pensionEmployeeRate`).
4. Taxable annual income = annual gross − CRA − pension, floored at
   zero (a low enough earner owes no PAYE at all, once relief and
   pension are applied — this is real, not a bug: Nigerian PAYE
   effectively exempts minimum-wage-level earners).
5. Run taxable annual income through the configured bands, summing
   `rate x (min(taxable, bandMax) − bandMin)` for every band the income
   reaches.
6. De-annualize the result (`/12`) for the monthly PAYE figure; pension
   itself is reported as a flat monthly amount (`grossMonthly x rate`),
   not derived from the annualized round-trip, since it's already a
   flat percentage with nothing progressive to annualize for.

### 3. Wiring into `PayrollService.calculateRun`

Per employee, after computing `grossSalary` (unchanged: `payrollPool x
gradeWeight`), the run now also loads `tenantRegistry.pensionEmployeeRate`
and `payrollTaxBand.findMany` (once per run, not per employee) and calls
`computeStatutoryDeductions`. `netSalary` is now genuinely `grossSalary
− totalDeductions` rather than always equal to `grossSalary`.
`postRun`'s own logic is untouched — it already summed `net_salary`
across records for the GL posting, so a real deduction simply flows
through as a smaller number, no code change needed there.

### 4. Verification — real numbers, not just passing tests

Both layers verified independently:

**Unit tests** (`payroll-tax.spec.ts`, 7 tests): zero income deducts
nothing; pension is a flat percentage independent of PAYE; a low earner
(₦30,000/month, the existing seed fixture's own salary level) still
owes a small real PAYE amount once CRA and pension are applied
(hand-computed: ₦345.33/month); a high earner's income is taxed across
every band, not just the top one (hand-computed: ₦65,066.67/month on
₦500,000 gross); CRA never pushes taxable income negative; a
single-band, unbounded (`thresholdMax: null`) table taxes everything at
one flat rate; the function doesn't mutate its inputs.
`payroll.service.spec.ts` gained a wiring test confirming
`payrollTaxBand.findMany` is queried with the right shape and its
result correctly flows into the deduction calculation, plus updated
assertions on the existing calculation test now that `totalDeductions`/
`netSalary` are no longer trivially `0`/`grossSalary`.

**Real API + real database**, independent of the unit tests: seeded the
real 2020 Finance Act bands for the dev tenant, inserted a real
confirmed sales order for a fresh payroll period (`2026-12`, avoiding
collision with already-`POSTED` runs from earlier passes), then called
the actual `POST /payroll-runs` with a real Keycloak token. Both seeded
employees' results matched hand-computed expected values exactly, to
the cent:

- Ngozi Adeyemi (GRADE_A, gross ₦36,000/month): PAYE ₦647.73, pension
  ₦2,880, `totalDeductions` ₦3,527.73, `netSalary` ₦32,472.27.
- Tunde Bakare (GRADE_B, gross ₦18,000/month): PAYE ₦0 (income falls
  entirely within CRA + pension relief), pension ₦1,440,
  `totalDeductions` ₦1,440, `netSalary` ₦16,560.

Then posted the same run via `POST /payroll-runs/:id/post` — governance-
service was down at first, and the posting-authority check correctly
fail-closed with a real `503` rather than silently succeeding (same
fail-closed behavior proven in the original posting-authority retrofit);
restarted governance-service and retried, which correctly posted with
`netSalaryTotal` equal to the exact sum of the two employees' reduced
`netSalary` figures (₦49,032.27), confirming `postRun`'s existing logic
needed no changes to correctly reflect the new deductions. RLS smoke-
tested: `hr_svc` connecting directly and setting `app.tenant_id` to an
unrelated tenant returned `0` rows from `payroll_tax_bands` despite 6
real seeded rows existing for the actual tenant.

### Known gaps after this pass

- NHF is not modeled, as stated above — a real deployment needs an
  explicit decision on whether and how to apply it.
- The Consolidated Relief Allowance formula and the annualize/de-
  annualize shape are Nigeria-specific application logic, not
  configurable data — a genuinely multi-country deployment (this
  platform's own stated goal, per the SDD's "resold to other food-
  manufacturing enterprises") would need to generalize this, not just
  swap the band table's contents.
- No payslip document or UI — `deductions_breakdown` is queryable via
  the API/database but there's no endpoint or screen presenting it as
  an actual payslip an employee would see.
- No mid-year tax regime changes or pro-ration — a band table changed
  mid-period doesn't retroactively affect already-`CALCULATED` runs
  (each run reads bands fresh from the current configuration at
  calculation time, so this is correct going forward, but nothing
  models a tax law changing mid-tenure the way a real payroll system's
  historical-band versioning would).

## Accounting period-close

`reports.service.ts`'s own class doc comment named this gap explicitly:
"a real GL would zero P&L accounts into an equity Retained Earnings
balance at period end" — Balance Sheet's `totalAssets` differs from
`totalLiabilities + totalEquity` by exactly the unclosed `netIncome`
whenever there's REVENUE/EXPENSE activity that's never been folded into
EQUITY, which was always, since nothing ever did that folding. This pass
builds the real closing operation.

### 1. `3100 Retained Earnings` — the first EQUITY account this platform has ever had

`028_period_close.sql` seeds one new chart-of-accounts row. Checked
before writing this: no migration or seed file across the whole
platform had ever inserted an `EQUITY`-typed account, despite the
`account_type` CHECK constraint allowing one since `005_finance.sql`
first created the table — every other module's own GL accounts are
ASSET/LIABILITY/REVENUE/EXPENSE. No new grants needed:
`chart_of_accounts` is reference data, same as every other module's own
new accounts (HR's 5340/2130, Fleet's 5320/5330, etc.) — inserted via
migration, never written by the application.

### 2. Design: not tied to a calendar period, because nothing else here is either

Real accounting systems close a specific fiscal period. This platform's
`journal_entries` has no period column anywhere, and neither Trial
Balance, P&L, nor Balance Sheet filter by date — they are, and remain,
all-time snapshots. Retrofitting period-tracking into the reports layer
just to give period-close a boundary to work against would be
substantially more scope than this gap needs. Instead, `closeBooks`
closes whatever CURRENT revenue/expense activity is unclosed, with no
period boundary at all — and this turns out to be naturally,
automatically incremental without any extra bookkeeping: a closing
entry's own lines hit the exact same revenue/expense accounts they
zero, so by the time a SECOND close runs, those accounts' balances only
reflect whatever posted since the first close — the first close's own
effect is already netted in. Verified for real, not just argued (see
Verification below).

### 3. Reusing `ReportsService.accountBalances`, not re-deriving it

`PeriodCloseService` (`src/period-close/`) is a new module that imports
`ReportsModule` and injects `ReportsService` directly — `accountBalances`
(previously `private`) is the exact computation Trial Balance/P&L/
Balance Sheet already do, and period-close needs the identical current
balances they read, so this reuses that method rather than writing a
second, parallel query.

Writes `journal_entries`/`journal_lines` directly, the same as
`JournalsService`'s manual entries (`accounting_svc`'s direct-insert
grant, migration 015, exists for precisely this reason) — and for the
same underlying reason: the debit/credit shape here (N dynamic revenue
lines + N dynamic expense lines + one balancing line into Retained
Earnings) can't be expressed by `posting_rules`' fixed one-event-type-
to-one-debit-account-and-one-credit-account mapping, so this can never
go through ledger-service's Kafka-driven posting path at all, no matter
how the rest of the design shakes out.

**Not** the two-party `PENDING_APPROVAL` workflow manual journal entries
use (`approval_matrix` expansion, migration 022) — period-close posts
immediately (`status: POSTED`) behind a single `checkAuthority` call
(`can_post`/`ACCOUNTING`), the exact same shape as vendor bill payment
and customer invoice payment (`bills.service.ts`/`invoices.service.ts`).
A period close is a deliberate, already-decided action performed by one
authorized finance person, not a proposal for someone else to review —
structurally closer to "execute this payment" than to "propose this
adjusting entry."

### 4. A real bug: not every EXPENSE account has a debit-normal balance here

The first implementation assumed textbook normal-balance conventions:
REVENUE accounts always net credit, EXPENSE accounts always net debit,
and computed each zeroing line's debit/credit purely from account type.
Running it against the real, messy dev database — accumulated from
every prior verification pass in this session — immediately produced a
real `PrismaClientUnknownRequestError` wrapping a genuine Postgres
`23514`: `journal_lines` violates `one_sided_line`. The cause:
Manufacturing's favorable-variance postings (`production.service.ts`,
the approval_matrix expansion pass) credit an EXPENSE account
(`5310 Manufacturing Variance Expense`) more than they debit it — a
completely legitimate, real posting pattern this platform already had —
leaving that account with a net CREDIT balance. The buggy code computed
`totalDebit - totalCredit` for that account (negative), then used it
directly as `creditAmount`, producing a negative credit amount no valid
journal line can have.

Fixed by deriving each closing line purely from the account's signed
`netDebit = totalDebit - totalCredit`, regardless of its `account_type`:
positive `netDebit` is zeroed by crediting it, negative `netDebit` by
debiting it — the same mechanical rule for REVENUE and EXPENSE alike.
`netIncome` itself is then `sum(debitAmount) - sum(creditAmount)` across
just the closing lines (the class doc comment on `PeriodCloseService`
walks through why this is algebraically equivalent to
`totalRevenue - totalExpense`). A regression test
(`period-close.service.spec.ts`) locks in the exact real shape that
broke: a credit-heavy EXPENSE account, asserting every generated line
has non-negative debit and credit amounts.

### 5. Verification — real accumulated data, a real bug, a real second close

1. Unit tests (`period-close.service.spec.ts`, 6 tests): an ordinary
   profitable close credits Retained Earnings; a loss debits it; net
   income of exactly zero omits the Retained Earnings line entirely
   (would otherwise violate `one_sided_line`); zero-activity accounts
   are excluded; the credit-heavy-EXPENSE regression case above; and
   "nothing to close" rejects with no write and no authority check at
   all (not even attempted) when every revenue/expense account is
   already at zero.
2. Applied `028_period_close.sql` live; confirmed the `3100 Retained
   Earnings` row exists with `account_type = EQUITY`.
3. Checked the real dev database's P&L/Balance Sheet BEFORE closing:
   `netIncome` ₦1,700,952.50, Balance Sheet `totalAssets` exceeding
   `totalLiabilities + totalEquity` by that exact amount — the
   documented bug, present for real, not hypothetical.
4. First real close attempt hit the bug above (a genuine `500`, not a
   contrived test). Fixed the code, rebuilt, restarted the service.
5. Second real close attempt succeeded (`201`): inspected the actual
   posted `journal_lines` directly — revenue debited ₦308,500 to zero,
   `5310` (the credit-heavy account) correctly DEBITED ₦1,524,790 (not
   credited — the fix in action), three ordinary debit-normal expense
   accounts credited to zero, and Retained Earnings credited exactly
   ₦1,700,952.50. Debits and credits balanced exactly
   (₦1,833,290.00 each side).
6. Balance Sheet afterward: `totalAssets - (totalLiabilities +
   totalEquity) = 0.0`. P&L's `netIncome`: `0`.
7. Inserted a small new real posting (₦5,000 revenue) directly, then
   closed again: the resulting entry contained ONLY two lines — the new
   ₦5,000 revenue zeroed, ₦5,000 credited to Retained Earnings — not a
   re-close of anything already closed, confirming the "naturally
   incremental, no period tracking needed" design claim against real
   data, not just the argument for it. Balance Sheet still tied out
   afterward.

### Known gaps after this pass

- No calendar period boundary at all, by design (see above) — a real
  deployment that needs "close January, leave February open" (rather
  than "close everything unclosed as of right now") would need actual
  period tracking added to `journal_entries`, a bigger change than this
  pass makes.
- No un-close / reopen — once closed, the only way to adjust a closed
  period is a new posting (which the next close would pick up), not a
  reversal of the closing entry itself. `journal_entries.status` does
  support `REVERSED` as a value, but nothing here uses it — reversing a
  closing entry correctly would need to reopen exactly the accounts it
  closed, which isn't implemented.
- No UI — `POST /period-close` is proven by curl/API only, consistent
  with Accounting having no Flutter UI at all (by design, per the
  existing "Accounting has no Flutter UI" gap).
- Single currency, single equity account — real multi-entity or multi-
  currency closing (translation adjustments, multiple retained-earnings
  accounts per legal entity) isn't attempted; this platform has neither
  concept yet anywhere.
