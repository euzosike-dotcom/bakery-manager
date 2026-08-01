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
