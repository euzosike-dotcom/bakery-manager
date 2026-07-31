import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../cubit/goods_receipt_capture_cubit.dart';
import '../cubit/goods_receipt_capture_state.dart';

class GoodsReceiptCaptureScreen extends StatelessWidget {
  const GoodsReceiptCaptureScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Goods Receipt')),
      body: BlocConsumer<GoodsReceiptCaptureCubit, GoodsReceiptCaptureState>(
        listener: (context, state) {
          if (state.status == GoodsReceiptCaptureStatus.submitted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('Saved locally. Will sync automatically once connected — nothing is lost offline.'),
                duration: Duration(seconds: 4),
              ),
            );
          } else if (state.status == GoodsReceiptCaptureStatus.error && state.errorMessage != null) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(state.errorMessage!), backgroundColor: Colors.red),
            );
          }
        },
        builder: (context, state) {
          if (state.status == GoodsReceiptCaptureStatus.loading) {
            return const Center(child: CircularProgressIndicator());
          }
          return Column(
            children: [
              Expanded(
                child: ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: state.lines.length,
                  separatorBuilder: (_, __) => const Divider(),
                  itemBuilder: (context, index) => _PoLineTile(line: state.lines[index]),
                ),
              ),
              SafeArea(
                minimum: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: state.status == GoodsReceiptCaptureStatus.submitting
                        ? null
                        : () => context.read<GoodsReceiptCaptureCubit>().submit(),
                    child: state.status == GoodsReceiptCaptureStatus.submitting
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Save Goods Receipt'),
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

class _PoLineTile extends StatelessWidget {
  const _PoLineTile({required this.line});
  final PoLineDraft line;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(line.description, style: Theme.of(context).textTheme.titleMedium),
          Text('Remaining: ${line.remainingQty.toStringAsFixed(2)} ${line.uom} of ${line.orderedQty.toStringAsFixed(2)} ordered'),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  decoration: const InputDecoration(labelText: 'Accepted qty'),
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (value) => context.read<GoodsReceiptCaptureCubit>().updateLineQuantities(
                        line.poLineId,
                        acceptedQty: double.tryParse(value) ?? 0,
                      ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  decoration: const InputDecoration(labelText: 'Rejected qty'),
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (value) => context.read<GoodsReceiptCaptureCubit>().updateLineQuantities(
                        line.poLineId,
                        rejectedQty: double.tryParse(value) ?? 0,
                      ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
