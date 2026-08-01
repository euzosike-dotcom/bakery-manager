import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

/// Same local-first shape as TripLogRepository. `tripLogId` is left
/// unset from this screen — matching a specific trip would need a trip-
/// picker UI (a list-trips-for-vehicle endpoint doesn't exist on the
/// client side), which isn't required to prove offline capture; the
/// variance-investigation workflow itself is already proven directly
/// against the backend (see docs/RUNBOOK.md). A fuel record with no
/// trip_log_id is a fully valid case anyway (e.g. a periodic tank
/// fill-up not tied to one specific trip).
class FuelRecordRepository {
  FuelRecordRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> captureFuelRecord({
    required String vehicleId,
    required double litres,
    required double fuelCost,
    String? expenseClaimReference,
  }) async {
    final fuelRecordId = _uuid.v4();
    final clientEventId = _uuid.v4();

    await db.transaction(() async {
      await db.into(db.fuelRecordsLocal).insert(
            FuelRecordsLocalCompanion.insert(
              fuelRecordId: fuelRecordId,
              vehicleId: vehicleId,
              litres: litres,
              fuelCost: fuelCost,
              expenseClaimReference: Value(expenseClaimReference),
              clientEventId: clientEventId,
            ),
          );

      final payload = {
        'fuelRecordId': fuelRecordId,
        'vehicleId': vehicleId,
        'litres': litres,
        'fuelCost': fuelCost,
        'expenseClaimReference': expenseClaimReference,
        'clientEventId': clientEventId,
        'deviceId': deviceId,
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'fuel_record',
              entityId: fuelRecordId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return fuelRecordId;
  }
}
