import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:metrock_mobile/core/database/database.dart';
import 'package:metrock_mobile/features/goods_receipt/data/goods_receipt_repository.dart';

/// `captureGoodsReceipt` is the offline capture path (SDD §2.1): it never
/// touches the network, only the local Drift cache — `SyncService` picks
/// the outbox row up later. Run against a REAL in-memory sqlite database
/// (`NativeDatabase.memory()`), not a mock, so this actually proves the
/// write lands correctly, the same "real database over a mock where it's
/// cheap" reasoning behind CI Phase 3's Postgres integration tests —
/// `AppDatabase`'s constructor now optionally accepts a `QueryExecutor`
/// specifically so this can run without `path_provider`'s platform
/// channel, which plain `flutter test` doesn't have.
void main() {
  late AppDatabase db;
  late GoodsReceiptRepository repository;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    repository = GoodsReceiptRepository(db: db, deviceId: 'test-device-1');
  });

  tearDown(() async {
    await db.close();
  });

  test('commits the GRN, its lines, and exactly one PENDING outbox event in one local transaction', () async {
    final grnId = await repository.captureGoodsReceipt(
      poId: 'po-1',
      warehouseId: 'wh-1',
      receiverUserId: 'user-1',
      lines: [
        GrnLineInput(poLineId: 'line-1', receivedQty: 30, acceptedQty: 28, rejectedQty: 2, uom: 'KG', unitCost: 480),
        GrnLineInput(poLineId: 'line-2', receivedQty: 10, acceptedQty: 10, rejectedQty: 0, uom: 'KG', unitCost: 200),
      ],
    );

    final grnRow = await (db.select(db.goodsReceiptsLocal)..where((t) => t.grnId.equals(grnId))).getSingle();
    expect(grnRow.poId, 'po-1');
    expect(grnRow.warehouseId, 'wh-1');
    expect(grnRow.createdOffline, isTrue);
    expect(grnRow.syncSeq, isNull); // not yet assigned by the server

    final lineRows = await (db.select(db.goodsReceiptLinesLocal)..where((t) => t.grnId.equals(grnId))).get();
    expect(lineRows, hasLength(2));
    expect(lineRows.map((l) => l.poLineId), containsAll(['line-1', 'line-2']));

    final outboxRows = await db.select(db.outboxEvents).get();
    expect(outboxRows, hasLength(1));

    final event = outboxRows.single;
    expect(event.entityType, 'goods_receipt');
    expect(event.entityId, grnId);
    expect(event.operation, 'CREATE');
    expect(event.syncStatus, 'PENDING'); // table default — nothing marks it in-flight yet
    expect(event.clientEventId, grnRow.clientEventId); // outbox idempotency key IS the GRN's own client_event_id
    expect(event.hlcTimestamp, isNotEmpty);

    final payload = jsonDecode(event.payloadJson) as Map<String, dynamic>;
    expect(payload['grnId'], grnId);
    expect(payload['poId'], 'po-1');
    expect(payload['deviceId'], 'test-device-1');
    expect(payload['receiverUserId'], 'user-1');
    final payloadLines = payload['lines'] as List<dynamic>;
    expect(payloadLines, hasLength(2));
  });

  test('two captures produce two independent GRNs with two independent outbox events', () async {
    final firstId = await repository.captureGoodsReceipt(
      poId: 'po-1',
      warehouseId: 'wh-1',
      lines: [GrnLineInput(poLineId: 'line-1', receivedQty: 5, acceptedQty: 5, rejectedQty: 0, uom: 'KG', unitCost: 100)],
    );
    final secondId = await repository.captureGoodsReceipt(
      poId: 'po-2',
      warehouseId: 'wh-1',
      lines: [GrnLineInput(poLineId: 'line-2', receivedQty: 3, acceptedQty: 3, rejectedQty: 0, uom: 'KG', unitCost: 50)],
    );

    expect(firstId, isNot(secondId));
    final outboxRows = await db.select(db.outboxEvents).get();
    expect(outboxRows, hasLength(2));
    expect(outboxRows.map((e) => e.entityId).toSet(), {firstId, secondId});
  });

  test('omitting receiverUserId leaves it out of the outbox payload entirely, not null', () async {
    final grnId = await repository.captureGoodsReceipt(
      poId: 'po-1',
      warehouseId: 'wh-1',
      lines: [GrnLineInput(poLineId: 'line-1', receivedQty: 1, acceptedQty: 1, rejectedQty: 0, uom: 'KG', unitCost: 10)],
    );

    final event = await (db.select(db.outboxEvents)..where((t) => t.entityId.equals(grnId))).getSingle();
    final payload = jsonDecode(event.payloadJson) as Map<String, dynamic>;
    expect(payload.containsKey('receiverUserId'), isFalse);
  });
}
