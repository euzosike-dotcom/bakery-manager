import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../cubit/production_batch_capture_cubit.dart';
import '../cubit/production_batch_capture_state.dart';

class ProductionBatchCaptureScreen extends StatelessWidget {
  const ProductionBatchCaptureScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Close Production Batch')),
      body: BlocConsumer<ProductionBatchCaptureCubit, ProductionBatchCaptureState>(
        listener: (context, state) {
          if (state.status == ProductionBatchCaptureStatus.submitted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text(
                  'Saved locally. Will sync automatically once connected — yield % and ledger '
                  'posting happen on the server once synced.',
                ),
                duration: Duration(seconds: 5),
              ),
            );
          } else if (state.status == ProductionBatchCaptureStatus.error && state.errorMessage != null) {
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
                    Text('Standard batch size: ${state.plannedBatchQty.toStringAsFixed(2)} kg',
                        style: Theme.of(context).textTheme.bodyMedium),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(
                          child: TextFormField(
                            decoration: const InputDecoration(labelText: 'Actual output qty (units)'),
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            onChanged: (v) =>
                                context.read<ProductionBatchCaptureCubit>().updateOutputQty(double.tryParse(v) ?? 0),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextFormField(
                            decoration: const InputDecoration(labelText: 'Waste qty (units)'),
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            onChanged: (v) =>
                                context.read<ProductionBatchCaptureCubit>().updateWasteQty(double.tryParse(v) ?? 0),
                          ),
                        ),
                      ],
                    ),
                    const Divider(height: 32),
                    Text('Ingredient consumption', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 8),
                    ...state.lines.map((line) => _IngredientLineTile(line: line)),
                  ],
                ),
              ),
              SafeArea(
                minimum: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: state.status == ProductionBatchCaptureStatus.submitting
                        ? null
                        : () => context.read<ProductionBatchCaptureCubit>().submit(),
                    child: state.status == ProductionBatchCaptureStatus.submitting
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Close Batch'),
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

class _IngredientLineTile extends StatelessWidget {
  const _IngredientLineTile({required this.line});
  final IngredientLineDraft line;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            flex: 2,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(line.ingredientName),
                Text('Standard: ${line.plannedQty.toStringAsFixed(2)} ${line.uom}',
                    style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
          Expanded(
            child: TextFormField(
              decoration: InputDecoration(labelText: 'Actual (${line.uom})'),
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              onChanged: (v) => context
                  .read<ProductionBatchCaptureCubit>()
                  .updateIngredientActualQty(line.ingredientSkuId, double.tryParse(v) ?? 0),
            ),
          ),
        ],
      ),
    );
  }
}
