import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:uuid/uuid.dart';

import 'core/auth/auth_client.dart';
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
import 'features/activity/cubit/activity_capture_cubit.dart';
import 'features/activity/data/activity_repository.dart';
import 'features/activity/presentation/activity_capture_screen.dart';
import 'features/trip_log/cubit/trip_log_capture_cubit.dart';
import 'features/trip_log/data/trip_log_repository.dart';
import 'features/trip_log/presentation/trip_log_capture_screen.dart';
import 'features/fuel_record/cubit/fuel_record_capture_cubit.dart';
import 'features/fuel_record/data/fuel_record_repository.dart';
import 'features/fuel_record/presentation/fuel_record_capture_screen.dart';
import 'features/attendance/data/attendance_repository.dart';

// Dev-only defaults for the vertical slice (docs/RUNBOOK.md). Production
// wiring replaces these with real tenant discovery (subdomain/invite-code,
// SDD §1.2) — `tenant_id` itself no longer needs a client-side constant at
// all as of Phase 3 of the Keycloak retrofit: it lives inside the access
// token as a claim and every backend service derives it server-side.
//
// NOTE: on an Android emulator, `localhost` refers to the emulator itself,
// not your host machine — use `10.0.2.2` instead. iOS Simulator and desktop
// builds can use `localhost` directly.
// TLS termination Part B (docs/RUNBOOK.md) — both the gateway and Keycloak
// now speak HTTPS on their :8443/:8543 listeners with a self-signed dev
// cert (infra/certs/generate-dev-certs.sh). ApiClient's HttpClient below is
// pinned to trust exactly that cert; the Keycloak login flow instead relies
// on the iOS Simulator's own keychain trusting it (xcrun simctl keychain
// ... add-root-cert — a one-time per-simulator setup step, see RUNBOOK),
// since AppAuth drives a native system browser Claude/ApiClient's
// SecurityContext has no influence over.
const _devKeycloakIssuer = 'https://localhost:8543/realms/metrock';
const _devKeycloakClientId = 'metrock-mobile';
const _devKeycloakRedirectUrl = 'com.metrock.metrockMobile:/oauth2redirect';
// One entry point through the nginx API Gateway (infra/nginx/nginx.conf,
// infra/docker-compose.yml's `gateway` service) instead of 7 separate
// hardcoded per-service ports — each ApiClient below gets a path-prefixed
// base URL (e.g. $_devGatewayBaseUrl/procurement) instead of its own port.
// A transparent proxy: the Bearer token and every other header pass
// through untouched, so nothing about ApiClient/AuthClient itself changed.
const _devGatewayBaseUrl = 'https://localhost:8443';
const _devWarehouseId = '7840f37a-13eb-4779-aa16-84bf10f7d351'; // WH-PLT1-RM, see infra/postgres/seed/dev_seed.sql

/// Builds an `http.Client` that trusts exactly the bundled dev cert
/// (assets/certs/dev-cert.pem, copied by infra/certs/generate-dev-certs.sh)
/// — deliberately NOT a blanket `badCertificateCallback` that accepts
/// anything, which would silently swallow a real MITM in dev too. Every
/// `ApiClient` below shares this one instance.
Future<http.Client> _createPinnedHttpClient() async {
  final certBytes = (await rootBundle.load('assets/certs/dev-cert.pem')).buffer.asUint8List();
  final context = SecurityContext(withTrustedRoots: false)..setTrustedCertificatesBytes(certBytes);
  return IOClient(HttpClient(context: context));
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final httpClient = await _createPinnedHttpClient();
  runApp(MetrockApp(httpClient: httpClient));
}

class MetrockApp extends StatefulWidget {
  const MetrockApp({super.key, required this.httpClient});

  final http.Client httpClient;

  @override
  State<MetrockApp> createState() => _MetrockAppState();
}

class _MetrockAppState extends State<MetrockApp> {
  late final AppDatabase _db;
  late final AuthClient _auth;
  late final ApiClient _procurementApi;
  late final ApiClient _manufacturingApi;
  late final ApiClient _salesApi;
  late final ApiClient _crmApi;
  late final ApiClient _fleetApi;
  late final ApiClient _hrApi;
  late final ApiClient _governanceApi;
  // Accounting has no SyncModule entry either (same reasoning as
  // Governance below) — this app's first Accounting screen (the
  // Approvals tab) is a read-and-decide action, not an offline capture
  // flow, so it doesn't need one.
  late final ApiClient _accountingApi;
  late final SyncService _sync;
  final String _deviceId = const Uuid().v4();

  // null while `restoreSession()` is still running at app start — neither
  // the login screen nor the tab UI should flash briefly before that
  // resolves.
  bool? _isLoggedIn;

  @override
  void initState() {
    super.initState();
    _db = AppDatabase();
    _auth = AuthClient(
      issuer: _devKeycloakIssuer,
      clientId: _devKeycloakClientId,
      redirectUrl: _devKeycloakRedirectUrl,
    );
    _procurementApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/procurement', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    _manufacturingApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/manufacturing', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    _salesApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/sales', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    _crmApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/crm', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    _fleetApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/fleet', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    _hrApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/hr', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    _governanceApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/governance', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    _accountingApi = ApiClient(baseUrl: '$_devGatewayBaseUrl/accounting', deviceId: _deviceId, auth: _auth, httpClient: widget.httpClient);
    // Governance has no SyncModule entry at all — master data is
    // pull-only per SDD §3.A, never edited offline, so there's nothing
    // for the sync engine to push/pull for this module.
    _sync = SyncService(db: _db, apiClients: {
      SyncModule.procurement: _procurementApi,
      SyncModule.manufacturing: _manufacturingApi,
      SyncModule.sales: _salesApi,
      SyncModule.crm: _crmApi,
      SyncModule.fleet: _fleetApi,
      SyncModule.hr: _hrApi,
    });

    // Deliberately NOT started here — every ApiClient call now goes
    // through AuthClient.getValidAccessToken(), which throws if nobody's
    // signed in yet, and connectivity can regain before restoreSession()
    // even resolves. Started/stopped alongside the auth-state listener
    // below instead, so a sync attempt can never fire without a session
    // backing it.
    _auth.authStateChanges.listen((loggedIn) {
      if (loggedIn) {
        _sync.startWatchingConnectivity();
      } else {
        _sync.stopWatchingConnectivity();
      }
      if (mounted) setState(() => _isLoggedIn = loggedIn);
    });
    _auth.restoreSession();
  }

  @override
  void dispose() {
    _sync.dispose();
    _db.close();
    _auth.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final loggedIn = _isLoggedIn;
    return MaterialApp(
      title: 'Metrock ERP — Plant Tablet',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: loggedIn == null
          ? const _SplashScreen()
          : loggedIn
              ? _HomeScreen(
                  db: _db,
                  procurementApi: _procurementApi,
                  manufacturingApi: _manufacturingApi,
                  salesApi: _salesApi,
                  crmApi: _crmApi,
                  fleetApi: _fleetApi,
                  hrApi: _hrApi,
                  governanceApi: _governanceApi,
                  accountingApi: _accountingApi,
                  deviceId: _deviceId,
                  sync: _sync,
                  onLogout: _auth.logout,
                )
              : _LoginScreen(auth: _auth),
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
    required this.crmApi,
    required this.fleetApi,
    required this.hrApi,
    required this.governanceApi,
    required this.accountingApi,
    required this.deviceId,
    required this.sync,
    required this.onLogout,
  });

  final AppDatabase db;
  final ApiClient procurementApi;
  final ApiClient manufacturingApi;
  final ApiClient salesApi;
  final ApiClient crmApi;
  final ApiClient fleetApi;
  final ApiClient hrApi;
  final ApiClient governanceApi;
  final ApiClient accountingApi;
  final String deviceId;
  final SyncService sync;
  final Future<void> Function() onLogout;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 8,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Metrock ERP'),
          bottom: const TabBar(
            isScrollable: true,
            tabs: [
              Tab(text: 'Purchase Orders'),
              Tab(text: 'Recipes'),
              Tab(text: 'Agents'),
              Tab(text: 'Customers'),
              Tab(text: 'Vehicles'),
              Tab(text: 'Employees'),
              Tab(text: 'Users'),
              Tab(text: 'Approvals'),
            ],
          ),
          actions: [
            IconButton(icon: const Icon(Icons.sync), onPressed: sync.syncNow, tooltip: 'Sync now'),
            IconButton(icon: const Icon(Icons.logout), onPressed: onLogout, tooltip: 'Sign out'),
          ],
        ),
        body: TabBarView(
          children: [
            _PurchaseOrdersTab(db: db, api: procurementApi, deviceId: deviceId, sync: sync),
            _RecipesTab(db: db, api: manufacturingApi, deviceId: deviceId, sync: sync),
            _AgentsTab(
              db: db,
              api: salesApi,
              crmApi: crmApi,
              manufacturingApi: manufacturingApi,
              deviceId: deviceId,
              sync: sync,
            ),
            _CustomersTab(db: db, api: crmApi, deviceId: deviceId, sync: sync),
            _VehiclesTab(db: db, api: fleetApi, deviceId: deviceId, sync: sync),
            _EmployeesTab(db: db, api: hrApi, deviceId: deviceId, sync: sync),
            _UsersTab(api: governanceApi),
            _ApprovalsTab(
              procurementApi: procurementApi,
              accountingApi: accountingApi,
              fleetApi: fleetApi,
              manufacturingApi: manufacturingApi,
            ),
          ],
        ),
      ),
    );
  }
}

/// Shown briefly at app start while `AuthClient.restoreSession()` checks
/// secure storage for a previous session — avoids flashing the login
/// screen for an instant before a valid stored session is found.
class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}

/// Real Keycloak login (Phase 3 of the Keycloak retrofit, docs/RUNBOOK.md)
/// — launches the system browser for Authorization Code + PKCE via
/// `AuthClient.login()`. `_MetrockAppState`'s `authStateChanges` listener
/// is what actually swaps this screen out for `_HomeScreen`, not
/// anything in here — a successful `login()` call and the eventual
/// `true` on that stream happen together, but only the latter drives
/// navigation, so this screen only needs to show its own loading/error
/// state while the browser round-trip is in flight.
class _LoginScreen extends StatefulWidget {
  const _LoginScreen({required this.auth});
  final AuthClient auth;

  @override
  State<_LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<_LoginScreen> {
  bool _signingIn = false;
  String? _error;

  Future<void> _signIn() async {
    setState(() {
      _signingIn = true;
      _error = null;
    });
    try {
      await widget.auth.login();
    } catch (e) {
      if (mounted) setState(() => _error = 'Sign-in failed: $e');
    } finally {
      if (mounted) setState(() => _signingIn = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.factory, size: 64),
              const SizedBox(height: 16),
              const Text('Metrock ERP', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              const Text('Sign in with your Metrock account to continue.'),
              const SizedBox(height: 24),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ),
              FilledButton.icon(
                onPressed: _signingIn ? null : _signIn,
                icon: _signingIn
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.login),
                label: Text(_signingIn ? 'Signing in…' : 'Sign In'),
              ),
            ],
          ),
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
  const _AgentsTab({
    required this.db,
    required this.api,
    required this.crmApi,
    required this.manufacturingApi,
    required this.deviceId,
    required this.sync,
  });
  final AppDatabase db;
  final ApiClient api;
  final ApiClient crmApi;
  final ApiClient manufacturingApi;
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
            builder: (_) => _AgentDetailScreen(
              db: widget.db,
              crmApi: widget.crmApi,
              manufacturingApi: widget.manufacturingApi,
              deviceId: widget.deviceId,
              agent: agent,
            ),
          ),
        )
        .then((_) => widget.sync.syncNow());
  }
}

/// Landing point for the two agent-scoped actions this slice implements —
/// mirrors how a real app would likely group "things you can do for this
/// agent" rather than exposing New Order / Submit NCR as top-level tabs.
/// Fetches the customer list once (same online-only simplification as
/// every other master-data list in this app) so New Sales Order can offer
/// an optional customer picker (CRM slice) without a fourth `ApiClient`
/// being threaded any deeper than this screen needs it.
class _AgentDetailScreen extends StatefulWidget {
  const _AgentDetailScreen({
    required this.db,
    required this.crmApi,
    required this.manufacturingApi,
    required this.deviceId,
    required this.agent,
  });
  final AppDatabase db;
  final ApiClient crmApi;
  final ApiClient manufacturingApi;
  final String deviceId;
  final Map<String, dynamic> agent;

  @override
  State<_AgentDetailScreen> createState() => _AgentDetailScreenState();
}

class _AgentDetailScreenState extends State<_AgentDetailScreen> {
  List<Map<String, dynamic>> _customers = [];
  List<Map<String, dynamic>> _productSkus = [];

  @override
  void initState() {
    super.initState();
    widget.crmApi.fetchCustomers().then((c) => setState(() => _customers = c)).catchError((_) {
      // Offline at open, or crm-service unreachable — New Sales Order still
      // works, just with an empty customer picker (defaults to "None").
    });
    widget.manufacturingApi.fetchProductSkus().then((s) => setState(() => _productSkus = s)).catchError((_) {
      // Offline at open, or manufacturing-service unreachable — New Sales
      // Order still opens, just with an empty product picker; submit()
      // requires a SKU to be picked, so the agent simply can't submit
      // until connectivity returns, same tradeoff as every other
      // online-only master-data list in this app.
    });
  }

  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;
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
                      repository: SalesOrderRepository(db: widget.db, deviceId: widget.deviceId),
                      agentId: agent['agentId'] as String,
                      plantId: _devPlantIdFallback,
                      availableCapitalAtOpen: availableCapital,
                      customers: _customers,
                      productSkus: _productSkus,
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
                      repository: NcrRepository(db: widget.db, deviceId: widget.deviceId),
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

/// Fourth tab (CRM slice): Customers list, fetched directly online — same
/// simplification as Purchase Orders/Recipes/Agents (see ActivitiesLocal's
/// doc comment). Tapping a customer opens a detail screen with the one
/// offline-capturable CRM action: logging an Activity.
class _CustomersTab extends StatefulWidget {
  const _CustomersTab({required this.db, required this.api, required this.deviceId, required this.sync});
  final AppDatabase db;
  final ApiClient api;
  final String deviceId;
  final SyncService sync;

  @override
  State<_CustomersTab> createState() => _CustomersTabState();
}

class _CustomersTabState extends State<_CustomersTab> {
  List<Map<String, dynamic>>? _customers;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final customers = await widget.api.fetchCustomers();
      setState(() => _customers = customers);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_customers == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount: _customers!.length,
      itemBuilder: (context, index) {
        final customer = _customers![index];
        return ListTile(
          title: Text(customer['customerName'] as String),
          subtitle: Text('${customer['customerCode']} · ${customer['customerStatus']}'),
          onTap: () => _openCustomerDetail(customer),
        );
      },
    );
  }

  void _openCustomerDetail(Map<String, dynamic> customer) {
    Navigator.of(context)
        .push(
          MaterialPageRoute(
            builder: (_) => _CustomerDetailScreen(db: widget.db, deviceId: widget.deviceId, customer: customer),
          ),
        )
        .then((_) => widget.sync.syncNow());
  }
}

/// Landing point for the one CRM action this slice implements: logging an
/// Activity against a customer. Mirrors _AgentDetailScreen's structure.
class _CustomerDetailScreen extends StatelessWidget {
  const _CustomerDetailScreen({required this.db, required this.deviceId, required this.customer});
  final AppDatabase db;
  final String deviceId;
  final Map<String, dynamic> customer;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(customer['customerName'] as String)),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('${customer['customerCode']} · ${customer['customerType']} · ${customer['customerStatus']}',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => BlocProvider(
                    create: (_) => ActivityCaptureCubit(
                      repository: ActivityRepository(db: db, deviceId: deviceId),
                      customerId: customer['customerId'] as String,
                    ),
                    child: const ActivityCaptureScreen(),
                  ),
                ),
              ),
              child: const Text('Log Activity'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Fifth tab (Fleet slice): Vehicles list, fetched directly online — same
/// simplification as every other master-data list in this app (see
/// TripLogsLocal/FuelRecordsLocal's doc comments). Tapping a vehicle opens
/// a detail screen with the two offline-capturable Fleet actions: Log
/// Trip and Log Fuel.
class _VehiclesTab extends StatefulWidget {
  const _VehiclesTab({required this.db, required this.api, required this.deviceId, required this.sync});
  final AppDatabase db;
  final ApiClient api;
  final String deviceId;
  final SyncService sync;

  @override
  State<_VehiclesTab> createState() => _VehiclesTabState();
}

class _VehiclesTabState extends State<_VehiclesTab> {
  List<Map<String, dynamic>>? _vehicles;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final vehicles = await widget.api.fetchVehicles();
      setState(() => _vehicles = vehicles);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_vehicles == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount: _vehicles!.length,
      itemBuilder: (context, index) {
        final vehicle = _vehicles![index];
        final driver = vehicle['assignedDriver'] as Map<String, dynamic>?;
        return ListTile(
          title: Text('${vehicle['vehicleCode']} — ${vehicle['plateNumber']}'),
          subtitle: Text(
            '${vehicle['currentMileage']} / ${vehicle['serviceThresholdKm']} km'
            '${driver != null ? " · ${driver['driverName']}" : ""}',
          ),
          onTap: () => _openVehicleDetail(vehicle),
        );
      },
    );
  }

  void _openVehicleDetail(Map<String, dynamic> vehicle) {
    Navigator.of(context)
        .push(
          MaterialPageRoute(
            builder: (_) => _VehicleDetailScreen(db: widget.db, deviceId: widget.deviceId, vehicle: vehicle),
          ),
        )
        .then((_) => widget.sync.syncNow());
  }
}

/// Landing point for the two vehicle-scoped actions this slice
/// implements — mirrors _AgentDetailScreen/_CustomerDetailScreen's
/// structure. Driver is taken from the vehicle's `assignedDriverId`
/// rather than a driver picker — same "hardcode the one seeded option"
/// simplification as the Sales module's hardcoded order SKU; a real
/// dispatch app would let a trip be logged against any available driver.
class _VehicleDetailScreen extends StatelessWidget {
  const _VehicleDetailScreen({required this.db, required this.deviceId, required this.vehicle});
  final AppDatabase db;
  final String deviceId;
  final Map<String, dynamic> vehicle;

  @override
  Widget build(BuildContext context) {
    final currentMileage = double.parse(vehicle['currentMileage'].toString());
    final assignedDriverId = vehicle['assignedDriverId'] as String?;
    return Scaffold(
      appBar: AppBar(title: Text(vehicle['vehicleCode'] as String)),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '${vehicle['plateNumber']} · ${vehicle['vehicleClass']}\n'
              'Mileage: ${currentMileage.toStringAsFixed(2)} / ${vehicle['serviceThresholdKm']} km',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: assignedDriverId == null
                  ? null
                  : () => Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => BlocProvider(
                            create: (_) => TripLogCaptureCubit(
                              repository: TripLogRepository(db: db, deviceId: deviceId),
                              vehicleId: vehicle['vehicleId'] as String,
                              driverId: assignedDriverId,
                              currentMileageAtOpen: currentMileage,
                            ),
                            child: const TripLogCaptureScreen(),
                          ),
                        ),
                      ),
              child: const Text('Log Trip'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => BlocProvider(
                    create: (_) => FuelRecordCaptureCubit(
                      repository: FuelRecordRepository(db: db, deviceId: deviceId),
                      vehicleId: vehicle['vehicleId'] as String,
                    ),
                    child: const FuelRecordCaptureScreen(),
                  ),
                ),
              ),
              child: const Text('Log Fuel'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Sixth tab (HR/Payroll slice): Employees list, fetched directly online —
/// same simplification as every other master-data list in this app.
/// Tapping an employee opens a detail screen with the one offline-
/// capturable HR action: clocking in/out.
class _EmployeesTab extends StatefulWidget {
  const _EmployeesTab({required this.db, required this.api, required this.deviceId, required this.sync});
  final AppDatabase db;
  final ApiClient api;
  final String deviceId;
  final SyncService sync;

  @override
  State<_EmployeesTab> createState() => _EmployeesTabState();
}

class _EmployeesTabState extends State<_EmployeesTab> {
  List<Map<String, dynamic>>? _employees;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final employees = await widget.api.fetchEmployees();
      setState(() => _employees = employees);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_employees == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount: _employees!.length,
      itemBuilder: (context, index) {
        final employee = _employees![index];
        final grade = employee['grade'] as Map<String, dynamic>?;
        return ListTile(
          title: Text('${employee['employeeCode']} — ${employee['fullName']}'),
          subtitle: Text('${employee['department']} · ${grade?['gradeName'] ?? employee['gradeCode']}'),
          onTap: () => _openEmployeeDetail(employee),
        );
      },
    );
  }

  void _openEmployeeDetail(Map<String, dynamic> employee) {
    Navigator.of(context)
        .push(
          MaterialPageRoute(
            builder: (_) => _EmployeeDetailScreen(db: widget.db, deviceId: widget.deviceId, employee: employee),
          ),
        )
        .then((_) => widget.sync.syncNow());
  }
}

/// Landing point for the one offline-capturable HR action this slice
/// implements: attendance clock-in/out. Unlike every other capture screen
/// in this app, there's no form to fill in — just which button was
/// tapped — so this calls AttendanceRepository directly instead of going
/// through a Cubit (see that repository's doc comment for why).
class _EmployeeDetailScreen extends StatefulWidget {
  const _EmployeeDetailScreen({required this.db, required this.deviceId, required this.employee});
  final AppDatabase db;
  final String deviceId;
  final Map<String, dynamic> employee;

  @override
  State<_EmployeeDetailScreen> createState() => _EmployeeDetailScreenState();
}

class _EmployeeDetailScreenState extends State<_EmployeeDetailScreen> {
  late final AttendanceRepository _repository =
      AttendanceRepository(db: widget.db, deviceId: widget.deviceId);
  bool _submitting = false;

  Future<void> _clock(String eventType) async {
    setState(() => _submitting = true);
    try {
      await _repository.recordAttendance(
        employeeId: widget.employee['employeeId'] as String,
        eventType: eventType,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved locally. Will sync automatically once connected.')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e'), backgroundColor: Colors.red));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final grade = widget.employee['grade'] as Map<String, dynamic>?;
    return Scaffold(
      appBar: AppBar(title: Text(widget.employee['fullName'] as String)),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '${widget.employee['employeeCode']} · ${widget.employee['department']} · '
              '${grade?['gradeName'] ?? widget.employee['gradeCode']}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _submitting ? null : () => _clock('CLOCK_IN'),
              child: const Text('Clock In'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _submitting ? null : () => _clock('CLOCK_OUT'),
              child: const Text('Clock Out'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Seventh tab (Governance slice): Users list, fetched directly online.
/// Unlike every other tab, this one is PURELY read-only by design, not
/// just "no offline cache yet" — SDD §3.A is explicit that governance
/// master data (plants, warehouses, roles, users, approval matrix, reason
/// codes) is "pull-only, read-cached... never edited offline", since it
/// changes rarely and its correctness is safety-critical. There is no
/// capture repository, no Drift table, and no SyncModule.governance entry
/// anywhere in this app for that reason — not an oversight, a scope match
/// to what the SDD actually calls for.
class _UsersTab extends StatefulWidget {
  const _UsersTab({required this.api});
  final ApiClient api;

  @override
  State<_UsersTab> createState() => _UsersTabState();
}

class _UsersTabState extends State<_UsersTab> {
  List<Map<String, dynamic>>? _users;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final users = await widget.api.fetchUsers();
      setState(() => _users = users);
    } catch (e) {
      setState(() => _loadError = 'Could not reach server (offline?): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_users == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount: _users!.length,
      itemBuilder: (context, index) {
        final user = _users![index];
        final role = user['role'] as Map<String, dynamic>?;
        return ListTile(
          title: Text(user['fullName'] as String),
          subtitle: Text('${user['email']} · ${role?['roleName'] ?? 'No role assigned'}'),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => _UserDetailScreen(user: user)),
          ),
        );
      },
    );
  }
}

/// Read-only detail: the user's role and its RBAC permission flags
/// (docs/SDD.md §4.2: `can_approve`/`can_post`/`can_override`) — the same
/// flags AuthorizationService checks server-side. No actions on this
/// screen at all, matching the tab's read-only scope.
class _UserDetailScreen extends StatelessWidget {
  const _UserDetailScreen({required this.user});
  final Map<String, dynamic> user;

  @override
  Widget build(BuildContext context) {
    final role = user['role'] as Map<String, dynamic>?;
    final plant = user['plant'] as Map<String, dynamic>?;
    return Scaffold(
      appBar: AppBar(title: Text(user['fullName'] as String)),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('${user['email']}', style: Theme.of(context).textTheme.titleMedium),
            if (plant != null) Text('Plant: ${plant['plantName']}'),
            const SizedBox(height: 16),
            Text('Role: ${role?['roleName'] ?? 'None assigned'}', style: Theme.of(context).textTheme.titleSmall),
            if (role != null) ...[
              const SizedBox(height: 8),
              Text('Can approve: ${role['canApprove']}'),
              Text('Can post: ${role['canPost']}'),
              Text('Can override: ${role['canOverride']}'),
            ],
          ],
        ),
      ),
    );
  }
}

/// A real back-office inbox — everything currently pending
/// approval_matrix sign-off, across all four modules that use it
/// (Purchase Orders, Journal Entries, Maintenance Requests, Production
/// Batch cost reviews), in one place rather than scattered across each
/// module's own tab. Closes the "approval_matrix has zero UI anywhere"
/// gap (README "Known gaps") — that was true for all four, including
/// Purchase Orders, the original approval_matrix module; this tab is the
/// first screen in this app that can approve or reject anything.
///
/// No client-side role gating: this tab is visible to every signed-in
/// user, same as every other tab in this app — the real gate is the
/// server's checkApprovalAuthority/checkAuthority, which a wrong-tier
/// user hits as a real error surfaced via SnackBar, not something this
/// screen tries to prevent by hiding the buttons. Plain StatefulWidget,
/// no cubit — these are pure online-only decide-now actions with no
/// offline capture or local Drift storage involved at all, same
/// complexity level as the Customers/Vehicles/Employees tabs, not the
/// two-step capture screens that actually need one.
///
/// Field names differ per module because the underlying endpoints do:
/// Purchase Orders/Journal Entries/Maintenance Requests all go through
/// Prisma (camelCase JSON); Production Batches' list endpoint is raw SQL
/// (`SELECT *`, manufacturing-service's findAllBatches) and returns the
/// database's own snake_case column names — not a typo, a real
/// difference this screen has to know about.
class _ApprovalsTab extends StatefulWidget {
  const _ApprovalsTab({
    required this.procurementApi,
    required this.accountingApi,
    required this.fleetApi,
    required this.manufacturingApi,
  });
  final ApiClient procurementApi;
  final ApiClient accountingApi;
  final ApiClient fleetApi;
  final ApiClient manufacturingApi;

  @override
  State<_ApprovalsTab> createState() => _ApprovalsTabState();
}

class _ApprovalsTabState extends State<_ApprovalsTab> {
  List<Map<String, dynamic>> _purchaseOrders = [];
  List<Map<String, dynamic>> _journalEntries = [];
  List<Map<String, dynamic>> _maintenanceRequests = [];
  List<Map<String, dynamic>> _productionBatches = [];
  bool _loading = true;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        widget.procurementApi.fetchPurchaseOrders(),
        widget.accountingApi.fetchJournalEntries(),
        widget.fleetApi.fetchMaintenanceRequests(),
        widget.manufacturingApi.fetchProductionBatches(),
      ]);
      setState(() {
        _purchaseOrders = results[0].where((r) => r['approvalStatus'] == 'PENDING').toList();
        _journalEntries = results[1].where((r) => r['status'] == 'PENDING_APPROVAL').toList();
        _maintenanceRequests = results[2].where((r) => r['requestStatus'] == 'PENDING_APPROVAL').toList();
        _productionBatches = results[3].where((r) => r['cost_review_status'] == 'PENDING_APPROVAL').toList();
        _loadError = null;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _loadError = 'Could not reach server (offline?): $e';
        _loading = false;
      });
    }
  }

  /// Runs an approve/reject call, shows a SnackBar either way, and
  /// reloads on success so the acted-on item disappears from its list —
  /// the server's own response is the source of truth for whether it
  /// worked, this never optimistically removes an item beforehand.
  Future<void> _act(Future<Map<String, dynamic>> Function() action, String successMessage) async {
    try {
      await action();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(successMessage)));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Action failed: $e'), backgroundColor: Colors.red),
      );
    }
  }

  /// Purchase Order rejection is the one action on this tab that needs
  /// input beyond "which item" — procurement-service's `RejectPurchaseOrderDto`
  /// requires a `reasonCode` (see ApiClient.rejectPurchaseOrder's doc comment).
  /// Prompts for it, then runs the same `_act` path as every other action.
  Future<void> _rejectPurchaseOrderWithReason(Map<String, dynamic> po) async {
    final controller = TextEditingController();
    final reasonCode = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Reject purchase order'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Reason for rejection'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, controller.text.trim()),
            child: const Text('Reject'),
          ),
        ],
      ),
    );
    if (reasonCode == null || reasonCode.isEmpty) return;
    await _act(
      () => widget.procurementApi.rejectPurchaseOrder(po['poId'] as String, reasonCode),
      'Purchase order rejected.',
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_loadError!)));
    }
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    final sections = <Widget>[];

    if (_purchaseOrders.isNotEmpty) {
      sections.add(_sectionHeader('Purchase Orders (${_purchaseOrders.length})'));
      sections.addAll(_purchaseOrders.map(
        (po) => _approvalTile(
          title: po['poNumber'] as String,
          subtitle: 'Value: ${po['totalPoValue']}',
          onApprove: () => _act(
            () => widget.procurementApi.approvePurchaseOrder(po['poId'] as String),
            'Purchase order approved.',
          ),
          onReject: () => _rejectPurchaseOrderWithReason(po),
        ),
      ));
    }

    if (_journalEntries.isNotEmpty) {
      sections.add(_sectionHeader('Journal Entries (${_journalEntries.length})'));
      sections.addAll(_journalEntries.map((je) {
        final lines = (je['lines'] as List).cast<Map<String, dynamic>>();
        final amount = lines.fold<double>(0, (sum, l) => sum + (double.tryParse(l['debitAmount'].toString()) ?? 0));
        return _approvalTile(
          title: (je['memo'] as String?)?.isNotEmpty == true ? je['memo'] as String : 'Journal entry',
          subtitle: 'Amount: ${amount.toStringAsFixed(2)}',
          onApprove: () => _act(
            () => widget.accountingApi.approveJournalEntry(je['journalEntryId'] as String),
            'Journal entry approved.',
          ),
          onReject: () => _act(
            () => widget.accountingApi.rejectJournalEntry(je['journalEntryId'] as String),
            'Journal entry rejected.',
          ),
        );
      }));
    }

    if (_maintenanceRequests.isNotEmpty) {
      sections.add(_sectionHeader('Maintenance Requests (${_maintenanceRequests.length})'));
      sections.addAll(_maintenanceRequests.map((mr) {
        final total = (double.tryParse(mr['partsCost']?.toString() ?? '0') ?? 0) +
            (double.tryParse(mr['labourCost']?.toString() ?? '0') ?? 0);
        return _approvalTile(
          title: mr['reason'] as String? ?? 'Maintenance request',
          subtitle: 'Cost: ${total.toStringAsFixed(2)}',
          onApprove: () => _act(
            () => widget.fleetApi.approveMaintenanceRequest(mr['maintenanceRequestId'] as String),
            'Maintenance request approved.',
          ),
          onReject: () => _act(
            () => widget.fleetApi.rejectMaintenanceRequest(mr['maintenanceRequestId'] as String),
            'Maintenance request rejected.',
          ),
        );
      }));
    }

    if (_productionBatches.isNotEmpty) {
      sections.add(_sectionHeader('Production Batch Cost Reviews (${_productionBatches.length})'));
      sections.addAll(_productionBatches.map(
        (b) => _approvalTile(
          title: b['batch_number'] as String? ?? 'Batch',
          subtitle: 'Cost: ${b['batch_cost']}',
          onApprove: () => _act(
            () => widget.manufacturingApi.approveProductionBatch(b['batch_id'] as String),
            'Batch cost review approved.',
          ),
          onReject: () => _act(
            () => widget.manufacturingApi.rejectProductionBatch(b['batch_id'] as String),
            'Batch cost review rejected.',
          ),
        ),
      ));
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: sections.isEmpty
          ? ListView(
              children: const [
                Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: Text('Nothing pending approval.')),
                ),
              ],
            )
          : ListView(children: sections),
    );
  }

  Widget _sectionHeader(String label) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(label, style: const TextStyle(fontWeight: FontWeight.bold)),
      );

  Widget _approvalTile({
    required String title,
    required String subtitle,
    required VoidCallback onApprove,
    required VoidCallback onReject,
  }) {
    return ListTile(
      title: Text(title),
      subtitle: Text(subtitle),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(icon: const Icon(Icons.check_circle, color: Colors.green), onPressed: onApprove, tooltip: 'Approve'),
          IconButton(icon: const Icon(Icons.cancel, color: Colors.red), onPressed: onReject, tooltip: 'Reject'),
        ],
      ),
    );
  }
}
