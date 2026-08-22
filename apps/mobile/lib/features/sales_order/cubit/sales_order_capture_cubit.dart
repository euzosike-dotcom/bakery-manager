import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/sales_order_repository.dart';
import 'sales_order_capture_state.dart';

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
    List<Map<String, dynamic>> customers = const [],
    List<Map<String, dynamic>> productSkus = const [],
  }) : super(SalesOrderCaptureState(
          status: SalesOrderCaptureStatus.ready,
          agentId: agentId,
          plantId: plantId,
          availableCapitalAtOpen: availableCapitalAtOpen,
          customers: customers,
          productSkus: productSkus,
        ));

  final SalesOrderRepository repository;

  void updateOrderedQty(double qty) => emit(state.copyWith(orderedQty: qty));
  void updateUnitPrice(double price) => emit(state.copyWith(unitPrice: price));
  void updateCustomerId(String? customerId) =>
      emit(state.copyWith(customerId: customerId, clearCustomerId: customerId == null));

  /// Selecting a SKU pre-fills unit price from its catalog `listPrice`
  /// when one is set — a suggested starting point, not a constraint;
  /// updateUnitPrice can still freely override it afterward (agents
  /// negotiate real prices in the field, same as before this picker
  /// existed — see order_lines.unit_price's own design, which was always
  /// a free per-line field, not derived).
  void updateSkuId(String skuId) {
    final sku = state.productSkus.firstWhere(
      (s) => s['skuId'] == skuId,
      orElse: () => const <String, dynamic>{},
    );
    final listPrice = sku['listPrice'];
    emit(state.copyWith(
      skuId: skuId,
      unitPrice: listPrice != null ? double.tryParse(listPrice.toString()) ?? state.unitPrice : state.unitPrice,
    ));
  }

  Future<void> submit() async {
    if (state.skuId == null) {
      emit(state.copyWith(status: SalesOrderCaptureStatus.error, errorMessage: 'Pick a product.'));
      return;
    }
    if (state.orderedQty <= 0 || state.unitPrice <= 0) {
      emit(state.copyWith(status: SalesOrderCaptureStatus.error, errorMessage: 'Enter a quantity and unit price.'));
      return;
    }
    emit(state.copyWith(status: SalesOrderCaptureStatus.submitting));
    try {
      final orderId = await repository.captureSalesOrder(
        agentId: state.agentId,
        plantId: state.plantId,
        customerId: state.customerId,
        lines: [OrderLineInput(skuId: state.skuId!, orderedQty: state.orderedQty, unitPrice: state.unitPrice)],
      );
      emit(state.copyWith(status: SalesOrderCaptureStatus.submitted, submittedOrderId: orderId));
    } catch (e) {
      emit(state.copyWith(status: SalesOrderCaptureStatus.error, errorMessage: e.toString()));
    }
  }
}
