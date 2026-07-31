import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

class GrnLineInput {
  GrnLineInput({
    required this.poLineId,
    required this.receivedQty,
    required this.acceptedQty,
    required this.rejectedQty,
    required this.uom,
    required this.unitCost,
  });

  final String poLineId;
  final double receivedQty;
  final double acceptedQty;
  final double rejectedQty;
  final String uom;
  final double unitCost;
}

/// Writes are always local-first: this method never calls the network. It
/// commits the GRN + lines to the Drift cache and appends one outbox event
/// in a single local transaction, then returns immediately — `SyncService`
/// picks the event up on the next connectivity-triggered (or manual) sync
/// pass. This is what makes GRN capture work identically whether the tablet
/// is online or has been offline for days (SDD §2.1).
class GoodsReceiptRepository {
  GoodsReceiptRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> captureGoodsReceipt({
    required String poId,
    required String warehouseId,
    required List<GrnLineInput> lines,
    String? receiverUserId,
  }) async {
    final grnId = _uuid.v4();
    final clientEventId = _uuid.v4();
    final receiptDate = DateTime.now();
    // Provisional, human-scannable number for offline capture. The server
    // does not depend on this for identity (grnId is the real key) — it's
    // display-only until a canonical numbering scheme is layered on.
    final grnNumber = 'GRN-OFFLINE-${grnId.substring(0, 8)}';

    final lineRecords = lines
        .map((l) => (
              grnLineId: _uuid.v4(),
              input: l,
            ))
        .toList();

    await db.transaction(() async {
      await db.into(db.goodsReceiptsLocal).insert(
            GoodsReceiptsLocalCompanion.insert(
              grnId: grnId,
              grnNumber: grnNumber,
              poId: poId,
              warehouseId: warehouseId,
              receiptDate: receiptDate,
              clientEventId: clientEventId,
              createdOffline: const Value(true),
              syncSeq: const Value.absent(),
            ),
          );

      for (final rec in lineRecords) {
        await db.into(db.goodsReceiptLinesLocal).insert(
              GoodsReceiptLinesLocalCompanion.insert(
                grnLineId: rec.grnLineId,
                grnId: grnId,
                poLineId: rec.input.poLineId,
                receivedQty: rec.input.receivedQty,
                acceptedQty: rec.input.acceptedQty,
                rejectedQty: rec.input.rejectedQty,
                uom: rec.input.uom,
                unitCost: rec.input.unitCost,
              ),
            );
      }

      final payload = {
        'grnId': grnId,
        'grnNumber': grnNumber,
        'poId': poId,
        'warehouseId': warehouseId,
        'receiptDate': receiptDate.toIso8601String(),
        if (receiverUserId != null) 'receiverUserId': receiverUserId,
        'clientEventId': clientEventId,
        'deviceId': deviceId,
        'lines': lineRecords
            .map((rec) => {
                  'grnLineId': rec.grnLineId,
                  'poLineId': rec.input.poLineId,
                  'receivedQty': rec.input.receivedQty,
                  'acceptedQty': rec.input.acceptedQty,
                  'rejectedQty': rec.input.rejectedQty,
                  'uom': rec.input.uom,
                  'unitCost': rec.input.unitCost,
                })
            .toList(),
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'goods_receipt',
              entityId: grnId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return grnId;
  }
}
