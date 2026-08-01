import 'package:equatable/equatable.dart';

enum ActivityCaptureStatus { ready, submitting, submitted, error }

class ActivityCaptureState extends Equatable {
  const ActivityCaptureState({
    required this.status,
    required this.customerId,
    this.activityType = 'VISIT',
    this.notes,
    this.errorMessage,
    this.submittedActivityId,
  });

  final ActivityCaptureStatus status;
  final String customerId;
  final String activityType;
  final String? notes;
  final String? errorMessage;
  final String? submittedActivityId;

  ActivityCaptureState copyWith({
    ActivityCaptureStatus? status,
    String? activityType,
    String? notes,
    String? errorMessage,
    String? submittedActivityId,
  }) =>
      ActivityCaptureState(
        status: status ?? this.status,
        customerId: customerId,
        activityType: activityType ?? this.activityType,
        notes: notes ?? this.notes,
        errorMessage: errorMessage,
        submittedActivityId: submittedActivityId ?? this.submittedActivityId,
      );

  @override
  List<Object?> get props => [status, customerId, activityType, notes, errorMessage, submittedActivityId];
}
