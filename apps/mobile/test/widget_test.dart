// The template Flutter generates here is a counter-app widget test that
// references a `MyApp` class that doesn't exist in this project (our root
// widget is `MetrockApp`, and it hits sqlite/network in initState, which
// isn't meaningfully testable without mocking `AppDatabase`/`ApiClient` —
// a real widget test harness for that is a follow-up, not a boilerplate
// fix). Replaced with a fast, dependency-free unit test of the pure
// quantity logic in `PoLineDraft`, which is at least real coverage rather
// than a copy-pasted template that happened to compile.
import 'package:flutter_test/flutter_test.dart';
import 'package:metrock_mobile/features/goods_receipt/cubit/goods_receipt_capture_state.dart';

void main() {
  test('PoLineDraft computes remaining and entered quantities correctly', () {
    const line = PoLineDraft(
      poLineId: 'line-1',
      description: 'Flour — 50kg bags',
      orderedQty: 1000,
      receivedQtySoFar: 650,
      uom: 'KG',
      unitCost: 480,
    );

    expect(line.remainingQty, 350);
    expect(line.enteredReceivedQty, 0);

    final updated = line.copyWith(enteredAcceptedQty: 80, enteredRejectedQty: 20);
    expect(updated.enteredReceivedQty, 100);
    expect(updated.remainingQty, 350); // unaffected by entered quantities
  });
}
