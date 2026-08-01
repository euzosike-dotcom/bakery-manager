import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../cubit/fuel_record_capture_cubit.dart';
import '../cubit/fuel_record_capture_state.dart';

class FuelRecordCaptureScreen extends StatelessWidget {
  const FuelRecordCaptureScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Log Fuel')),
      body: BlocConsumer<FuelRecordCaptureCubit, FuelRecordCaptureState>(
        listener: (context, state) {
          if (state.status == FuelRecordCaptureStatus.submitted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('Saved locally. Will sync automatically once connected.'),
                duration: Duration(seconds: 4),
              ),
            );
            Navigator.of(context).pop();
          } else if (state.status == FuelRecordCaptureStatus.error && state.errorMessage != null) {
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
                    TextFormField(
                      decoration: const InputDecoration(labelText: 'Litres'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (v) => context.read<FuelRecordCaptureCubit>().updateLitres(double.tryParse(v) ?? 0),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      decoration: const InputDecoration(labelText: 'Fuel cost'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (v) => context.read<FuelRecordCaptureCubit>().updateFuelCost(double.tryParse(v) ?? 0),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      decoration: const InputDecoration(labelText: 'Expense claim reference (optional)'),
                      onChanged: (v) => context.read<FuelRecordCaptureCubit>().updateExpenseClaimReference(v),
                    ),
                  ],
                ),
              ),
              SafeArea(
                minimum: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: state.status == FuelRecordCaptureStatus.submitting
                        ? null
                        : () => context.read<FuelRecordCaptureCubit>().submit(),
                    child: state.status == FuelRecordCaptureStatus.submitting
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Save Fuel Record'),
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
