import 'package:equatable/equatable.dart';

enum ProductionBatchCaptureStatus { ready, submitting, submitted, error }

class IngredientLineDraft extends Equatable {
  const IngredientLineDraft({
    required this.ingredientSkuId,
    required this.ingredientName,
    required this.plannedQty,
    required this.uom,
    this.enteredActualQty = 0,
  });

  final String ingredientSkuId;
  final String ingredientName;
  final double plannedQty; // recipe standard quantity_per_batch
  final String uom;
  final double enteredActualQty;

  IngredientLineDraft copyWith({double? enteredActualQty}) => IngredientLineDraft(
        ingredientSkuId: ingredientSkuId,
        ingredientName: ingredientName,
        plannedQty: plannedQty,
        uom: uom,
        enteredActualQty: enteredActualQty ?? this.enteredActualQty,
      );

  @override
  List<Object?> get props => [ingredientSkuId, ingredientName, plannedQty, uom, enteredActualQty];
}

class ProductionBatchCaptureState extends Equatable {
  const ProductionBatchCaptureState({
    required this.status,
    required this.plantId,
    required this.skuId,
    required this.recipeVersionId,
    required this.plannedBatchQty,
    required this.lines,
    this.enteredOutputQty = 0,
    this.enteredWasteQty = 0,
    this.errorMessage,
    this.submittedBatchId,
    this.submittedYieldPercent,
  });

  final ProductionBatchCaptureStatus status;
  final String plantId;
  final String skuId;
  final String recipeVersionId;
  final double plannedBatchQty;
  final List<IngredientLineDraft> lines;
  final double enteredOutputQty;
  final double enteredWasteQty;
  final String? errorMessage;
  final String? submittedBatchId;
  final double? submittedYieldPercent;

  bool get hasAnyEnteredQuantity => enteredOutputQty > 0 && lines.any((l) => l.enteredActualQty > 0);

  ProductionBatchCaptureState copyWith({
    ProductionBatchCaptureStatus? status,
    List<IngredientLineDraft>? lines,
    double? enteredOutputQty,
    double? enteredWasteQty,
    String? errorMessage,
    String? submittedBatchId,
    double? submittedYieldPercent,
  }) =>
      ProductionBatchCaptureState(
        status: status ?? this.status,
        plantId: plantId,
        skuId: skuId,
        recipeVersionId: recipeVersionId,
        plannedBatchQty: plannedBatchQty,
        lines: lines ?? this.lines,
        enteredOutputQty: enteredOutputQty ?? this.enteredOutputQty,
        enteredWasteQty: enteredWasteQty ?? this.enteredWasteQty,
        errorMessage: errorMessage,
        submittedBatchId: submittedBatchId ?? this.submittedBatchId,
        submittedYieldPercent: submittedYieldPercent ?? this.submittedYieldPercent,
      );

  @override
  List<Object?> get props => [
        status,
        plantId,
        skuId,
        recipeVersionId,
        plannedBatchQty,
        lines,
        enteredOutputQty,
        enteredWasteQty,
        errorMessage,
        submittedBatchId,
        submittedYieldPercent,
      ];
}
