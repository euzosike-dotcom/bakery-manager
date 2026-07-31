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

## Known gaps still open after this verification pass

- No automated test yet for the over-receipt path (Conflict Matrix scenario
  #3) or the idempotent-retry path — both were exercised manually above,
  not covered by CI.
- `PurchaseOrdersCache` / `PurchaseOrderLinesCache` Drift tables are defined
  but not yet written to — see `README.md` "Known gaps".
- `ledger-service` still connects as the Postgres superuser by design (see
  the doc comment on `internal/db/pool.go`) — that's an accepted tradeoff
  for a trusted internal consumer, not something this pass changed.
