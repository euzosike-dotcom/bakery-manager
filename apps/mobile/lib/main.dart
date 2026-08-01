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
import 'features/production_batch/cubit/production_batch_capture_cubit.dart';
import 'features/production_batch/cubit/production_batch_capture_state.dart';
import 'features/production_batch/data/production_batch_repository.dart';
import 'features/production_batch/presentation/production_batch_capture_screen.dart';
import 'features/sales_order/cubit/sales_order_capture_cubit.dart';
import 'features/sales_order/data/sales_order_repository.dart';
import 'features/sales_order/presentation/sales_order_capture_screen.dart';
import 'features/ncr/cubit/ncr_submission_cubit.dart';
import 'features/ncr/data/ncr_repository.dart';
import 'features/ncr/presentation/ncr_submission_screen.dart';

// Dev-only defaults for the vertical slice (docs/RUNBOOK.md). Production
// wiring replaces these with real tenant discovery (subdomain/invite-code,
// SDD §1.2) and Keycloak-issued identity instead of hardcoded constants.
//
// NOTE: on an Android emulator, `localhost` refers to the emulator itself,
// not your host machine — use `10.0.2.2` instead. iOS Simulator and desktop
// builds can use `localhost` directly.
const _devTenantId = 'b17d9226-2a43-43eb-8c5e-a923637b23c5';
const _devProcurementBaseUrl = 'http://localhost:3001';
const _devManufacturingBaseUrl = 'http://localhost:3002';
const _devSalesBaseUrl = 'http://localhost:3003';
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
  late final ApiClient _procurementApi;
  late final ApiClient _manufacturingApi;
  late final ApiClient _salesApi;
  late final SyncService _sync;
  final String _deviceId = const Uuid().v4();

  @override
  void initState() {
    super.initState();
    _db = AppDatabase();
    _procurementApi = ApiClient(baseUrl: _devProcurementBaseUrl, tenantId: _devTenantId, deviceId: _deviceId);
    _manufacturingApi = ApiClient(baseUrl: _devManufacturingBaseUrl, tenantId: _devTenantId, deviceId: _deviceId);
    _salesApi = ApiClient(baseUrl: _devSalesBaseUrl, tenantId: _devTenantId, deviceId: _deviceId);
    _sync = SyncService(db: _db, apiClients: {
      SyncModule.procurement: _procurementApi,
      SyncModule.manufacturing: _manufacturingApi,
      SyncModule.sales: _salesApi,
    })
      ..startWatchingConnectivity();
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
      home: _HomeScreen(
        db: _db,
        procurementApi: _procurementApi,
        manufacturingApi: _manufacturingApi,
        salesApi: _salesApi,
        deviceId: _deviceId,
        sync: _sync,
      ),
    );
  }
}

/// Minimal tabbed home screen for this vertical slice: Purchase Orders (GRN
/// capture, procurement-service) and Recipes (batch close capture,
/// manufacturing-service). Both master-data lists are fetched directly
/// online rather than through the cursor-based pull path — see README
/// "Known gaps". A production build would route through the full app
/// shell/navigation instead of this quick tab bar.
class _HomeScreen extends StatelessWidget {
  const _HomeScreen({
    required this.db,
    required this.procurementApi,
    required this.manufacturingApi,
    required this.salesApi,
    required this.deviceId,
    required this.sync,
  });

  final AppDatabase db;
  final ApiClient procurementApi;
  final ApiClient manufacturingApi;
  final ApiClient salesApi;
  final String deviceId;
  final SyncService sync;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Metrock ERP'),
          bottom: const TabBar(tabs: [Tab(text: 'Purchase Orders'), Tab(text: 'Recipes'), Tab(text: 'Agents')]),
          actions: [
            IconButton(icon: const Icon(Icons.sync), onPressed: sync.syncNow, tooltip: 'Sync now'),
          ],
        ),
        body: TabBarView(
          children: [
            _PurchaseOrdersTab(db: db, api: procurementApi, deviceId: deviceId, sync: sync),
            _RecipesTab(db: db, api: manufacturingApi, deviceId: deviceId, sync: sync),
            _AgentsTab(db: db, api: salesApi, deviceId: deviceId, sync: sync),
          ],
        ),
      ),
    );
  }
}

class _PurchaseOrdersTab extends StatefulWidget {
  const _PurchaseOrdersTab({required this.db, required this.api, required this.deviceId, required this.sync});
  final AppDatabase db;
  final ApiClient api;
  final String deviceId;
  final SyncService sync;

  @override
  State<_PurchaseOrdersTab> createState() => _PurchaseOrdersTabState();
}

class _PurchaseOrdersTabState extends State<_PurchaseOrdersTab> {
  List<Map<String, dynamic>>? _purchaseOrders;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final pos = await widget.api.fetchPurchaseOrders();
      setState(() => _purchaseOrders = pos);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_purchaseOrders == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount: _purchaseOrders!.length,
      itemBuilder: (context, index) {
        final po = _purchaseOrders![index];
        return ListTile(
          title: Text(po['poNumber'] as String),
          subtitle: Text('${po['poStatus']} · ${(po['lines'] as List).length} line(s)'),
          onTap: () => _openCapture(po),
        );
      },
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

    Navigator.of(context)
        .push(
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
        )
        .then((_) => widget.sync.syncNow());
  }
}

class _RecipesTab extends StatefulWidget {
  const _RecipesTab({required this.db, required this.api, required this.deviceId, required this.sync});
  final AppDatabase db;
  final ApiClient api;
  final String deviceId;
  final SyncService sync;

  @override
  State<_RecipesTab> createState() => _RecipesTabState();
}

class _RecipesTabState extends State<_RecipesTab> {
  List<Map<String, dynamic>>? _recipes;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final recipes = await widget.api.fetchRecipes();
      setState(() => _recipes = recipes);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_recipes == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount: _recipes!.length,
      itemBuilder: (context, index) {
        final recipe = _recipes![index];
        final versions = (recipe['versions'] as List).cast<Map<String, dynamic>>();
        final activeVersion = versions.firstWhere(
          (v) => v['recipeVersionId'] == recipe['currentActiveVersionId'],
          orElse: () => versions.first,
        );
        return ListTile(
          title: Text(recipe['recipeName'] as String),
          subtitle: Text(
            'v${activeVersion['versionNo']} · ${activeVersion['approvalStatus']} · '
            'standard cost ${activeVersion['standardCost']}',
          ),
          onTap: () => _openCapture(recipe, activeVersion),
        );
      },
    );
  }

  void _openCapture(Map<String, dynamic> recipe, Map<String, dynamic> recipeVersion) {
    final ingredients = (recipeVersion['ingredients'] as List).cast<Map<String, dynamic>>();
    final initialLines = ingredients
        .map((i) => IngredientLineDraft(
              ingredientSkuId: i['ingredientSkuId'] as String,
              ingredientName: (i['ingredientSkuId'] as String).substring(0, 8), // no SKU-name lookup in this slice
              plannedQty: double.parse(i['quantityPerBatch'].toString()),
              uom: i['unitOfMeasure'] as String,
            ))
        .toList();

    Navigator.of(context)
        .push(
          MaterialPageRoute(
            builder: (_) => BlocProvider(
              create: (_) => ProductionBatchCaptureCubit(
                repository: ProductionBatchRepository(db: widget.db, deviceId: widget.deviceId),
                plantId: _devPlantIdFallback,
                skuId: recipe['skuId'] as String,
                recipeVersionId: recipeVersion['recipeVersionId'] as String,
                plannedBatchQty: double.parse(recipeVersion['standardBatchSize'].toString()),
                initialLines: initialLines,
              ),
              child: const ProductionBatchCaptureScreen(),
            ),
          ),
        )
        .then((_) => widget.sync.syncNow());
  }
}

// Recipes aren't plant-specific in this slice's seed data (product_skus/
// recipes have no plant_id column — a recipe is tenant-wide, batches are
// what's plant-specific) — see infra/postgres/migrations/008_manufacturing.sql.
// Falling back to the seeded PLT-1 rather than adding a plant-picker UI,
// which isn't needed to prove the pattern. Also used as the sales order's
// plant_id for the same reason.
const _devPlantIdFallback = 'aba294c3-c28c-43a9-a465-67ced442a487';

class _AgentsTab extends StatefulWidget {
  const _AgentsTab({required this.db, required this.api, required this.deviceId, required this.sync});
  final AppDatabase db;
  final ApiClient api;
  final String deviceId;
  final SyncService sync;

  @override
  State<_AgentsTab> createState() => _AgentsTabState();
}

class _AgentsTabState extends State<_AgentsTab> {
  List<Map<String, dynamic>>? _agents;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final agents = await widget.api.fetchAgents();
      setState(() => _agents = agents);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_agents == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount: _agents!.length,
      itemBuilder: (context, index) {
        final agent = _agents![index];
        return ListTile(
          title: Text('${agent['agentCode']} — ${agent['agentName']}'),
          subtitle: Text('Available capital: ${agent['availableCapital']}'),
          onTap: () => _openAgentDetail(agent),
        );
      },
    );
  }

  void _openAgentDetail(Map<String, dynamic> agent) {
    Navigator.of(context)
        .push(
          MaterialPageRoute(
            builder: (_) => _AgentDetailScreen(db: widget.db, deviceId: widget.deviceId, agent: agent),
          ),
        )
        .then((_) => widget.sync.syncNow());
  }
}

/// Landing point for the two agent-scoped actions this slice implements —
/// mirrors how a real app would likely group "things you can do for this
/// agent" rather than exposing New Order / Submit NCR as top-level tabs.
class _AgentDetailScreen extends StatelessWidget {
  const _AgentDetailScreen({required this.db, required this.deviceId, required this.agent});
  final AppDatabase db;
  final String deviceId;
  final Map<String, dynamic> agent;

  @override
  Widget build(BuildContext context) {
    final availableCapital = double.parse(agent['availableCapital'].toString());
    return Scaffold(
      appBar: AppBar(title: Text(agent['agentName'] as String)),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Available capital: ${availableCapital.toStringAsFixed(2)}',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => BlocProvider(
                    create: (_) => SalesOrderCaptureCubit(
                      repository: SalesOrderRepository(db: db, deviceId: deviceId),
                      agentId: agent['agentId'] as String,
                      plantId: _devPlantIdFallback,
                      availableCapitalAtOpen: availableCapital,
                    ),
                    child: const SalesOrderCaptureScreen(),
                  ),
                ),
              ),
              child: const Text('New Sales Order'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => BlocProvider(
                    create: (_) => NcrSubmissionCubit(
                      repository: NcrRepository(db: db, deviceId: deviceId),
                      agentId: agent['agentId'] as String,
                    ),
                    child: const NcrSubmissionScreen(),
                  ),
                ),
              ),
              child: const Text('Submit Cash Collection (NCR)'),
            ),
          ],
        ),
      ),
    );
  }
}
