import 'dart:convert';

import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

class OrderLineInput {
  OrderLineInput({required this.skuId, required this.orderedQty, required this.unitPrice});
  final String skuId;
  final double orderedQty;
  final double unitPrice;
}

/// Same local-first shape as the other two modules' repositories: writes
/// are always local-only (Drift transaction + one outbox event), never a
/// network call. The order's `creditEligibilityStatus` is written locally
/// as `PENDING_SYNC_VALIDATION` and is NOT the client's opinion on whether
/// the order is within capital — the server is the only thing that decides
/// that, at sync time (SDD §2.3 scenario #7). See
/// SalesOrderCaptureCubit's doc comment for why this repository never
/// computes or checks available capital itself.
class SalesOrderRepository {
  SalesOrderRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> captureSalesOrder({
    required String agentId,
    required String plantId,
    required List<OrderLineInput> lines,
  }) async {
    final salesOrderId = _uuid.v4();
    final clientEventId = _uuid.v4();
    final orderDate = DateTime.now();
    final orderNumber = 'SO-OFFLINE-${salesOrderId.substring(0, 8)}';
    final totalOrderValue = lines.fold<double>(0, (sum, l) => sum + l.orderedQty * l.unitPrice);

    await db.transaction(() async {
      await db.into(db.salesOrdersLocal).insert(
            SalesOrdersLocalCompanion.insert(
              salesOrderId: salesOrderId,
              orderNumber: orderNumber,
              agentId: agentId,
              plantId: plantId,
              orderDate: orderDate,
              totalOrderValue: totalOrderValue,
              clientEventId: clientEventId,
            ),
          );

      final payload = {
        'salesOrderId': salesOrderId,
        'orderNumber': orderNumber,
        'agentId': agentId,
        'plantId': plantId,
        'orderDate': orderDate.toIso8601String(),
        'clientEventId': clientEventId,
        'deviceId': deviceId,
        'lines': lines
            .map((l) => {'skuId': l.skuId, 'orderedQty': l.orderedQty, 'unitPrice': l.unitPrice})
            .toList(),
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'sales_order',
              entityId: salesOrderId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return salesOrderId;
  }
}
