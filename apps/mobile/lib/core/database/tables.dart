import 'package:drift/drift.dart';

/// Read-cached Purchase Order headers (pull-only — SDD §2.1 table for the
/// Plant/Warehouse Tablet role). Never written to from this client; overwritten
/// wholesale on every `/sync/pull` for `purchase_orders`.
class PurchaseOrdersCache extends Table {
  TextColumn get poId => text()();
  TextColumn get poNumber => text()();
  TextColumn get supplierId => text()();
  TextColumn get plantId => text()();
  TextColumn get poStatus => text()();

  @override
  Set<Column> get primaryKey => {poId};
}

class PurchaseOrderLinesCache extends Table {
  TextColumn get poLineId => text()();
  TextColumn get poId => text()();
  TextColumn get skuDescription => text()();
  RealColumn get orderedQty => real()();
  RealColumn get receivedQty => real()();
  TextColumn get uom => text()();
  RealColumn get unitCost => real()();
  TextColumn get lineStatus => text()();

  @override
  Set<Column> get primaryKey => {poLineId};
}

/// Local mirror of `goods_receipts` (SDD §2.1). Rows are created offline by
/// this client, then reconciled against server state once `/sync/pull`
/// returns the authoritative row (server-assigned `syncSeq`, final
/// `postingStatus`).
class GoodsReceiptsLocal extends Table {
  TextColumn get grnId => text()(); // client-generated UUID; stable even offline
  TextColumn get grnNumber => text()();
  TextColumn get poId => text()();
  TextColumn get warehouseId => text()();
  DateTimeColumn get receiptDate => dateTime()();
  TextColumn get qcStatus => text().withDefault(const Constant('PENDING'))();
  TextColumn get postingStatus => text().withDefault(const Constant('PENDING'))();
  TextColumn get clientEventId => text()(); // idempotency key, SDD §2.1
  BoolColumn get createdOffline => boolean().withDefault(const Constant(true))();
  IntColumn get syncSeq => integer().nullable()(); // null until server acks

  @override
  Set<Column> get primaryKey => {grnId};
}

class GoodsReceiptLinesLocal extends Table {
  TextColumn get grnLineId => text()();
  TextColumn get grnId => text()();
  TextColumn get poLineId => text()();
  RealColumn get receivedQty => real()();
  RealColumn get acceptedQty => real()();
  RealColumn get rejectedQty => real()();
  TextColumn get uom => text()();
  RealColumn get unitCost => real()();

  @override
  Set<Column> get primaryKey => {grnLineId};
}

/// Local mirror of `production_batches` (SDD §3.C) — same offline-write /
/// reconcile-on-pull pattern as GoodsReceiptsLocal above.
class ProductionBatchesLocal extends Table {
  TextColumn get batchId => text()(); // client-generated UUID
  TextColumn get batchNumber => text()();
  TextColumn get plantId => text()();
  TextColumn get skuId => text()();
  TextColumn get recipeVersionId => text()(); // snapshot-pinned at creation
  DateTimeColumn get batchDate => dateTime()();
  RealColumn get plannedQty => real()();
  RealColumn get actualOutputQty => real()();
  RealColumn get actualWasteQty => real()();
  RealColumn get yieldPercent => real().nullable()();
  BoolColumn get yieldAlertTriggered => boolean().withDefault(const Constant(false))();
  TextColumn get batchStatus => text().withDefault(const Constant('CLOSED'))();
  TextColumn get clientEventId => text()();
  BoolColumn get createdOffline => boolean().withDefault(const Constant(true))();
  IntColumn get syncSeq => integer().nullable()();

  @override
  Set<Column> get primaryKey => {batchId};
}

class ProductionConsumptionLocal extends Table {
  TextColumn get consumptionId => text()();
  TextColumn get batchId => text()();
  TextColumn get ingredientSkuId => text()();
  RealColumn get plannedQty => real()();
  RealColumn get actualQty => real()();

  @override
  Set<Column> get primaryKey => {consumptionId};
}

/// Local mirror of `sales_orders` (SDD §3.D) — same offline-write /
/// reconcile-on-pull pattern as GoodsReceiptsLocal/ProductionBatchesLocal.
/// `creditEligibilityStatus` starts as the client's optimistic guess but is
/// always overwritten by whatever the server returns on pull — the server
/// re-check is the only one that actually counts (SDD §2.3 scenario #7).
class SalesOrdersLocal extends Table {
  TextColumn get salesOrderId => text()(); // client-generated UUID
  TextColumn get orderNumber => text()();
  TextColumn get agentId => text()();
  TextColumn get plantId => text()();
  // Optional CRM link (migration 012_crm.sql), added in the CRM slice —
  // see SalesOrderRepository.captureSalesOrder's doc comment.
  TextColumn get customerId => text().nullable()();
  DateTimeColumn get orderDate => dateTime()();
  RealColumn get totalOrderValue => real()();
  TextColumn get orderStatus => text().withDefault(const Constant('CONFIRMED'))();
  TextColumn get creditEligibilityStatus => text().withDefault(const Constant('PENDING_SYNC_VALIDATION'))();
  TextColumn get clientEventId => text()();
  BoolColumn get createdOffline => boolean().withDefault(const Constant(true))();
  IntColumn get syncSeq => integer().nullable()();

  @override
  Set<Column> get primaryKey => {salesOrderId};
}

/// Local mirror of `ncr_collections` (SDD §3.D). `verifiedFlag` is always
/// false at capture time — verification is an online-only back-office
/// action this client never performs (see NcrService's doc comment on the
/// server side), so this column only ever flips via a pulled update.
class NcrCollectionsLocal extends Table {
  TextColumn get ncrId => text()(); // client-generated UUID
  TextColumn get ncrReference => text()();
  TextColumn get agentId => text()();
  DateTimeColumn get collectionDate => dateTime()();
  RealColumn get amount => real()();
  BoolColumn get verifiedFlag => boolean().withDefault(const Constant(false))();
  TextColumn get clientEventId => text()();
  BoolColumn get createdOffline => boolean().withDefault(const Constant(true))();
  IntColumn get syncSeq => integer().nullable()();

  @override
  Set<Column> get primaryKey => {ncrId};
}

/// The offline outbox (SDD §2.1) — every write this client makes is an
/// immutable, replayable intent here, never a "hope it syncs later" direct
/// table mutation. `payloadJson` is a full intent (not a diff), because a
/// diff requires a shared base state offline devices cannot guarantee.
class OutboxEvents extends Table {
  TextColumn get clientEventId => text()(); // ULID/UUID, also the idempotency key
  TextColumn get entityType => text()(); // e.g. "goods_receipt"
  TextColumn get entityId => text()();
  TextColumn get operation => text()(); // CREATE | UPDATE | STATUS_TRANSITION | ...
  TextColumn get payloadJson => text()();
  TextColumn get hlcTimestamp => text()(); // Hybrid Logical Clock stamp, SDD §2.1
  TextColumn get syncStatus =>
      text().withDefault(const Constant('PENDING'))(); // PENDING|IN_FLIGHT|ACKED|REJECTED|NEEDS_REVIEW
  IntColumn get retryCount => integer().withDefault(const Constant(0))();
  TextColumn get serverResponseJson => text().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {clientEventId};
}

/// Local mirror of `activities` (migration 012_crm.sql) — the CRM module's
/// one offline-capturable entity (a field rep logging a call/visit/note
/// against a customer), same offline-write / reconcile-on-pull pattern as
/// NcrCollectionsLocal. Customers/Opportunities have no local table at all
/// — same "fetched directly online, held in memory only" simplification as
/// Purchase Orders/Recipes/Agents (see README "Known gaps"), so there's
/// nothing to pick a customer against until the device has been online at
/// least once.
class ActivitiesLocal extends Table {
  TextColumn get activityId => text()(); // client-generated UUID
  TextColumn get customerId => text()();
  TextColumn get activityType => text()();
  TextColumn get notes => text().nullable()();
  DateTimeColumn get activityDate => dateTime()();
  TextColumn get clientEventId => text()();
  BoolColumn get createdOffline => boolean().withDefault(const Constant(true))();
  IntColumn get syncSeq => integer().nullable()();

  @override
  Set<Column> get primaryKey => {activityId};
}

/// Local mirror of `trip_logs` (migration 017_fleet.sql) — one of the two
/// canonical offline-capture use cases named in the SDD mandate (§3.E):
/// drivers are frequently in zero-connectivity transit corridors. Same
/// offline-write / reconcile-on-pull pattern as SalesOrdersLocal.
class TripLogsLocal extends Table {
  TextColumn get tripLogId => text()(); // client-generated UUID
  TextColumn get vehicleId => text()();
  TextColumn get driverId => text()();
  DateTimeColumn get tripDate => dateTime()();
  RealColumn get startMileage => real()();
  RealColumn get endMileage => real()();
  TextColumn get destinationNote => text().nullable()();
  TextColumn get clientEventId => text()();
  BoolColumn get createdOffline => boolean().withDefault(const Constant(true))();
  IntColumn get syncSeq => integer().nullable()();

  @override
  Set<Column> get primaryKey => {tripLogId};
}

/// Local mirror of `fuel_records` (migration 017_fleet.sql) — the other
/// canonical offline-capture use case alongside TripLogsLocal.
class FuelRecordsLocal extends Table {
  TextColumn get fuelRecordId => text()(); // client-generated UUID
  TextColumn get vehicleId => text()();
  TextColumn get tripLogId => text().nullable()();
  RealColumn get litres => real()();
  RealColumn get fuelCost => real()();
  TextColumn get expenseClaimReference => text().nullable()();
  BoolColumn get orphanedTripReference => boolean().withDefault(const Constant(false))();
  TextColumn get clientEventId => text()();
  BoolColumn get createdOffline => boolean().withDefault(const Constant(true))();
  IntColumn get syncSeq => integer().nullable()();

  @override
  Set<Column> get primaryKey => {fuelRecordId};
}

/// Per-table pull cursor (SDD §2.2: "client persists last_synced_cursor per
/// cached table"). `entity` is e.g. "goods_receipts" or "purchase_orders".
class SyncCursors extends Table {
  TextColumn get entity => text()();
  TextColumn get lastSyncedCursor => text().withDefault(const Constant('0'))();

  @override
  Set<Column> get primaryKey => {entity};
}
