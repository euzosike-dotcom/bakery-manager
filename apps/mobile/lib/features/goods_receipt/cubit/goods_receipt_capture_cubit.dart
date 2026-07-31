import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/goods_receipt_repository.dart';
import 'goods_receipt_capture_state.dart';

/// Drives one GRN capture screen. Everything this cubit does is a local,
/// synchronous-feeling operation against the Drift cache (SDD §2.1) — there
/// is deliberately no network call anywhere in this class. Whether the
/// device is online or has been offline for a week, capture behaves
/// identically; syncing is entirely `SyncService`'s concern, decoupled from
/// this screen's lifecycle.
class GoodsReceiptCaptureCubit extends Cubit<GoodsReceiptCaptureState> {
  GoodsReceiptCaptureCubit({
    required this.repository,
    required String poId,
    required List<PoLineDraft> initialLines,
    required String warehouseId,
  }) : super(GoodsReceiptCaptureState(
          status: GoodsReceiptCaptureStatus.ready,
          poId: poId,
          warehouseId: warehouseId,
          lines: initialLines,
        ));

  final GoodsReceiptRepository repository;

  void updateLineQuantities(String poLineId, {double? acceptedQty, double? rejectedQty}) {
    final updated = state.lines
        .map((line) => line.poLineId == poLineId
            ? line.copyWith(enteredAcceptedQty: acceptedQty, enteredRejectedQty: rejectedQty)
            : line)
        .toList();
    emit(state.copyWith(lines: updated));
  }

  Future<void> submit({String? receiverUserId}) async {
    if (!state.hasAnyEnteredQuantity) {
      emit(state.copyWith(status: GoodsReceiptCaptureStatus.error, errorMessage: 'Enter a quantity for at least one line.'));
      return;
    }
    emit(state.copyWith(status: GoodsReceiptCaptureStatus.submitting));
    try {
      final linesToSubmit = state.lines.where((l) => l.enteredReceivedQty > 0);
      final grnId = await repository.captureGoodsReceipt(
        poId: state.poId,
        warehouseId: state.warehouseId!,
        receiverUserId: receiverUserId,
        lines: linesToSubmit
            .map((l) => GrnLineInput(
                  poLineId: l.poLineId,
                  receivedQty: l.enteredReceivedQty,
                  acceptedQty: l.enteredAcceptedQty,
                  rejectedQty: l.enteredRejectedQty,
                  uom: l.uom,
                  unitCost: l.unitCost,
                ))
            .toList(),
      );
      emit(state.copyWith(status: GoodsReceiptCaptureStatus.submitted, submittedGrnId: grnId));
    } catch (e) {
      emit(state.copyWith(status: GoodsReceiptCaptureStatus.error, errorMessage: e.toString()));
    }
  }
}
