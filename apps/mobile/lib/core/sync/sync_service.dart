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
enum SyncModule { procurement, manufacturing, sales, crm, fleet }

const _pushModuleForEntityType = {
  'goods_receipt': SyncModule.procurement,
  'production_batch': SyncModule.manufacturing,
  'sales_order': SyncModule.sales,
  'ncr_collection': SyncModule.sales,
  'activity': SyncModule.crm,
  'trip_log': SyncModule.fleet,
  'fuel_record': SyncModule.fleet,
};

const _pullModuleForEntity = {
  'goods_receipts': SyncModule.procurement,
  'goods_receipt_lines': SyncModule.procurement,
  'production_batches': SyncModule.manufacturing,
  'sales_orders': SyncModule.sales,
  'ncr_collections': SyncModule.sales,
  'activities': SyncModule.crm,
  'trip_logs': SyncModule.fleet,
  'fuel_records': SyncModule.fleet,
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
      await _pullEntity('sales_orders');
      await _pullEntity('ncr_collections');
      await _pullEntity('activities');
      await _pullEntity('trip_logs');
      await _pullEntity('fuel_records');
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
        case 'sales_orders':
          await _applySalesOrdersPage(page.records);
        case 'ncr_collections':
          await _applyNcrCollectionsPage(page.records);
        case 'activities':
          await _applyActivitiesPage(page.records);
        case 'trip_logs':
          await _applyTripLogsPage(page.records);
        case 'fuel_records':
          await _applyFuelRecordsPage(page.records);
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
            receivedQty: double.parse(row['received_qty'].toString()),
            acceptedQty: double.parse(row['accepted_qty'].toString()),
            rejectedQty: double.parse(row['rejected_qty'].toString()),
            uom: row['uom'] as String,
            unitCost: double.parse(row['unit_cost'].toString()),
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
            plannedQty: double.parse(row['planned_qty'].toString()),
            actualOutputQty: double.parse(row['actual_output_qty'].toString()),
            actualWasteQty: double.parse(row['actual_waste_qty'].toString()),
            yieldPercent: Value(row['yield_percent'] == null ? null : double.parse(row['yield_percent'].toString())),
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

  Future<void> _applySalesOrdersPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.salesOrdersLocal,
          SalesOrdersLocalCompanion.insert(
            salesOrderId: row['sales_order_id'] as String,
            orderNumber: row['order_number'] as String,
            agentId: row['agent_id'] as String,
            plantId: row['plant_id'] as String,
            customerId: Value(row['customer_id'] as String?),
            orderDate: DateTime.parse(row['order_date'] as String),
            totalOrderValue: double.parse(row['total_order_value'].toString()),
            orderStatus: Value(row['order_status'] as String),
            creditEligibilityStatus: Value(row['credit_eligibility_status'] as String),
            clientEventId: row['client_event_id'] as String,
            createdOffline: Value(row['created_offline'] as bool),
            syncSeq: Value(int.parse(row['sync_seq'].toString())),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  Future<void> _applyNcrCollectionsPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.ncrCollectionsLocal,
          NcrCollectionsLocalCompanion.insert(
            ncrId: row['ncr_id'] as String,
            ncrReference: row['ncr_reference'] as String,
            agentId: row['agent_id'] as String,
            collectionDate: DateTime.parse(row['collection_date'] as String),
            amount: double.parse(row['amount'].toString()),
            verifiedFlag: Value(row['verified_flag'] as bool),
            clientEventId: row['client_event_id'] as String,
            createdOffline: Value(row['created_offline'] as bool),
            syncSeq: Value(int.parse(row['sync_seq'].toString())),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  Future<void> _applyActivitiesPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.activitiesLocal,
          ActivitiesLocalCompanion.insert(
            activityId: row['activity_id'] as String,
            customerId: row['customer_id'] as String,
            activityType: row['activity_type'] as String,
            notes: Value(row['notes'] as String?),
            activityDate: DateTime.parse(row['activity_date'] as String),
            clientEventId: row['client_event_id'] as String,
            createdOffline: Value(row['created_offline'] as bool),
            syncSeq: Value(int.parse(row['sync_seq'].toString())),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  Future<void> _applyTripLogsPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.tripLogsLocal,
          TripLogsLocalCompanion.insert(
            tripLogId: row['trip_log_id'] as String,
            vehicleId: row['vehicle_id'] as String,
            driverId: row['driver_id'] as String,
            tripDate: DateTime.parse(row['trip_date'] as String),
            startMileage: double.parse(row['start_mileage'].toString()),
            endMileage: double.parse(row['end_mileage'].toString()),
            destinationNote: Value(row['destination_note'] as String?),
            clientEventId: row['client_event_id'] as String,
            createdOffline: Value(row['created_offline'] as bool),
            syncSeq: Value(int.parse(row['sync_seq'].toString())),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  Future<void> _applyFuelRecordsPage(List<Map<String, dynamic>> rows) async {
    await db.batch((batch) {
      for (final row in rows) {
        batch.insert(
          db.fuelRecordsLocal,
          FuelRecordsLocalCompanion.insert(
            fuelRecordId: row['fuel_record_id'] as String,
            vehicleId: row['vehicle_id'] as String,
            tripLogId: Value(row['trip_log_id'] as String?),
            litres: double.parse(row['litres'].toString()),
            fuelCost: double.parse(row['fuel_cost'].toString()),
            expenseClaimReference: Value(row['expense_claim_reference'] as String?),
            orphanedTripReference: Value(row['orphaned_trip_reference'] as bool),
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
