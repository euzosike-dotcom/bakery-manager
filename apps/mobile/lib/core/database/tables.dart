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

/// Per-table pull cursor (SDD §2.2: "client persists last_synced_cursor per
/// cached table"). `entity` is e.g. "goods_receipts" or "purchase_orders".
class SyncCursors extends Table {
  TextColumn get entity => text()();
  TextColumn get lastSyncedCursor => text().withDefault(const Constant('0'))();

  @override
  Set<Column> get primaryKey => {entity};
}
