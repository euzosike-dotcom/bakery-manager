import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/ncr_repository.dart';
import 'ncr_submission_state.dart';

/// Drives NCR (cash collection) submission. Local-first, same as the other
/// capture cubits — this is deliberately the ONLY action in this screen;
/// verification (the action that actually restores capital) is a separate,
/// online-only back-office flow this app doesn't implement a UI for (see
/// NcrService's doc comment on the server side).
class NcrSubmissionCubit extends Cubit<NcrSubmissionState> {
  NcrSubmissionCubit({required this.repository, required String agentId})
      : super(NcrSubmissionState(status: NcrSubmissionStatus.ready, agentId: agentId));

  final NcrRepository repository;

  void updateAmount(double amount) => emit(state.copyWith(amount: amount));

  Future<void> submit() async {
    if (state.amount <= 0) {
      emit(state.copyWith(status: NcrSubmissionStatus.error, errorMessage: 'Enter an amount collected.'));
      return;
    }
    emit(state.copyWith(status: NcrSubmissionStatus.submitting));
    try {
      final ncrId = await repository.submitNcr(agentId: state.agentId, amount: state.amount);
      emit(state.copyWith(status: NcrSubmissionStatus.submitted, submittedNcrId: ncrId));
    } catch (e) {
      emit(state.copyWith(status: NcrSubmissionStatus.error, errorMessage: e.toString()));
    }
  }
}
