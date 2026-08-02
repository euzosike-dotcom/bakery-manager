import 'dart:convert';

import 'package:uuid/uuid.dart';

import '../../../core/database/database.dart';
import '../../../core/sync/hlc.dart';

/// Same local-first shape as every other capture repository: a Drift
/// write plus one outbox event, no network call. Attendance clock-in/out
/// is the one offline-capturable surface in this module (SDD §3.F) — no
/// form fields to manage beyond which button was tapped, so this feature
/// skips the Cubit/State pair every other capture screen uses (nothing to
/// manage beyond a submit-in-flight boolean, which the call site handles
/// directly) — see _EmployeeDetailScreen in main.dart.
class AttendanceRepository {
  AttendanceRepository({required this.db, required this.deviceId}) : _hlc = HybridLogicalClock(deviceId);

  final AppDatabase db;
  final String deviceId;
  final HybridLogicalClock _hlc;
  static const _uuid = Uuid();

  Future<String> recordAttendance({required String employeeId, required String eventType}) async {
    final attendanceLogId = _uuid.v4();
    final clientEventId = _uuid.v4();
    final eventTime = DateTime.now();

    await db.transaction(() async {
      await db.into(db.attendanceLogsLocal).insert(
            AttendanceLogsLocalCompanion.insert(
              attendanceLogId: attendanceLogId,
              employeeId: employeeId,
              eventType: eventType,
              eventTime: eventTime,
              clientEventId: clientEventId,
            ),
          );

      final payload = {
        'attendanceLogId': attendanceLogId,
        'employeeId': employeeId,
        'eventType': eventType,
        'eventTime': eventTime.toIso8601String(),
        'clientEventId': clientEventId,
        'deviceId': deviceId,
      };

      await db.into(db.outboxEvents).insert(
            OutboxEventsCompanion.insert(
              clientEventId: clientEventId,
              entityType: 'attendance_log',
              entityId: attendanceLogId,
              operation: 'CREATE',
              payloadJson: jsonEncode(payload),
              hlcTimestamp: _hlc.next(),
            ),
          );
    });

    return attendanceLogId;
  }
}
