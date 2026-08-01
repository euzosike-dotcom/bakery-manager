import 'dart:convert';

import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

/// Same local-first shape as SalesOrderRepository. `verifiedFlag` is always
/// false at capture time — verification is a separate, online-only,
/// back-office action this client never performs (NcrService's doc comment
/// on the server side has the full rationale for why).
class NcrRepository {
  NcrRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> submitNcr({required String agentId, required double amount}) async {
    final ncrId = _uuid.v4();
    final clientEventId = _uuid.v4();
    final collectionDate = DateTime.now();
    final ncrReference = 'NCR-OFFLINE-${ncrId.substring(0, 8)}';

    await db.transaction(() async {
      await db.into(db.ncrCollectionsLocal).insert(
            NcrCollectionsLocalCompanion.insert(
              ncrId: ncrId,
              ncrReference: ncrReference,
              agentId: agentId,
              collectionDate: collectionDate,
              amount: amount,
              clientEventId: clientEventId,
            ),
          );

      final payload = {
        'ncrId': ncrId,
        'ncrReference': ncrReference,
        'agentId': agentId,
        'amount': amount,
        'collectionDate': collectionDate.toIso8601String(),
        'clientEventId': clientEventId,
        'deviceId': deviceId,
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'ncr_collection',
              entityId: ncrId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return ncrId;
  }
}
