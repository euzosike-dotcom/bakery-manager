import 'package:equatable/equatable.dart';

enum GoodsReceiptCaptureStatus { loading, ready, submitting, submitted, error }

class PoLineDraft extends Equatable {
  const PoLineDraft({
    required this.poLineId,
    required this.description,
    required this.orderedQty,
    required this.receivedQtySoFar,
    required this.uom,
    required this.unitCost,
    this.enteredAcceptedQty = 0,
    this.enteredRejectedQty = 0,
  });

  final String poLineId;
  final String description;
  final double orderedQty;
  final double receivedQtySoFar;
  final String uom;
  final double unitCost;
  final double enteredAcceptedQty;
  final double enteredRejectedQty;

  double get remainingQty => orderedQty - receivedQtySoFar;
  double get enteredReceivedQty => enteredAcceptedQty + enteredRejectedQty;

  PoLineDraft copyWith({double? enteredAcceptedQty, double? enteredRejectedQty}) => PoLineDraft(
        poLineId: poLineId,
        description: description,
        orderedQty: orderedQty,
        receivedQtySoFar: receivedQtySoFar,
        uom: uom,
        unitCost: unitCost,
        enteredAcceptedQty: enteredAcceptedQty ?? this.enteredAcceptedQty,
        enteredRejectedQty: enteredRejectedQty ?? this.enteredRejectedQty,
      );

  @override
  List<Object?> get props =>
      [poLineId, description, orderedQty, receivedQtySoFar, uom, unitCost, enteredAcceptedQty, enteredRejectedQty];
}

class GoodsReceiptCaptureState extends Equatable {
  const GoodsReceiptCaptureState({
    required this.status,
    required this.poId,
    this.warehouseId,
    this.lines = const [],
    this.errorMessage,
    this.submittedGrnId,
  });

  final GoodsReceiptCaptureStatus status;
  final String poId;
  final String? warehouseId;
  final List<PoLineDraft> lines;
  final String? errorMessage;
  final String? submittedGrnId;

  bool get hasAnyEnteredQuantity => lines.any((l) => l.enteredReceivedQty > 0);

  GoodsReceiptCaptureState copyWith({
    GoodsReceiptCaptureStatus? status,
    String? warehouseId,
    List<PoLineDraft>? lines,
    String? errorMessage,
    String? submittedGrnId,
  }) =>
      GoodsReceiptCaptureState(
        status: status ?? this.status,
        poId: poId,
        warehouseId: warehouseId ?? this.warehouseId,
        lines: lines ?? this.lines,
        errorMessage: errorMessage,
        submittedGrnId: submittedGrnId ?? this.submittedGrnId,
      );

  @override
  List<Object?> get props => [status, poId, warehouseId, lines, errorMessage, submittedGrnId];
}
