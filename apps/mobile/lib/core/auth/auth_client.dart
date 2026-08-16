import 'dart:async';

import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Real Keycloak login (Phase 3 of the Keycloak retrofit, docs/RUNBOOK.md)
/// — Authorization Code + PKCE via the system browser
/// (ASWebAuthenticationSession on iOS), replacing the hardcoded
/// `_devTenantId` and always-null `userId` every `ApiClient` sent since
/// Slice #1.
///
/// One instance, shared across every `ApiClient` (all 7 point at
/// different backend services but share the same Keycloak identity) —
/// `main.dart` constructs it once. `tenant_id` and `local_user_id` are
/// never read or managed here; they live inside the access token as
/// claims and the backend derives them server-side
/// (packages/backend-common's `verifyKeycloakToken`) — this class only
/// proves identity and hands back a valid Bearer token on request.
///
/// Tokens live in the platform keychain/keystore
/// (`flutter_secure_storage`), not plain SharedPreferences — this is the
/// one place in the app actually worth that protection, unlike the
/// tenant/device ids that were previously sent as plain headers.
class AuthClient {
  AuthClient({
    required this.issuer,
    required this.clientId,
    required this.redirectUrl,
    FlutterAppAuth? appAuth,
    FlutterSecureStorage? secureStorage,
  })  : _appAuth = appAuth ?? const FlutterAppAuth(),
        _secureStorage = secureStorage ?? const FlutterSecureStorage();

  /// Realm base URL, e.g. https://localhost:8543/realms/metrock — no
  /// trailing slash. TLS termination Part B (docs/RUNBOOK.md) put this on
  /// genuine HTTPS, so `allowInsecureConnections` below is `false` — this
  /// flow drives the native system browser (ASWebAuthenticationSession on
  /// iOS), which validates the cert against the OS trust store, not
  /// against ApiClient's pinned SecurityContext. The iOS Simulator's own
  /// keychain has to trust the dev cert for that validation to pass (see
  /// RUNBOOK's `xcrun simctl keychain ... add-root-cert` step) — a
  /// separate mechanism from how ApiClient's Dart-level HTTP calls trust
  /// it.
  final String issuer;
  final String clientId;
  final String redirectUrl;

  final FlutterAppAuth _appAuth;
  final FlutterSecureStorage _secureStorage;

  static const _kAccessToken = 'metrock_access_token';
  static const _kRefreshToken = 'metrock_refresh_token';
  static const _kIdToken = 'metrock_id_token';
  static const _kExpiry = 'metrock_access_token_expiry';

  final _authStateController = StreamController<bool>.broadcast();

  /// Emits `true` right after a successful login/session restore, `false`
  /// right after logout (or a refresh that discovers the session is
  /// truly dead, not just offline) — `main.dart` uses this to switch
  /// between the login screen and the tab UI.
  Stream<bool> get authStateChanges => _authStateController.stream;

  String? _accessToken;
  String? _refreshToken;
  String? _idToken;
  DateTime? _expiry;

  bool get isLoggedIn => _accessToken != null;

  String get _discoveryUrl => '$issuer/.well-known/openid-configuration';

  /// Call once at app start, before building any UI — reads whatever
  /// session was persisted from a previous run so a restart doesn't force
  /// a fresh login every time.
  Future<void> restoreSession() async {
    final access = await _secureStorage.read(key: _kAccessToken);
    final expiryStr = await _secureStorage.read(key: _kExpiry);
    if (access == null || expiryStr == null) {
      _authStateController.add(false);
      return;
    }
    _accessToken = access;
    _refreshToken = await _secureStorage.read(key: _kRefreshToken);
    _idToken = await _secureStorage.read(key: _kIdToken);
    _expiry = DateTime.parse(expiryStr);
    _authStateController.add(true);
  }

  /// Launches the system browser for a real Keycloak login. `offline_access`
  /// is requested so the refresh token Keycloak issues is long-lived and
  /// revocable rather than tied to a short browser-SSO session lifetime —
  /// the right scope for a native app that should stay signed in across
  /// restarts, per Keycloak's own guidance for this exact case.
  Future<void> login() async {
    final result = await _appAuth.authorizeAndExchangeCode(
      AuthorizationTokenRequest(
        clientId,
        redirectUrl,
        discoveryUrl: _discoveryUrl,
        scopes: const ['openid', 'tenant', 'offline_access'],
        allowInsecureConnections: false,
      ),
    );
    await _persist(
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      idToken: result.idToken,
      expiry: result.accessTokenExpirationDateTime,
    );
    _authStateController.add(true);
  }

  /// Best-effort realm logout (revokes the session server-side) plus
  /// always clearing the local session regardless of whether the
  /// end-session call itself succeeds — a user tapping "sign out" while
  /// offline must still end up logged out locally.
  Future<void> logout() async {
    final idTokenHint = _idToken;
    try {
      if (idTokenHint != null) {
        await _appAuth.endSession(
          EndSessionRequest(
            idTokenHint: idTokenHint,
            postLogoutRedirectUrl: redirectUrl,
            discoveryUrl: _discoveryUrl,
            allowInsecureConnections: false,
          ),
        );
      }
    } catch (_) {
      // Network down, browser closed early, realm unreachable — none of
      // these should block clearing the local session below.
    }
    await _clear();
    _authStateController.add(false);
  }

  /// Returns an access token guaranteed valid for at least 30 more
  /// seconds, silently refreshing first if needed. Every `ApiClient`
  /// request calls this before attaching its Authorization header.
  ///
  /// A refresh that fails because the device is offline (or the realm is
  /// briefly unreachable) rethrows the underlying network exception —
  /// exactly the same failure the caller would see if this were a plain
  /// API call with no auth involved, since capture screens never touch
  /// the network at all and only the eventual sync push/pull need a
  /// token. It does NOT log the user out; going offline must never be
  /// indistinguishable from being signed out. Only a genuine
  /// `invalid_grant` from the server (the refresh token itself rejected,
  /// e.g. revoked or expired past its own lifetime) clears the session
  /// and forces a real re-login.
  Future<String> getValidAccessToken() async {
    final accessToken = _accessToken;
    final expiry = _expiry;
    if (accessToken == null || expiry == null) {
      throw StateError('Not logged in');
    }

    if (expiry.difference(DateTime.now()) > const Duration(seconds: 30)) {
      return accessToken;
    }

    final refreshToken = _refreshToken;
    if (refreshToken == null) {
      await logout();
      throw StateError('Session expired and no refresh token was issued — sign in again');
    }

    try {
      final result = await _appAuth.token(
        TokenRequest(
          clientId,
          redirectUrl,
          discoveryUrl: _discoveryUrl,
          refreshToken: refreshToken,
          allowInsecureConnections: false,
        ),
      );
      await _persist(
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? refreshToken,
        idToken: result.idToken ?? _idToken,
        expiry: result.accessTokenExpirationDateTime,
      );
      return result.accessToken!;
    } on FlutterAppAuthPlatformException catch (e) {
      if (e.platformErrorDetails.error == FlutterAppAuthOAuthError.invalidGrant) {
        await logout();
        throw StateError('Session expired — sign in again');
      }
      rethrow;
    }
  }

  Future<void> _persist({
    String? accessToken,
    String? refreshToken,
    String? idToken,
    DateTime? expiry,
  }) async {
    _accessToken = accessToken;
    _refreshToken = refreshToken;
    _idToken = idToken;
    _expiry = expiry ?? DateTime.now().add(const Duration(minutes: 5));

    await _secureStorage.write(key: _kAccessToken, value: _accessToken);
    await _secureStorage.write(key: _kExpiry, value: _expiry!.toIso8601String());
    if (_refreshToken != null) {
      await _secureStorage.write(key: _kRefreshToken, value: _refreshToken);
    }
    if (_idToken != null) {
      await _secureStorage.write(key: _kIdToken, value: _idToken);
    }
  }

  Future<void> _clear() async {
    _accessToken = null;
    _refreshToken = null;
    _idToken = null;
    _expiry = null;
    await _secureStorage.delete(key: _kAccessToken);
    await _secureStorage.delete(key: _kRefreshToken);
    await _secureStorage.delete(key: _kIdToken);
    await _secureStorage.delete(key: _kExpiry);
  }

  void dispose() {
    _authStateController.close();
  }
}
