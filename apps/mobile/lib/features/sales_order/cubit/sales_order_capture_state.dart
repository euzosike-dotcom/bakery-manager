import 'package:equatable/equatable.dart';

enum SalesOrderCaptureStatus { ready, submitting, submitted, error }

class SalesOrderCaptureState extends Equatable {
  const SalesOrderCaptureState({
    required this.status,
    required this.agentId,
    required this.plantId,
    required this.availableCapitalAtOpen,
    required this.customers,
    this.customerId,
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
  // Fetched once by the caller (see main.dart's _AgentDetailScreen), same
  // online-only simplification as every other master-data list in this
  // app — not re-fetched here. Optional: NULL means "no CRM customer
  // recorded for this order", which is a fully valid choice.
  final List<Map<String, dynamic>> customers;
  final String? customerId;
  final double orderedQty;
  final double unitPrice;
  final String? errorMessage;
  final String? submittedOrderId;

  double get totalOrderValue => orderedQty * unitPrice;
  bool get looksWithinCapitalAtOpen => totalOrderValue <= availableCapitalAtOpen;

  SalesOrderCaptureState copyWith({
    SalesOrderCaptureStatus? status,
    String? customerId,
    bool clearCustomerId = false,
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
        customers: customers,
        customerId: clearCustomerId ? null : (customerId ?? this.customerId),
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
        customers,
        customerId,
        orderedQty,
        unitPrice,
        errorMessage,
        submittedOrderId,
      ];
}
