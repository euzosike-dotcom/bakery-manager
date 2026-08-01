import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/sales_order_repository.dart';
import 'sales_order_capture_state.dart';

// Hardcoded finished-good SKU for order line entry — same simplification
// as the other two modules' single-line capture screens (GRN pre-filled
// from one PO's lines, batch pre-filled from one recipe's ingredients).
// A real SKU catalog picker needs a product listing endpoint on
// sales-service, which doesn't exist yet — natural next task.
const _devOrderSkuId = '8558cee8-8acd-4d5a-a334-3b3dc4088512'; // BRD-500G, see manufacturing seed

/// Drives sales order capture. Like the other two capture cubits,
/// everything here is a local Drift write — no network call, works
/// identically online or offline.
///
/// Deliberately does NOT re-check `availableCapitalAtOpen` against the
/// entered total before allowing submit: that number is a snapshot from
/// whenever the agent list was last fetched, which could be hours stale on
/// a device that's been offline. Blocking capture on a stale client-side
/// number would be exactly the mistake SDD §2.3 scenario #7 warns against.
/// This screen shows it for context ("you're probably fine" / "this will
/// likely be blocked"), but the actual hard gate only happens once
/// SalesService.createSalesOrder runs on the server, at sync time.
class SalesOrderCaptureCubit extends Cubit<SalesOrderCaptureState> {
  SalesOrderCaptureCubit({
    required this.repository,
    required String agentId,
    required String plantId,
    required double availableCapitalAtOpen,
  }) : super(SalesOrderCaptureState(
          status: SalesOrderCaptureStatus.ready,
          agentId: agentId,
          plantId: plantId,
          availableCapitalAtOpen: availableCapitalAtOpen,
        ));

  final SalesOrderRepository repository;

  void updateOrderedQty(double qty) => emit(state.copyWith(orderedQty: qty));
  void updateUnitPrice(double price) => emit(state.copyWith(unitPrice: price));

  Future<void> submit() async {
    if (state.orderedQty <= 0 || state.unitPrice <= 0) {
      emit(state.copyWith(status: SalesOrderCaptureStatus.error, errorMessage: 'Enter a quantity and unit price.'));
      return;
    }
    emit(state.copyWith(status: SalesOrderCaptureStatus.submitting));
    try {
      final orderId = await repository.captureSalesOrder(
        agentId: state.agentId,
        plantId: state.plantId,
        lines: [OrderLineInput(skuId: _devOrderSkuId, orderedQty: state.orderedQty, unitPrice: state.unitPrice)],
      );
      emit(state.copyWith(status: SalesOrderCaptureStatus.submitted, submittedOrderId: orderId));
    } catch (e) {
      emit(state.copyWith(status: SalesOrderCaptureStatus.error, errorMessage: e.toString()));
    }
  }
}
