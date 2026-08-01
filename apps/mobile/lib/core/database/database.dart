import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3_flutter_libs/sqlite3_flutter_libs.dart';

import 'tables.dart';

part 'database.g.dart';

/// The device's local encrypted-at-rest (via platform full-disk encryption;
/// see docs/SDD.md §4.2 for the SQLCipher recommendation not yet wired here)
/// relational cache. Schema mirrors the server's Postgres column names 1:1
/// so the sync layer never needs a translation map (SDD §2.1).
@DriftDatabase(tables: [
  PurchaseOrdersCache,
  PurchaseOrderLinesCache,
  GoodsReceiptsLocal,
  GoodsReceiptLinesLocal,
  ProductionBatchesLocal,
  ProductionConsumptionLocal,
  SalesOrdersLocal,
  NcrCollectionsLocal,
  ActivitiesLocal,
  TripLogsLocal,
  FuelRecordsLocal,
  OutboxEvents,
  SyncCursors,
])
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(_openConnection());

  @override
  int get schemaVersion => 5;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          // v1 -> v2: added the Manufacturing module's local tables.
          // v2 -> v3: added the Sales & Agent Capital module's local
          // tables. v3 -> v4: added the CRM module's one local table
          // (Activities — Customers/Opportunities have no local table, see
          // ActivitiesLocal's doc comment). v4 -> v5: added the Fleet
          // module's two local tables (TripLogs, FuelRecords — Vehicles/
          // Drivers have no local table, same "fetched directly online"
          // simplification). All purely additive so far (no existing
          // table changed shape) — a real column/type change on an
          // existing table would need a proper step-by-step migration
          // here instead of blanket createTable calls.
          if (from < 2) {
            await m.createTable(productionBatchesLocal);
            await m.createTable(productionConsumptionLocal);
          }
          if (from < 3) {
            await m.createTable(salesOrdersLocal);
            await m.createTable(ncrCollectionsLocal);
          }
          if (from < 4) {
            await m.createTable(activitiesLocal);
            await m.addColumn(salesOrdersLocal, salesOrdersLocal.customerId);
          }
          if (from < 5) {
            await m.createTable(tripLogsLocal);
            await m.createTable(fuelRecordsLocal);
          }
        },
      );
}

LazyDatabase _openConnection() {
  return LazyDatabase(() async {
    // sqlite3_flutter_libs bundles a recent SQLite build for iOS/Android/
    // desktop; on Web, drift needs a different (wasm) backend — swap this
    // file for `database_web.dart` via conditional import when Web support
    // is prioritized. Not required to prove the offline-sync pattern on the
    // plant-tablet form factor this slice targets.
    applyWorkaroundToOpenSqlite3OnOldAndroidVersions();
    final dbFolder = await getApplicationDocumentsDirectory();
    final file = File(p.join(dbFolder.path, 'metrock_erp.sqlite'));
    return NativeDatabase.createInBackground(file);
  });
}
