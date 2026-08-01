import 'package:equatable/equatable.dart';

enum FuelRecordCaptureStatus { ready, submitting, submitted, error }

class FuelRecordCaptureState extends Equatable {
  const FuelRecordCaptureState({
    required this.status,
    required this.vehicleId,
    this.litres = 0,
    this.fuelCost = 0,
    this.expenseClaimReference,
    this.errorMessage,
    this.submittedFuelRecordId,
  });

  final FuelRecordCaptureStatus status;
  final String vehicleId;
  final double litres;
  final double fuelCost;
  final String? expenseClaimReference;
  final String? errorMessage;
  final String? submittedFuelRecordId;

  FuelRecordCaptureState copyWith({
    FuelRecordCaptureStatus? status,
    double? litres,
    double? fuelCost,
    String? expenseClaimReference,
    String? errorMessage,
    String? submittedFuelRecordId,
  }) =>
      FuelRecordCaptureState(
        status: status ?? this.status,
        vehicleId: vehicleId,
        litres: litres ?? this.litres,
        fuelCost: fuelCost ?? this.fuelCost,
        expenseClaimReference: expenseClaimReference ?? this.expenseClaimReference,
        errorMessage: errorMessage,
        submittedFuelRecordId: submittedFuelRecordId ?? this.submittedFuelRecordId,
      );

  @override
  List<Object?> get props =>
      [status, vehicleId, litres, fuelCost, expenseClaimReference, errorMessage, submittedFuelRecordId];
}
