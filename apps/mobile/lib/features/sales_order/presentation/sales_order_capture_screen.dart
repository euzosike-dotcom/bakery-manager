import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../cubit/sales_order_capture_cubit.dart';
import '../cubit/sales_order_capture_state.dart';

class SalesOrderCaptureScreen extends StatelessWidget {
  const SalesOrderCaptureScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New Sales Order')),
      body: BlocConsumer<SalesOrderCaptureCubit, SalesOrderCaptureState>(
        listener: (context, state) {
          if (state.status == SalesOrderCaptureStatus.submitted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text(
                  'Saved locally. Will sync automatically once connected — capital eligibility is '
                  'confirmed by the server at sync time, not by this screen.',
                ),
                duration: Duration(seconds: 5),
              ),
            );
          } else if (state.status == SalesOrderCaptureStatus.error && state.errorMessage != null) {
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
                      'Available capital (as of last sync): ${state.availableCapitalAtOpen.toStringAsFixed(2)}',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'This is a snapshot for guidance only — the server re-checks live capital when this syncs.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String?>(
                      initialValue: state.customerId,
                      decoration: const InputDecoration(labelText: 'Customer (optional)'),
                      items: [
                        const DropdownMenuItem<String?>(value: null, child: Text('None')),
                        ...state.customers.map(
                          (c) => DropdownMenuItem<String?>(
                            value: c['customerId'] as String,
                            child: Text(c['customerName'] as String),
                          ),
                        ),
                      ],
                      onChanged: (v) => context.read<SalesOrderCaptureCubit>().updateCustomerId(v),
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String?>(
                      initialValue: state.skuId,
                      // Product names + prices can be longer than the field
                      // is wide (e.g. "BRD-1KG — Standard White Bread 1kg
                      // (480)") — without isExpanded the button sizes to its
                      // widest item's intrinsic width and overflows the
                      // available row width instead of truncating.
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Product'),
                      items: state.productSkus
                          .where((s) => s['skuCategory'] == 'FINISHED_GOOD')
                          .map(
                            (s) => DropdownMenuItem<String?>(
                              value: s['skuId'] as String,
                              child: Text(
                                s['listPrice'] != null
                                    ? '${s['skuCode']} — ${s['skuName']} (${s['listPrice']})'
                                    : '${s['skuCode']} — ${s['skuName']}',
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: (v) {
                        if (v != null) context.read<SalesOrderCaptureCubit>().updateSkuId(v);
                      },
                    ),
                    const SizedBox(height: 24),
                    TextFormField(
                      decoration: const InputDecoration(labelText: 'Ordered quantity (units)'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (v) =>
                          context.read<SalesOrderCaptureCubit>().updateOrderedQty(double.tryParse(v) ?? 0),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      // Re-keyed on the selected SKU so picking a new
                      // product refreshes the displayed initialValue to
                      // its listPrice pre-fill (TextFormField.initialValue
                      // is otherwise only honored on first build) — the
                      // agent can still type over it freely afterward.
                      key: ValueKey(state.skuId),
                      initialValue: state.unitPrice > 0 ? state.unitPrice.toString() : null,
                      decoration: const InputDecoration(labelText: 'Unit price'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (v) =>
                          context.read<SalesOrderCaptureCubit>().updateUnitPrice(double.tryParse(v) ?? 0),
                    ),
                    const SizedBox(height: 16),
                    Text('Order total: ${state.totalOrderValue.toStringAsFixed(2)}',
                        style: Theme.of(context).textTheme.titleMedium),
                    if (!state.looksWithinCapitalAtOpen && state.totalOrderValue > 0)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          'This looks like it may exceed available capital and could be routed for review once synced.',
                          style: TextStyle(color: Theme.of(context).colorScheme.error),
                        ),
                      ),
                  ],
                ),
              ),
              SafeArea(
                minimum: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: state.status == SalesOrderCaptureStatus.submitting
                        ? null
                        : () => context.read<SalesOrderCaptureCubit>().submit(),
                    child: state.status == SalesOrderCaptureStatus.submitting
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Save Order'),
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
