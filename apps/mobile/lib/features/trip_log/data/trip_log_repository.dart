import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

/// Same local-first shape as every other capture repository: a Drift
/// write plus one outbox event, no network call. Trip logs are one of
/// the two canonical offline-capture use cases named in the SDD mandate
/// (§3.E) — see TripLogsLocal's doc comment.
class TripLogRepository {
  TripLogRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> captureTripLog({
    required String vehicleId,
    required String driverId,
    required double startMileage,
    required double endMileage,
    String? destinationNote,
  }) async {
    final tripLogId = _uuid.v4();
    final clientEventId = _uuid.v4();
    final tripDate = DateTime.now();

    await db.transaction(() async {
      await db.into(db.tripLogsLocal).insert(
            TripLogsLocalCompanion.insert(
              tripLogId: tripLogId,
              vehicleId: vehicleId,
              driverId: driverId,
              tripDate: tripDate,
              startMileage: startMileage,
              endMileage: endMileage,
              destinationNote: Value(destinationNote),
              clientEventId: clientEventId,
            ),
          );

      final payload = {
        'tripLogId': tripLogId,
        'vehicleId': vehicleId,
        'driverId': driverId,
        'startMileage': startMileage,
        'endMileage': endMileage,
        'destinationNote': destinationNote,
        'tripDate': tripDate.toIso8601String(),
        'clientEventId': clientEventId,
        'deviceId': deviceId,
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'trip_log',
              entityId: tripLogId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return tripLogId;
  }
}
