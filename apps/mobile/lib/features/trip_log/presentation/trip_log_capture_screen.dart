import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../cubit/trip_log_capture_cubit.dart';
import '../cubit/trip_log_capture_state.dart';

class TripLogCaptureScreen extends StatelessWidget {
  const TripLogCaptureScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Log Trip')),
      body: BlocConsumer<TripLogCaptureCubit, TripLogCaptureState>(
        listener: (context, state) {
          if (state.status == TripLogCaptureStatus.submitted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  'Saved locally. Will sync automatically once connected.',
                ),
                duration: const Duration(seconds: 4),
              ),
            );
            Navigator.of(context).pop();
          } else if (state.status == TripLogCaptureStatus.error && state.errorMessage != null) {
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
                    Text(
                      'Current mileage (as of last sync): ${state.currentMileageAtOpen.toStringAsFixed(2)} km',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      initialValue: state.startMileage?.toString(),
                      decoration: const InputDecoration(labelText: 'Start mileage (km)'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (v) => context.read<TripLogCaptureCubit>().updateStartMileage(double.tryParse(v) ?? 0),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      decoration: const InputDecoration(labelText: 'End mileage (km)'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (v) => context.read<TripLogCaptureCubit>().updateEndMileage(double.tryParse(v) ?? 0),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      decoration: const InputDecoration(labelText: 'Destination (optional)'),
                      onChanged: (v) => context.read<TripLogCaptureCubit>().updateDestinationNote(v),
                    ),
                  ],
                ),
              ),
              SafeArea(
                minimum: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: state.status == TripLogCaptureStatus.submitting
                        ? null
                        : () => context.read<TripLogCaptureCubit>().submit(),
                    child: state.status == TripLogCaptureStatus.submitting
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Save Trip'),
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
