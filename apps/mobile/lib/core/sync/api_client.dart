import 'dart:convert';

import 'package:http/http.dart' as http;

import '../auth/auth_client.dart';

/// Talks to one backend domain service's Sync Gateway (`/sync/push`,
/// `/sync/pull`) and its direct REST endpoints — this class is generic
/// across services (only `baseUrl` differs); `main.dart` instantiates one
/// per module (procurement on :3001, manufacturing on :3002) and
/// `SyncService` (core/sync/sync_service.dart) routes each entity/event
/// type to the right instance.
///
/// Identity is a real Keycloak-issued Bearer token now (Phase 3 of the
/// Keycloak retrofit, docs/RUNBOOK.md) — `tenant_id` and `local_user_id`
/// live inside the token as claims and the backend derives them
/// server-side, so this class never manages or sends either one
/// directly; `AuthClient.getValidAccessToken()` is called fresh before
/// every request (it only actually refreshes when the token is near
/// expiry, so this isn't a network round-trip per call). `deviceId`
/// stays a plain header — it's a per-install correlation id for offline
/// sync idempotency, not an identity credential, so it never needed to
/// move into the token.
class ApiClient {
  ApiClient({
    required this.baseUrl,
    required this.deviceId,
    required this.auth,
    http.Client? httpClient,
  }) : _client = httpClient ?? http.Client();

  final String baseUrl;
  final String deviceId;
  final AuthClient auth;
  final http.Client _client;

  Future<Map<String, String>> get _headers async => {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
        'Authorization': 'Bearer ${await auth.getValidAccessToken()}',
      };

  Future<List<Map<String, dynamic>>> fetchPurchaseOrders() async {
    final res = await _client.get(Uri.parse('$baseUrl/purchase-orders'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// Recipes (with nested versions + ingredients) — fetched directly online,
  /// same simplification as fetchPurchaseOrders: master/reference data isn't
  /// on the cursor-based pull path yet (see README "Known gaps"), only the
  /// transactional entities (goods receipts, production batches) are.
  Future<List<Map<String, dynamic>>> fetchRecipes() async {
    final res = await _client.get(Uri.parse('$baseUrl/recipes'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// The SKU catalog (with `listPrice` where set), for the Sales Order
  /// capture picker — replaces what used to be a hardcoded single SKU with
  /// a free-text price (README "Known gaps"). Same online-only
  /// simplification as fetchRecipes: called against manufacturing-service,
  /// the table's owner, not sales-service.
  Future<List<Map<String, dynamic>>> fetchProductSkus() async {
    final res = await _client.get(Uri.parse('$baseUrl/product-skus'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// Agents with live-computed capital status — same online-only
  /// simplification as fetchPurchaseOrders/fetchRecipes. `availableCapital`
  /// here is a snapshot at fetch time for display only; it is NOT what
  /// gates an order (the server re-checks live at order-creation time
  /// regardless of what this call returned — see SalesOrderCaptureCubit's
  /// doc comment).
  Future<List<Map<String, dynamic>>> fetchAgents() async {
    final res = await _client.get(Uri.parse('$baseUrl/agents'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// Customers, for the picker on the Customers tab and on Sales Order
  /// capture. Same online-only simplification as fetchPurchaseOrders/
  /// fetchRecipes/fetchAgents — no local cache table, so a device needs
  /// connectivity at least once before a customer can be picked (see
  /// ActivitiesLocal's doc comment).
  Future<List<Map<String, dynamic>>> fetchCustomers() async {
    final res = await _client.get(Uri.parse('$baseUrl/customers'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// Vehicles (with assigned driver), for the Vehicles tab. Same online-
  /// only simplification as fetchPurchaseOrders/fetchRecipes/fetchAgents/
  /// fetchCustomers — no local cache table.
  Future<List<Map<String, dynamic>>> fetchVehicles() async {
    final res = await _client.get(Uri.parse('$baseUrl/vehicles'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// Employees (with salary grade), for the Employees tab. Same online-
  /// only simplification as every other master-data list in this app —
  /// no local cache table.
  Future<List<Map<String, dynamic>>> fetchEmployees() async {
    final res = await _client.get(Uri.parse('$baseUrl/employees'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// Users (with role + plant), for the Users tab. Governance master data
  /// is pull-only / read-cached per SDD §3.A — deliberately never
  /// editable offline, unlike every other module's tab, so there's no
  /// corresponding capture repository or Drift table at all, not just no
  /// local cache.
  Future<List<Map<String, dynamic>>> fetchUsers() async {
    final res = await _client.get(Uri.parse('$baseUrl/users'), headers: await _headers);
    _throwIfNotOk(res);
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// Pushes a batch of outbox events. Returns the per-event result array —
  /// callers must inspect each entry's `status`, a 200 response does not
  /// mean every event was accepted (SDD §2.2: push is per-event ack/reject).
  Future<List<Map<String, dynamic>>> syncPush(List<Map<String, dynamic>> events) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/sync/push'),
      headers: await _headers,
      body: jsonEncode({'events': events}),
    );
    _throwIfNotOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['results'] as List).cast<Map<String, dynamic>>();
  }

  /// Pulls server-authoritative state for one cached table since [since]
  /// (the locally-persisted cursor). The caller overwrites its local cache
  /// with the returned records — pull is state-replication, never merged
  /// field-by-field (SDD §2.2).
  Future<PullPage> syncPull(String entity, String since, {int limit = 200}) async {
    final uri = Uri.parse('$baseUrl/sync/pull').replace(queryParameters: {
      'entity': entity,
      'since': since,
      'limit': '$limit',
    });
    final res = await _client.get(uri, headers: await _headers);
    _throwIfNotOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return PullPage(
      entity: body['entity'] as String,
      records: (body['records'] as List).cast<Map<String, dynamic>>(),
      nextCursor: body['nextCursor'] as String,
    );
  }

  void _throwIfNotOk(http.Response res) {
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    throw ApiException(res.statusCode, res.body);
  }
}

class PullPage {
  PullPage({required this.entity, required this.records, required this.nextCursor});
  final String entity;
  final List<Map<String, dynamic>> records;
  final String nextCursor;
}

class ApiException implements Exception {
  ApiException(this.statusCode, this.body);
  final int statusCode;
  final String body;

  @override
  String toString() => 'ApiException($statusCode): $body';
}
