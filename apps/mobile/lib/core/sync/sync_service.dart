import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:drift/drift.dart';

import '../database/database.dart';
import 'api_client.dart';

/// Drives both directions of SDD §2.2:
///  - push: replays PENDING `OutboxEvents` rows through `/sync/push`
///  - pull: replicates server-authoritative `goods_receipts` /
///    `goods_receipt_lines` state into the local cache, advancing the
///    per-table cursor in `SyncCursors`
///
/// Triggered on connectivity regain and can also be called manually (e.g. a
/// pull-to-refresh gesture). Safe to call concurrently with itself — a
/// `_running` guard collapses overlapping triggers into one pass.
class SyncService {
  SyncService({required this.db, required this.api});

  final AppDatabase db;
  final ApiClient api;

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

    final events = pending
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
      // Network/server failure: revert to PENDING so the next connectivity
      // trigger retries the whole batch (exponential backoff at the retry
      // layer is a straightforward follow-up; not required to prove the
      // pattern — see docs/SDD.md §2.2).
      await db.batch((batch) {
        batch.update(
          db.outboxEvents,
          const OutboxEventsCompanion(syncStatus: Value('PENDING')),
          where: (t) => t.clientEventId.isIn(pending.map((e) => e.clientEventId)),
        );
      });
      rethrow;
    }

    for (final result in results) {
      final clientEventId = result['clientEventId'] as String;
      final status = result['status'] as String; // ACKED | REJECTED | NEEDS_REVIEW
      await (db.update(db.outboxEvents)..where((t) => t.clientEventId.equals(clientEventId))).write(
        OutboxEventsCompanion(
          syncStatus: Value(status),
          serverResponseJson: Value(jsonEncode(result)),
          retryCount: Value((pending.firstWhere((e) => e.clientEventId == clientEventId).retryCount) + 1),
        ),
      );
    }
  }

  Future<void> _pullEntity(String entity) async {
    var cursor = await _readCursor(entity);
    while (true) {
      final page = await api.syncPull(entity, cursor);
      if (page.records.isEmpty) break;

      if (entity == 'goods_receipts') {
        await _applyGoodsReceiptsPage(page.records);
      } else if (entity == 'goods_receipt_lines') {
        await _applyGoodsReceiptLinesPage(page.records);
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
