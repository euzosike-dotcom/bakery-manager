import 'package:equatable/equatable.dart';

enum SalesOrderCaptureStatus { ready, submitting, submitted, error }

class SalesOrderCaptureState extends Equatable {
  const SalesOrderCaptureState({
    required this.status,
    required this.agentId,
    required this.plantId,
    required this.availableCapitalAtOpen,
    this.orderedQty = 0,
    this.unitPrice = 0,
    this.errorMessage,
    this.submittedOrderId,
  });

  final SalesOrderCaptureStatus status;
  final String agentId;
  final String plantId;
  // Snapshot only, for display — NOT what gates the order. See
  // SalesOrderCaptureCubit's doc comment: the server re-checks live,
  // regardless of what this was when the screen opened.
  final double availableCapitalAtOpen;
  final double orderedQty;
  final double unitPrice;
  final String? errorMessage;
  final String? submittedOrderId;

  double get totalOrderValue => orderedQty * unitPrice;
  bool get looksWithinCapitalAtOpen => totalOrderValue <= availableCapitalAtOpen;

  SalesOrderCaptureState copyWith({
    SalesOrderCaptureStatus? status,
    double? orderedQty,
    double? unitPrice,
    String? errorMessage,
    String? submittedOrderId,
  }) =>
      SalesOrderCaptureState(
        status: status ?? this.status,
        agentId: agentId,
        plantId: plantId,
        availableCapitalAtOpen: availableCapitalAtOpen,
        orderedQty: orderedQty ?? this.orderedQty,
        unitPrice: unitPrice ?? this.unitPrice,
        errorMessage: errorMessage,
        submittedOrderId: submittedOrderId ?? this.submittedOrderId,
      );

  @override
  List<Object?> get props => [
        status,
        agentId,
        plantId,
        availableCapitalAtOpen,
        orderedQty,
        unitPrice,
        errorMessage,
        submittedOrderId,
      ];
}
