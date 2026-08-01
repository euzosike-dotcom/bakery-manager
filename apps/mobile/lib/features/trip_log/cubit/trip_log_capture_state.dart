import 'package:equatable/equatable.dart';

enum TripLogCaptureStatus { ready, submitting, submitted, error }

class TripLogCaptureState extends Equatable {
  const TripLogCaptureState({
    required this.status,
    required this.vehicleId,
    required this.driverId,
    required this.currentMileageAtOpen,
    this.startMileage,
    this.endMileage,
    this.destinationNote,
    this.errorMessage,
    this.submittedTripLogId,
  });

  final TripLogCaptureStatus status;
  final String vehicleId;
  final String driverId;
  // Snapshot only, for pre-filling startMileage — the server is what
  // actually advances the vehicle's current_mileage (see TripsService's
  // doc comment), same "live computation, server decides" discipline as
  // SalesOrderCaptureState.availableCapitalAtOpen.
  final double currentMileageAtOpen;
  final double? startMileage;
  final double? endMileage;
  final String? destinationNote;
  final String? errorMessage;
  final String? submittedTripLogId;

  TripLogCaptureState copyWith({
    TripLogCaptureStatus? status,
    double? startMileage,
    double? endMileage,
    String? destinationNote,
    String? errorMessage,
    String? submittedTripLogId,
  }) =>
      TripLogCaptureState(
        status: status ?? this.status,
        vehicleId: vehicleId,
        driverId: driverId,
        currentMileageAtOpen: currentMileageAtOpen,
        startMileage: startMileage ?? this.startMileage,
        endMileage: endMileage ?? this.endMileage,
        destinationNote: destinationNote ?? this.destinationNote,
        errorMessage: errorMessage,
        submittedTripLogId: submittedTripLogId ?? this.submittedTripLogId,
      );

  @override
  List<Object?> get props => [
        status,
        vehicleId,
        driverId,
        currentMileageAtOpen,
        startMileage,
        endMileage,
        destinationNote,
        errorMessage,
        submittedTripLogId,
      ];
}
