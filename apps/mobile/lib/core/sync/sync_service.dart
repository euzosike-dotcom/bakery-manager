import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:drift/drift.dart';

import '../database/database.dart';
import 'api_client.dart';

/// Which backend domain service owns a given entity/event type. The
/// platform's target architecture (docs/SDD.md §1.1) routes every client
/// request through a single API Gateway that resolves this internally; this
/// app doesn't have that gateway yet (see README "Known gaps" — worth
/// building once a third module joins procurement + manufacturing, not
/// before), so the client does the routing itself for now, one entry per
/// module. Adding a module means adding one entry here, not restructuring
/// this class.
enum SyncModule { procurement, manufacturing }

const _pushModuleForEntityType = {
  'goods_receipt': SyncModule.procurement,
  'production_batch': SyncModule.manufacturing,
};

const _pullModuleForEntity = {
  'goods_receipts': SyncModule.procurement,
  'goods_receipt_lines': SyncModule.procurement,
  'production_batches': SyncModule.manufacturing,
};

/// Drives both directions of SDD §2.2:
///  - push: replays PENDING `OutboxEvents` rows through each owning
///    module's `/sync/push`, grouped by entity type
///  - pull: replicates server-authoritative state per module into the local
///    cache, advancing the per-table cursor in `SyncCursors`
///
/// Triggered on connectivity regain and can also be called manually (e.g. a
/// pull-to-refresh gesture). Safe to call concurrently with itself — a
/// `_running` guard collapses overlapping triggers into one pass.
class SyncService {
  SyncService({required this.db, required this.apiClients});

  final AppDatabase db;
  final Map<SyncModule, ApiClient> apiClients;

  bool _running = false;
  StreamSubscription<List<ConnectivityResult>>? _connectivitySub;

  void startWatchingConnectivity() {
    _connectivitySub = Connectivity().onConnectivityChanged.listen((results) {
      final hasConnection = results.any((r) => r != ConnectivityResult.none);
      if (hasConnection) {
        unawaited(syncNow());
      }
    });
  }

  void dispose() {
    _connectivitySub?.cancel();
  }

  Future<void> syncNow() async {
    if (_running) return;
    _running = true;
    try {
      await _pushOutbox();
      await _pullEntity('goods_receipts');
      await _pullEntity('goods_receipt_lines');
      await _pullEntity('production_batches');
    } finally {
      _running = false;
    }
  }

  Future<void> _pushOutbox() async {
    final pending = await (db.select(db.outboxEvents)
          ..where((t) => t.syncStatus.equals('PENDING'))
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)])
          ..limit(50))
        .get();
    if (pending.isEmpty) return;

    await db.batch((batch) {
      batch.update(
        db.outboxEvents,
        const OutboxEventsCompanion(syncStatus: Value('IN_FLIGHT')),
        where: (t) => t.clientEventId.isIn(pending.map((e) => e.clientEventId)),
      );
    });

    // Group by owning module so each group hits the right service's
    // /sync/push — a single outbox is still one unified local queue, this
    // only affects which HTTP endpoint a given event is replayed against.
    final byModule = <SyncModule, List<OutboxEvent>>{};
    for (final row in pending) {
      final module = _pushModuleForEntityType[row.entityType];
      if (module == null) continue; // unknown entity type — left PENDING, not lost
      byModule.putIfAbsent(module, () => []).add(row);
    }

    for (final entry in byModule.entries) {
      final api = apiClients[entry.key]!;
      final group = entry.value;
      final events = group
          .map((e) => {
                'clientEventId': e.clientEventId,
                'entityType': e.entityType,
                'operation': e.operation,
                'hlcTimestamp': e.hlcTimestamp,
                'deviceId': api.deviceId,
                'payload': jsonDecode(e.payloadJson),
              })
          .toList();

      List<Map<String, dynamic>> results;
      try {
        results = await api.syncPush(events);
      } catch (_) {
        // Network/server failure: revert this group to PENDING so the next
        // connectivity trigger retries it (other modules' groups still
        // proceed independently — one service being down shouldn't stall
        // sync for entities owned by a different, healthy service).
        await db.batch((batch) {
          batch.update(
            db.outboxEvents,
            const OutboxEventsCompanion(syncStatus: Value('PENDING')),
            where: (t) => t.clientEventId.isIn(group.map((e) => e.clientEventId)),
          );
        });
        continue;
      }

      for (final result in results) {
        final clientEventId = result['clientEventId'] as String;
        final status = result['status'] as String; // ACKED | REJECTED | NEEDS_REVIEW
        await (db.update(db.outboxEvents)..where((t) => t.clientEventId.equals(clientEventId))).write(
          OutboxEventsCompanion(
            syncStatus: Value(status),
            serverResponseJson: Value(jsonEncode(result)),
            retryCount: Value((group.firstWhere((e) => e.clientEventId == clientEventId).retryCount) + 1),
          ),
        );
      }
    }
  }

  Future<void> _pullEntity(String entity) async {
    final api = apiClients[_pullModuleForEntity[entity]]!;
    var cursor = await _readCursor(entity);
    while (true) {
      final page = await api.syncPull(entity, cursor);
      if (page.records.isEmpty) break;

      switch (entity) {
        case 'goods_receipts':
          await _applyGoodsReceiptsPage(page.records);
        case 'goods_receipt_lines':
          await _applyGoodsReceiptLinesPage(page.records);
        case 'production_batches':
          await _applyProductionBatchesPage(page.records);
      }

      await _writeCursor(entity, page.nextCursor);
      if (page.nextCursor == cursor) break; // no progress — avoid infinite loop
      cursor = page.nextCursor;
      if (page.records.length < 200) break; // last page
    }
  }

  Future<void> _applyGoodsReceiptsPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.goodsReceiptsLocal,
          GoodsReceiptsLocalCompanion.insert(
            grnId: row['grn_id'] as String,
            grnNumber: row['grn_number'] as String,
            poId: row['po_id'] as String,
            warehouseId: row['warehouse_id'] as String,
            receiptDate: DateTime.parse(row['receipt_date'] as String),
            qcStatus: Value(row['qc_status'] as String),
            postingStatus: Value(row['posting_status'] as String),
            clientEventId: row['client_event_id'] as String,
            createdOffline: Value(row['created_offline'] as bool),
            syncSeq: Value(int.parse(row['sync_seq'].toString())),
          ),
          mode: InsertMode.insertOrReplace, // pull is state-replication, not merge (SDD §2.2)
        );
      }
    });
  }

  Future<void> _applyGoodsReceiptLinesPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.goodsReceiptLinesLocal,
          GoodsReceiptLinesLocalCompanion.insert(
            grnLineId: row['grn_line_id'] as String,
            grnId: row['grn_id'] as String,
            poLineId: row['po_line_id'] as String,
            receivedQty: (row['received_qty'] as num).toDouble(),
            acceptedQty: (row['accepted_qty'] as num).toDouble(),
            rejectedQty: (row['rejected_qty'] as num).toDouble(),
            uom: row['uom'] as String,
            unitCost: (row['unit_cost'] as num).toDouble(),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  Future<void> _applyProductionBatchesPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.productionBatchesLocal,
          ProductionBatchesLocalCompanion.insert(
            batchId: row['batch_id'] as String,
            batchNumber: row['batch_number'] as String,
            plantId: row['plant_id'] as String,
            skuId: row['sku_id'] as String,
            recipeVersionId: row['recipe_version_id'] as String,
            batchDate: DateTime.parse(row['batch_date'] as String),
            plannedQty: (row['planned_qty'] as num).toDouble(),
            actualOutputQty: (row['actual_output_qty'] as num).toDouble(),
            actualWasteQty: (row['actual_waste_qty'] as num).toDouble(),
            yieldPercent: Value(row['yield_percent'] == null ? null : (row['yield_percent'] as num).toDouble()),
            yieldAlertTriggered: Value(row['yield_alert_triggered'] as bool),
            batchStatus: Value(row['batch_status'] as String),
            clientEventId: row['client_event_id'] as String,
            createdOffline: Value(row['created_offline'] as bool),
            syncSeq: Value(int.parse(row['sync_seq'].toString())),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  Future<String> _readCursor(String entity) async {
    final row = await (db.select(db.syncCursors)..where((t) => t.entity.equals(entity))).getSingleOrNull();
    return row?.lastSyncedCursor ?? '0';
  }

  Future<void> _writeCursor(String entity, String cursor) async {
    await db.into(db.syncCursors).insertOnConflictUpdate(
          SyncCursorsCompanion.insert(entity: entity, lastSyncedCursor: Value(cursor)),
        );
  }
}
