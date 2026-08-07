import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:metrock_mobile/core/auth/auth_client.dart';
import 'package:mocktail/mocktail.dart';

class MockFlutterAppAuth extends Mock implements FlutterAppAuth {}

class MockFlutterSecureStorage extends Mock implements FlutterSecureStorage {}

/// `AuthClient` (Phase 3 of the Keycloak retrofit, docs/RUNBOOK.md) takes
/// both its collaborators via constructor injection specifically so it can
/// be tested without a real browser or a real device keychain — this file
/// exercises the PKCE login/refresh/logout flow and the secure-storage
/// round-trip entirely against `mocktail` fakes.
void main() {
  late MockFlutterAppAuth appAuth;
  late MockFlutterSecureStorage secureStorage;
  late AuthClient client;

  const issuer = 'http://localhost:8080/realms/metrock';
  const clientId = 'metrock-mobile';
  const redirectUrl = 'com.metrock.mobile:/oauthredirect';

  setUpAll(() {
    registerFallbackValue(
      AuthorizationTokenRequest(clientId, redirectUrl, discoveryUrl: issuer),
    );
    registerFallbackValue(TokenRequest(clientId, redirectUrl, discoveryUrl: issuer));
    registerFallbackValue(EndSessionRequest(discoveryUrl: issuer));
  });

  setUp(() {
    appAuth = MockFlutterAppAuth();
    secureStorage = MockFlutterSecureStorage();
    // Every AuthClient write path calls write/delete for up to 4 keys —
    // stub them all as no-ops up front so individual tests only need to
    // stub the reads/appAuth calls that matter to what they're asserting.
    when(() => secureStorage.write(key: any(named: 'key'), value: any(named: 'value')))
        .thenAnswer((_) async {});
    when(() => secureStorage.delete(key: any(named: 'key'))).thenAnswer((_) async {});
    client = AuthClient(
      issuer: issuer,
      clientId: clientId,
      redirectUrl: redirectUrl,
      appAuth: appAuth,
      secureStorage: secureStorage,
    );
  });

  group('restoreSession', () {
    test('emits false and stays logged out when no session was persisted', () async {
      when(() => secureStorage.read(key: any(named: 'key'))).thenAnswer((_) async => null);

      final states = <bool>[];
      client.authStateChanges.listen(states.add);

      await client.restoreSession();
      await Future<void>.delayed(Duration.zero);

      expect(client.isLoggedIn, isFalse);
      expect(states, [false]);
    });

    test('restores a previously persisted session and emits true', () async {
      when(() => secureStorage.read(key: 'metrock_access_token')).thenAnswer((_) async => 'stored-access');
      when(() => secureStorage.read(key: 'metrock_access_token_expiry'))
          .thenAnswer((_) async => DateTime.now().add(const Duration(hours: 1)).toIso8601String());
      when(() => secureStorage.read(key: 'metrock_refresh_token')).thenAnswer((_) async => 'stored-refresh');
      when(() => secureStorage.read(key: 'metrock_id_token')).thenAnswer((_) async => 'stored-id');

      final states = <bool>[];
      client.authStateChanges.listen(states.add);

      await client.restoreSession();
      await Future<void>.delayed(Duration.zero);

      expect(client.isLoggedIn, isTrue);
      expect(states, [true]);
    });
  });

  group('login', () {
    test('persists all four tokens from a successful PKCE exchange and emits true', () async {
      when(() => appAuth.authorizeAndExchangeCode(any())).thenAnswer(
        (_) async => AuthorizationTokenResponse(
          'new-access',
          'new-refresh',
          DateTime.now().add(const Duration(hours: 1)),
          'new-id',
          'Bearer',
          const ['openid', 'tenant', 'offline_access'],
          null,
          null,
        ),
      );

      final states = <bool>[];
      client.authStateChanges.listen(states.add);

      await client.login();
      await Future<void>.delayed(Duration.zero);

      expect(client.isLoggedIn, isTrue);
      expect(states, [true]);
      verify(() => secureStorage.write(key: 'metrock_access_token', value: 'new-access')).called(1);
      verify(() => secureStorage.write(key: 'metrock_refresh_token', value: 'new-refresh')).called(1);
      verify(() => secureStorage.write(key: 'metrock_id_token', value: 'new-id')).called(1);
    });
  });

  group('getValidAccessToken', () {
    Future<void> logIn({required DateTime expiry}) async {
      when(() => appAuth.authorizeAndExchangeCode(any())).thenAnswer(
        (_) async => AuthorizationTokenResponse(
          'initial-access',
          'initial-refresh',
          expiry,
          'initial-id',
          'Bearer',
          const ['openid'],
          null,
          null,
        ),
      );
      await client.login();
    }

    test('returns the current token without refreshing when it is still valid', () async {
      await logIn(expiry: DateTime.now().add(const Duration(hours: 1)));

      final token = await client.getValidAccessToken();

      expect(token, 'initial-access');
      verifyNever(() => appAuth.token(any()));
    });

    test('silently refreshes when the token is within 30 seconds of expiry', () async {
      await logIn(expiry: DateTime.now().add(const Duration(seconds: 5)));
      when(() => appAuth.token(any())).thenAnswer(
        (_) async => TokenResponse(
          'refreshed-access',
          'refreshed-refresh',
          DateTime.now().add(const Duration(hours: 1)),
          'refreshed-id',
          'Bearer',
          const ['openid'],
          null,
        ),
      );

      final token = await client.getValidAccessToken();

      expect(token, 'refreshed-access');
      verify(() => secureStorage.write(key: 'metrock_access_token', value: 'refreshed-access')).called(1);
    });

    test('an invalid_grant refresh failure logs the user out and throws', () async {
      await logIn(expiry: DateTime.now().add(const Duration(seconds: 5)));
      when(() => appAuth.token(any())).thenThrow(
        FlutterAppAuthPlatformException(
          code: 'invalid_grant',
          platformErrorDetails:
              FlutterAppAuthPlatformErrorDetails(error: FlutterAppAuthOAuthError.invalidGrant),
        ),
      );
      when(() => appAuth.endSession(any())).thenAnswer((_) async => EndSessionResponse(null));

      final states = <bool>[];
      client.authStateChanges.listen(states.add);

      await expectLater(client.getValidAccessToken(), throwsA(isA<StateError>()));
      await Future<void>.delayed(Duration.zero);

      expect(client.isLoggedIn, isFalse);
      expect(states, [false]);
      verify(() => secureStorage.delete(key: 'metrock_access_token')).called(1);
    });

    test('a network failure during refresh rethrows WITHOUT logging out — offline must not look like signed-out', () async {
      await logIn(expiry: DateTime.now().add(const Duration(seconds: 5)));
      when(() => appAuth.token(any())).thenThrow(Exception('SocketException: network unreachable'));

      final states = <bool>[];
      client.authStateChanges.listen(states.add);

      await expectLater(client.getValidAccessToken(), throwsA(isA<Exception>()));
      await Future<void>.delayed(Duration.zero);

      // Must still be logged in — a transient network failure is not the
      // same thing as a rejected refresh token, per the class's own doc
      // comment on getValidAccessToken.
      expect(client.isLoggedIn, isTrue);
      expect(states, isEmpty);
      verifyNever(() => secureStorage.delete(key: any(named: 'key')));
    });
  });

  group('logout', () {
    test('clears the local session even when the server-side end-session call fails', () async {
      when(() => appAuth.authorizeAndExchangeCode(any())).thenAnswer(
        (_) async => AuthorizationTokenResponse(
          'access',
          'refresh',
          DateTime.now().add(const Duration(hours: 1)),
          'id-token',
          'Bearer',
          const ['openid'],
          null,
          null,
        ),
      );
      await client.login();
      when(() => appAuth.endSession(any())).thenThrow(Exception('realm unreachable'));

      final states = <bool>[];
      client.authStateChanges.listen(states.add);

      await client.logout();
      await Future<void>.delayed(Duration.zero);

      expect(client.isLoggedIn, isFalse);
      expect(states, [false]);
      verify(() => secureStorage.delete(key: 'metrock_access_token')).called(1);
    });
  });
}
