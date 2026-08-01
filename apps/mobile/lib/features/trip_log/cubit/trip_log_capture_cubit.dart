import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/trip_log_repository.dart';
import 'trip_log_capture_state.dart';

/// Drives Trip Log capture — local-first, same as every other capture
/// cubit in this app.
class TripLogCaptureCubit extends Cubit<TripLogCaptureState> {
  TripLogCaptureCubit({
    required this.repository,
    required String vehicleId,
    required String driverId,
    required double currentMileageAtOpen,
  }) : super(TripLogCaptureState(
          status: TripLogCaptureStatus.ready,
          vehicleId: vehicleId,
          driverId: driverId,
          currentMileageAtOpen: currentMileageAtOpen,
          startMileage: currentMileageAtOpen,
        ));

  final TripLogRepository repository;

  void updateStartMileage(double mileage) => emit(state.copyWith(startMileage: mileage));
  void updateEndMileage(double mileage) => emit(state.copyWith(endMileage: mileage));
  void updateDestinationNote(String note) => emit(state.copyWith(destinationNote: note));

  Future<void> submit() async {
    final start = state.startMileage;
    final end = state.endMileage;
    if (start == null || end == null || end < start) {
      emit(state.copyWith(status: TripLogCaptureStatus.error, errorMessage: 'Enter a valid start/end mileage (end >= start).'));
      return;
    }
    emit(state.copyWith(status: TripLogCaptureStatus.submitting));
    try {
      final tripLogId = await repository.captureTripLog(
        vehicleId: state.vehicleId,
        driverId: state.driverId,
        startMileage: start,
        endMileage: end,
        destinationNote: state.destinationNote,
      );
      emit(state.copyWith(status: TripLogCaptureStatus.submitted, submittedTripLogId: tripLogId));
    } catch (e) {
      emit(state.copyWith(status: TripLogCaptureStatus.error, errorMessage: e.toString()));
    }
  }
}
