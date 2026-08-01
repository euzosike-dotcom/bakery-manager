import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../cubit/activity_capture_cubit.dart';
import '../cubit/activity_capture_state.dart';

const _activityTypes = ['CALL', 'VISIT', 'EMAIL', 'NOTE'];

class ActivityCaptureScreen extends StatelessWidget {
  const ActivityCaptureScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Log Activity')),
      body: BlocConsumer<ActivityCaptureCubit, ActivityCaptureState>(
        listener: (context, state) {
          if (state.status == ActivityCaptureStatus.submitted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Saved locally. Will sync automatically once connected.')),
            );
            Navigator.of(context).pop();
          } else if (state.status == ActivityCaptureStatus.error && state.errorMessage != null) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(state.errorMessage!), backgroundColor: Colors.red),
            );
          }
        },
        builder: (context, state) {
          return Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    DropdownButtonFormField<String>(
                      initialValue: state.activityType,
                      decoration: const InputDecoration(labelText: 'Activity type'),
                      items: _activityTypes.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
                      onChanged: (v) {
                        if (v != null) context.read<ActivityCaptureCubit>().updateActivityType(v);
                      },
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      decoration: const InputDecoration(labelText: 'Notes'),
                      maxLines: 4,
                      onChanged: (v) => context.read<ActivityCaptureCubit>().updateNotes(v),
                    ),
                  ],
                ),
              ),
              SafeArea(
                minimum: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: state.status == ActivityCaptureStatus.submitting
                        ? null
                        : () => context.read<ActivityCaptureCubit>().submit(),
                    child: state.status == ActivityCaptureStatus.submitting
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Save Activity'),
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
