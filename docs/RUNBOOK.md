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
Redis (`localhost:6379`), MinIO (`localhost:9000`, console `:9001`).

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
