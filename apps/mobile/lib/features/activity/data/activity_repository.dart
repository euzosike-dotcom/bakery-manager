import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

/// Same local-first shape as NcrRepository/SalesOrderRepository — a Drift
/// write plus one outbox event, no network call. This is CRM's one
/// offline-capturable entity (see ActivitiesLocal's doc comment).
class ActivityRepository {
  ActivityRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> logActivity({
    required String customerId,
    required String activityType,
    String? notes,
  }) async {
    final activityId = _uuid.v4();
    final clientEventId = _uuid.v4();
    final activityDate = DateTime.now();

    await db.transaction(() async {
      await db.into(db.activitiesLocal).insert(
            ActivitiesLocalCompanion.insert(
              activityId: activityId,
              customerId: customerId,
              activityType: activityType,
              notes: Value(notes),
              activityDate: activityDate,
              clientEventId: clientEventId,
            ),
          );

      final payload = {
        'activityId': activityId,
        'customerId': customerId,
        'activityType': activityType,
        'notes': notes,
        'activityDate': activityDate.toIso8601String(),
        'clientEventId': clientEventId,
        'deviceId': deviceId,
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'activity',
              entityId: activityId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return activityId;
  }
}
