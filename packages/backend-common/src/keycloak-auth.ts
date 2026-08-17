import * as jwt from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { UnauthorizedException } from '@nestjs/common';

export interface KeycloakAuthOptions {
  /** e.g. http://localhost:8080/realms/metrock — realm base URL, no trailing slash. */
  issuer: string;
}

export interface VerifiedKeycloakIdentity {
  tenantId: string;
  keycloakSubjectId: string;
  /**
   * The LOCAL `users.user_id` this Keycloak identity maps to — a custom
   * claim (`local_user_id`), sourced from a Keycloak user attribute set
   * once at provisioning time by `infra/keycloak/seed-users.sh`, not
   * resolved per-request. Optional: only governance-service owns the
   * `users` table and does its own DB-backed resolution instead (see its
   * KeycloakAuthMiddleware) — every other service's Postgres role has no
   * grant on `users` at all, so `KeycloakAuthMiddleware` below reads this
   * claim directly rather than requiring a new DB grant + Prisma model
   * per service just to answer "who is this."
   */
  localUserId?: string;
  email?: string;
}

/**
 * Real Keycloak OIDC token verification (SDD §1.2) — replaces
 * TenantContextMiddleware's stub header trust for services migrated onto
 * it (Phase 1: governance-service; Phase 2: the other 7 — see README
 * "Known gaps" for what's left).
 *
 * Deliberately built on `jsonwebtoken` + `jwks-rsa`, not `jose` — this
 * monorepo compiles every backend service to CommonJS (see any service's
 * tsconfig.json: "module": "commonjs"), and jose's ESM-only packaging in
 * recent major versions would break under a plain `require()`.
 * jsonwebtoken/jwks-rsa are the long-established CJS-safe combination for
 * exactly this "verify an RS256 JWT against a remote JWKS" use case.
 *
 * One JWKS client per issuer, cached at module scope — jwks-rsa's own
 * built-in cache (keys rarely rotate) means this does NOT hit the
 * network on every request, only on a cache miss/expiry.
 *
 * `tenant_id` and `local_user_id` are custom claims added via protocol
 * mappers on the "tenant" client scope (infra/keycloak/realm-export.json)
 * — NOT standard OIDC claims, so both are absent unless that scope is
 * granted. This function only proves identity (signature + issuer +
 * claim extraction); it does not touch any service's database.
 */

const jwksClientCache = new Map<string, JwksClient>();

function getJwksClient(issuer: string): JwksClient {
  let client = jwksClientCache.get(issuer);
  if (!client) {
    client = jwksClient({
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
      cache: true,
      rateLimit: true,
    });
    jwksClientCache.set(issuer, client);
  }
  return client;
}

function getSigningKey(issuer: string, kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    getJwksClient(issuer).getSigningKey(kid, (err, key) => {
      if (err || !key) {
        reject(err ?? new Error('Signing key not found'));
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

export async function verifyKeycloakToken(
  token: string,
  opts: KeycloakAuthOptions,
): Promise<VerifiedKeycloakIdentity> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded.payload === 'string' || !decoded.header.kid) {
    throw new UnauthorizedException('Malformed bearer token');
  }

  let publicKey: string;
  try {
    publicKey = await getSigningKey(opts.issuer, decoded.header.kid);
  } catch {
    throw new UnauthorizedException('Unable to resolve token signing key');
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, publicKey, { issuer: opts.issuer, algorithms: ['RS256'] }) as jwt.JwtPayload;
  } catch (err) {
    throw new UnauthorizedException(`Invalid bearer token: ${(err as Error).message}`);
  }

  const tenantId = payload['tenant_id'] as string | undefined;
  if (!tenantId) {
    throw new UnauthorizedException('Token missing tenant_id claim');
  }
  if (!payload.sub) {
    throw new UnauthorizedException('Token missing sub claim');
  }

  return {
    tenantId,
    keycloakSubjectId: payload.sub,
    localUserId: payload['local_user_id'] as string | undefined,
    email: payload['email'] as string | undefined,
  };
}

/**
 * Verifies a Keycloak client-credentials-grant token — the platform's
 * machine-to-machine auth (docs/RUNBOOK.md's "Machine-to-machine auth"
 * section), replacing `TenantContextMiddleware`'s old plain `x-tenant-id`
 * header stub as the thing that proves a caller hitting governance-
 * service's `/authorization-check`/`/approval-check` really is one of
 * the platform's own backend services, not just anyone who can reach the
 * port.
 *
 * Deliberately a SEPARATE function from `verifyKeycloakToken` above
 * rather than one function branching on token shape: a service-account
 * token has no `tenant_id`/`local_user_id` claims at all (those are
 * USER attributes, set at provisioning time by
 * `infra/keycloak/seed-users.sh` — a Keycloak service account is a
 * synthetic identity with no such attributes), so requiring them the way
 * `verifyKeycloakToken` does would reject every valid M2M token. What
 * this DOES verify is signature + issuer (same JWKS mechanism, same
 * `getSigningKey` cache) and that the token actually carries an `azp`
 * (authorized party — the client id, standard OIDC claim for a
 * client-credentials grant) identifying WHICH service is calling. It is
 * the CALLER's job (`M2MAuthMiddleware`) to check that client id against
 * an allow-list — this function only proves the token is genuine and
 * says who issued it, not that the caller is expected.
 */
export async function verifyM2MToken(token: string, opts: KeycloakAuthOptions): Promise<{ clientId: string }> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded.payload === 'string' || !decoded.header.kid) {
    throw new UnauthorizedException('Malformed bearer token');
  }

  let publicKey: string;
  try {
    publicKey = await getSigningKey(opts.issuer, decoded.header.kid);
  } catch {
    throw new UnauthorizedException('Unable to resolve token signing key');
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, publicKey, { issuer: opts.issuer, algorithms: ['RS256'] }) as jwt.JwtPayload;
  } catch (err) {
    throw new UnauthorizedException(`Invalid bearer token: ${(err as Error).message}`);
  }

  const clientId = (payload['azp'] ?? payload['client_id']) as string | undefined;
  if (!clientId) {
    throw new UnauthorizedException('Token missing azp/client_id claim — not a client-credentials token');
  }

  return { clientId };
}
