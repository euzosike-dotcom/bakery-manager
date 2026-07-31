import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:uuid/uuid.dart';

import 'core/database/database.dart';
import 'core/sync/api_client.dart';
import 'core/sync/sync_service.dart';
import 'features/goods_receipt/cubit/goods_receipt_capture_cubit.dart';
import 'features/goods_receipt/cubit/goods_receipt_capture_state.dart';
import 'features/goods_receipt/data/goods_receipt_repository.dart';
import 'features/goods_receipt/presentation/goods_receipt_capture_screen.dart';

// Dev-only defaults for the vertical slice (docs/RUNBOOK.md). Production
// wiring replaces these with real tenant discovery (subdomain/invite-code,
// SDD §1.2) and Keycloak-issued identity instead of hardcoded constants.
//
// NOTE: on an Android emulator, `localhost` refers to the emulator itself,
// not your host machine — use `10.0.2.2` instead. iOS Simulator and desktop
// builds can use `localhost` directly.
const _devTenantId = 'b17d9226-2a43-43eb-8c5e-a923637b23c5';
const _devApiBaseUrl = 'http://localhost:3001';
const _devWarehouseId = '7840f37a-13eb-4779-aa16-84bf10f7d351'; // WH-PLT1-RM, see infra/postgres/seed/dev_seed.sql

void main() {
  runApp(const MetrockApp());
}

class MetrockApp extends StatefulWidget {
  const MetrockApp({super.key});

  @override
  State<MetrockApp> createState() => _MetrockAppState();
}

class _MetrockAppState extends State<MetrockApp> {
  late final AppDatabase _db;
  late final ApiClient _api;
  late final SyncService _sync;
  final String _deviceId = const Uuid().v4();

  @override
  void initState() {
    super.initState();
    _db = AppDatabase();
    _api = ApiClient(baseUrl: _devApiBaseUrl, tenantId: _devTenantId, deviceId: _deviceId);
    _sync = SyncService(db: _db, api: _api)..startWatchingConnectivity();
  }

  @override
  void dispose() {
    _sync.dispose();
    _db.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Metrock ERP — Plant Tablet',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: _HomeScreen(db: _db, api: _api, deviceId: _deviceId, sync: _sync),
    );
  }
}

/// Minimal home screen for this vertical slice: lists open Purchase Orders
/// (fetched directly online — this master-data list is not yet on the
/// cursor-based pull path, see docs/README.md "known gaps") and lets the
/// user open GRN capture against one. A production build would route
/// through the full app shell/navigation instead.
class _HomeScreen extends StatefulWidget {
  const _HomeScreen({required this.db, required this.api, required this.deviceId, required this.sync});
  final AppDatabase db;
  final ApiClient api;
  final String deviceId;
  final SyncService sync;

  @override
  State<_HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<_HomeScreen> {
  List<Map<String, dynamic>>? _purchaseOrders;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _loadPurchaseOrders();
  }

  Future<void> _loadPurchaseOrders() async {
    try {
      final pos = await widget.api.fetchPurchaseOrders();
      setState(() => _purchaseOrders = pos);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Open Purchase Orders'),
        actions: [
          IconButton(icon: const Icon(Icons.sync), onPressed: widget.sync.syncNow, tooltip: 'Sync now'),
        ],
      ),
      body: _loadError != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)))
          : _purchaseOrders == null
              ? const Center(child: CircularProgressIndicator())
              : ListView.builder(
                  itemCount: _purchaseOrders!.length,
                  itemBuilder: (context, index) {
                    final po = _purchaseOrders![index];
                    return ListTile(
                      title: Text(po['poNumber'] as String),
                      subtitle: Text('${po['poStatus']} · ${(po['lines'] as List).length} line(s)'),
                      onTap: () => _openCapture(po),
                    );
                  },
                ),
    );
  }

  void _openCapture(Map<String, dynamic> po) {
    final lines = (po['lines'] as List).cast<Map<String, dynamic>>();
    final drafts = lines
        .map((l) => PoLineDraft(
              poLineId: l['poLineId'] as String,
              description: l['skuDescription'] as String,
              orderedQty: double.parse(l['orderedQty'].toString()),
              receivedQtySoFar: double.parse(l['receivedQty'].toString()),
              uom: l['uom'] as String,
              unitCost: double.parse(l['unitCost'].toString()),
            ))
        .toList();

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => BlocProvider(
          create: (_) => GoodsReceiptCaptureCubit(
            repository: GoodsReceiptRepository(db: widget.db, deviceId: widget.deviceId),
            poId: po['poId'] as String,
            warehouseId: _devWarehouseId,
            initialLines: drafts,
          ),
          child: const GoodsReceiptCaptureScreen(),
        ),
      ),
    ).then((_) => widget.sync.syncNow());
  }
}
