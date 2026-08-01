import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/production_batch_repository.dart';
import 'production_batch_capture_state.dart';

/// Drives batch-close capture. Like GoodsReceiptCaptureCubit, everything
/// here is a local Drift write — no network call, so this works identically
/// online or offline. Yield % is deliberately NOT computed client-side: it
/// depends on the recipe version's standard cost/threshold, which this
/// client doesn't authoritatively hold (SDD §2.3 scenario #5 — pinned
/// server-side data, not duplicated client-side business logic). It becomes
/// visible once the batch has synced and been pulled back.
class ProductionBatchCaptureCubit extends Cubit<ProductionBatchCaptureState> {
  ProductionBatchCaptureCubit({
    required this.repository,
    required String plantId,
    required String skuId,
    required String recipeVersionId,
    required double plannedBatchQty,
    required List<IngredientLineDraft> initialLines,
  }) : super(ProductionBatchCaptureState(
          status: ProductionBatchCaptureStatus.ready,
          plantId: plantId,
          skuId: skuId,
          recipeVersionId: recipeVersionId,
          plannedBatchQty: plannedBatchQty,
          lines: initialLines,
        ));

  final ProductionBatchRepository repository;

  void updateIngredientActualQty(String ingredientSkuId, double actualQty) {
    final updated = state.lines
        .map((l) => l.ingredientSkuId == ingredientSkuId ? l.copyWith(enteredActualQty: actualQty) : l)
        .toList();
    emit(state.copyWith(lines: updated));
  }

  void updateOutputQty(double qty) => emit(state.copyWith(enteredOutputQty: qty));

  void updateWasteQty(double qty) => emit(state.copyWith(enteredWasteQty: qty));

  Future<void> submit() async {
    if (!state.hasAnyEnteredQuantity) {
      emit(state.copyWith(
        status: ProductionBatchCaptureStatus.error,
        errorMessage: 'Enter the output quantity and at least one ingredient consumption.',
      ));
      return;
    }
    emit(state.copyWith(status: ProductionBatchCaptureStatus.submitting));
    try {
      final batchId = await repository.closeProductionBatch(
        plantId: state.plantId,
        skuId: state.skuId,
        recipeVersionId: state.recipeVersionId,
        plannedQty: state.plannedBatchQty,
        actualOutputQty: state.enteredOutputQty,
        actualWasteQty: state.enteredWasteQty,
        lines: state.lines
            .where((l) => l.enteredActualQty > 0)
            .map((l) => ConsumptionLineInput(
                  ingredientSkuId: l.ingredientSkuId,
                  plannedQty: l.plannedQty,
                  actualQty: l.enteredActualQty,
                ))
            .toList(),
      );
      emit(state.copyWith(status: ProductionBatchCaptureStatus.submitted, submittedBatchId: batchId));
    } catch (e) {
      emit(state.copyWith(status: ProductionBatchCaptureStatus.error, errorMessage: e.toString()));
    }
  }
}
