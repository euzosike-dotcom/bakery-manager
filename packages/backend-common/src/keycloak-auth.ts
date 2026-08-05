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
  email?: string;
}

/**
 * Real Keycloak OIDC token verification (SDD §1.2) — replaces
 * TenantContextMiddleware's stub header trust for services migrated onto
 * it (Phase 1: governance-service only; see README "Known gaps").
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
 * `tenant_id` is a custom claim added via a protocol mapper on the
 * "tenant" client scope (infra/keycloak/realm-export.json) — NOT a
 * standard OIDC claim, so it's absent unless that scope is granted.
 * `sub` is Keycloak's internal user id, resolved to the LOCAL
 * `users.user_id` by the caller (see governance-service's
 * KeycloakAuthMiddleware) via the `keycloak_subject_id` column each
 * service's own Prisma client already owns — this function only proves
 * identity, it does not touch any service's database.
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

  return { tenantId, keycloakSubjectId: payload.sub, email: payload['email'] as string | undefined };
}
