import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/activity_repository.dart';
import 'activity_capture_state.dart';

/// Drives Activity logging — local-first, same as every other capture
/// cubit in this app. No financial consequence to this write, so unlike
/// SalesOrderCaptureCubit there's no server-side gate to defer to.
class ActivityCaptureCubit extends Cubit<ActivityCaptureState> {
  ActivityCaptureCubit({required this.repository, required String customerId})
      : super(ActivityCaptureState(status: ActivityCaptureStatus.ready, customerId: customerId));

  final ActivityRepository repository;

  void updateActivityType(String type) => emit(state.copyWith(activityType: type));
  void updateNotes(String notes) => emit(state.copyWith(notes: notes));

  Future<void> submit() async {
    emit(state.copyWith(status: ActivityCaptureStatus.submitting));
    try {
      final activityId = await repository.logActivity(
        customerId: state.customerId,
        activityType: state.activityType,
        notes: state.notes,
      );
      emit(state.copyWith(status: ActivityCaptureStatus.submitted, submittedActivityId: activityId));
    } catch (e) {
      emit(state.copyWith(status: ActivityCaptureStatus.error, errorMessage: e.toString()));
    }
  }
}
