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
  OutboxEvents,
  SyncCursors,
])
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(_openConnection());

  @override
  int get schemaVersion => 2;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          // v1 -> v2: added the Manufacturing module's local tables. Only
          // additive so far (no existing table changed shape) — a real
          // column/type change on an existing table would need a proper
          // step-by-step migration here instead of blanket createTable calls.
          if (from < 2) {
            await m.createTable(productionBatchesLocal);
            await m.createTable(productionConsumptionLocal);
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
