import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/fuel_record_repository.dart';
import 'fuel_record_capture_state.dart';

/// Drives Fuel Record capture — local-first, same as every other capture
/// cubit in this app. No client-side variance computation happens here;
/// that's entirely server-side (FuelService), same "server decides, not
/// the client" discipline as SalesOrderCaptureCubit's capital check.
class FuelRecordCaptureCubit extends Cubit<FuelRecordCaptureState> {
  FuelRecordCaptureCubit({required this.repository, required String vehicleId})
      : super(FuelRecordCaptureState(status: FuelRecordCaptureStatus.ready, vehicleId: vehicleId));

  final FuelRecordRepository repository;

  void updateLitres(double litres) => emit(state.copyWith(litres: litres));
  void updateFuelCost(double cost) => emit(state.copyWith(fuelCost: cost));
  void updateExpenseClaimReference(String ref) => emit(state.copyWith(expenseClaimReference: ref));

  Future<void> submit() async {
    if (state.litres <= 0 || state.fuelCost <= 0) {
      emit(state.copyWith(status: FuelRecordCaptureStatus.error, errorMessage: 'Enter litres and fuel cost.'));
      return;
    }
    emit(state.copyWith(status: FuelRecordCaptureStatus.submitting));
    try {
      final fuelRecordId = await repository.captureFuelRecord(
        vehicleId: state.vehicleId,
        litres: state.litres,
        fuelCost: state.fuelCost,
        expenseClaimReference: state.expenseClaimReference,
      );
      emit(state.copyWith(status: FuelRecordCaptureStatus.submitted, submittedFuelRecordId: fuelRecordId));
    } catch (e) {
      emit(state.copyWith(status: FuelRecordCaptureStatus.error, errorMessage: e.toString()));
    }
  }
}
