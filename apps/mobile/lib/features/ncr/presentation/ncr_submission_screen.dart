import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../cubit/ncr_submission_cubit.dart';
import '../cubit/ncr_submission_state.dart';

class NcrSubmissionScreen extends StatelessWidget {
  const NcrSubmissionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Submit Cash Collection (NCR)')),
      body: BlocConsumer<NcrSubmissionCubit, NcrSubmissionState>(
        listener: (context, state) {
          if (state.status == NcrSubmissionStatus.submitted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text(
                  'Saved locally. Will sync automatically once connected — this does NOT restore trading '
                  'capital until finance verifies it reached the bank.',
                ),
                duration: Duration(seconds: 5),
              ),
            );
          } else if (state.status == NcrSubmissionStatus.error && state.errorMessage != null) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(state.errorMessage!), backgroundColor: Colors.red),
            );
          }
        },
        builder: (context, state) {
          return Column(
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: TextFormField(
                    decoration: const InputDecoration(labelText: 'Amount collected'),
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    onChanged: (v) => context.read<NcrSubmissionCubit>().updateAmount(double.tryParse(v) ?? 0),
                  ),
                ),
              ),
              SafeArea(
                minimum: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: state.status == NcrSubmissionStatus.submitting
                        ? null
                        : () => context.read<NcrSubmissionCubit>().submit(),
                    child: state.status == NcrSubmissionStatus.submitting
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Submit Collection'),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
