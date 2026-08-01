import 'dart:convert';

import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

class ConsumptionLineInput {
  ConsumptionLineInput({required this.ingredientSkuId, required this.plannedQty, required this.actualQty});

  final String ingredientSkuId;
  final double plannedQty;
  final double actualQty;
}

/// Same local-first shape as GoodsReceiptRepository: writes are always
/// local-only (Drift transaction + one outbox event), never a network call.
/// `SyncService` picks the queued event up independently (SDD §2.1).
class ProductionBatchRepository {
  ProductionBatchRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> closeProductionBatch({
    required String plantId,
    required String skuId,
    required String recipeVersionId,
    required double plannedQty,
    required double actualOutputQty,
    required double actualWasteQty,
    required List<ConsumptionLineInput> lines,
  }) async {
    final batchId = _uuid.v4();
    final clientEventId = _uuid.v4();
    final batchDate = DateTime.now();
    // Provisional, human-scannable number for offline capture — same
    // rationale as GoodsReceiptRepository's grnNumber: display-only, the
    // server never depends on it for identity.
    final batchNumber = 'BATCH-OFFLINE-${batchId.substring(0, 8)}';

    await db.transaction(() async {
      await db.into(db.productionBatchesLocal).insert(
            ProductionBatchesLocalCompanion.insert(
              batchId: batchId,
              batchNumber: batchNumber,
              plantId: plantId,
              skuId: skuId,
              recipeVersionId: recipeVersionId,
              batchDate: batchDate,
              plannedQty: plannedQty,
              actualOutputQty: actualOutputQty,
              actualWasteQty: actualWasteQty,
              clientEventId: clientEventId,
            ),
          );

      for (final line in lines) {
        await db.into(db.productionConsumptionLocal).insert(
              ProductionConsumptionLocalCompanion.insert(
                consumptionId: _uuid.v4(),
                batchId: batchId,
                ingredientSkuId: line.ingredientSkuId,
                plannedQty: line.plannedQty,
                actualQty: line.actualQty,
              ),
            );
      }

      final payload = {
        'batchId': batchId,
        'batchNumber': batchNumber,
        'plantId': plantId,
        'skuId': skuId,
        'recipeVersionId': recipeVersionId,
        'batchDate': batchDate.toIso8601String(),
        'plannedQty': plannedQty,
        'actualOutputQty': actualOutputQty,
        'actualWasteQty': actualWasteQty,
        'clientEventId': clientEventId,
        'deviceId': deviceId,
        'consumptionLines': lines
            .map((l) => {
                  'ingredientSkuId': l.ingredientSkuId,
                  'plannedQty': l.plannedQty,
                  'actualQty': l.actualQty,
                })
            .toList(),
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'production_batch',
              entityId: batchId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return batchId;
  }
}
