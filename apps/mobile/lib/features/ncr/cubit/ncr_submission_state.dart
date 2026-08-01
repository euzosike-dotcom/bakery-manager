import 'package:equatable/equatable.dart';

enum NcrSubmissionStatus { ready, submitting, submitted, error }

class NcrSubmissionState extends Equatable {
  const NcrSubmissionState({
    required this.status,
    required this.agentId,
    this.amount = 0,
    this.errorMessage,
    this.submittedNcrId,
  });

  final NcrSubmissionStatus status;
  final String agentId;
  final double amount;
  final String? errorMessage;
  final String? submittedNcrId;

  NcrSubmissionState copyWith({
    NcrSubmissionStatus? status,
    double? amount,
    String? errorMessage,
    String? submittedNcrId,
  }) =>
      NcrSubmissionState(
        status: status ?? this.status,
        agentId: agentId,
        amount: amount ?? this.amount,
        errorMessage: errorMessage,
        submittedNcrId: submittedNcrId ?? this.submittedNcrId,
      );

  @override
  List<Object?> get props => [status, agentId, amount, errorMessage, submittedNcrId];
}
