/**
 * Mints and caches a Keycloak client-credentials-grant token for one
 * calling service's own registered Keycloak client (docs/RUNBOOK.md's
 * "Machine-to-machine auth" section) — what `PostingAuthorityClient`
 * attaches as `Authorization: Bearer <token>` on its calls to
 * governance-service, replacing the old plain `x-tenant-id` header that
 * proved nothing about who was actually calling.
 *
 * Caches the token in memory and only re-mints when within 30 seconds of
 * expiry (Keycloak's client-credentials tokens default to a 5-minute
 * lifetime) — the same early-refresh margin `AuthClient` uses on the
 * Flutter side (`apps/mobile/lib/core/auth/auth_client.dart`'s
 * `getValidAccessToken`), so a burst of calls doesn't mint a fresh token
 * per request.
 */
export interface M2MTokenClientOptions {
  /** Realm base URL, e.g. https://localhost:8543/realms/metrock — the
   *  SAME value as this service's own KEYCLOAK_ISSUER, so the minted
   *  token's `iss` matches what governance-service verifies against. */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class M2MTokenClient {
  private cached?: CachedToken;

  constructor(private readonly opts: M2MTokenClientOptions) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAtMs - now > 30_000) {
      return this.cached.accessToken;
    }

    const res = await fetch(`${this.opts.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to mint machine-to-machine token for "${this.opts.clientId}": ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { accessToken: body.access_token, expiresAtMs: now + body.expires_in * 1000 };
    return this.cached.accessToken;
  }
}
