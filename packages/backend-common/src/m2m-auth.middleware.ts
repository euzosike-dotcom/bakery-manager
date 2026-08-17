import { ForbiddenException, Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { verifyM2MToken } from './keycloak-auth';
import { TenantContext } from './tenant-context.middleware';

/**
 * Replaces `TenantContextMiddleware` as the guard in front of
 * governance-service's `/authorization-check` and `/approval-check`
 * (docs/RUNBOOK.md's "Machine-to-machine auth" section) — those two
 * routes were the ONE place left on the pre-Keycloak plain-header stub;
 * every other route in the platform already verifies a real token.
 *
 * Two things this checks, in order: (1) the bearer token is a genuine
 * Keycloak-issued client-credentials token (`verifyM2MToken`, same JWKS
 * signature/issuer verification every user-facing route already does),
 * and (2) its `azp` (which Keycloak client minted it — one per calling
 * service, `infra/keycloak/realm-export.json`) is on this service's own
 * allow-list, not just any registered client in the realm. `tenant_id`/
 * `user_id`/`device_id` still travel as plain headers exactly like
 * `TenantContextMiddleware` read them — a service-account token has no
 * tenant of its own to assert (it authenticates WHICH SERVICE is
 * calling, not a user or tenant), so that data still comes from the
 * caller, now gated behind proof of the caller's own identity instead of
 * trusted on its word alone.
 *
 * Has no constructor dependencies, like the shared `KeycloakAuthMiddleware`
 * — reads `KEYCLOAK_ISSUER` and `M2M_ALLOWED_CLIENT_IDS` (comma-separated
 * client ids) straight from `process.env`, the same way that class reads
 * `KEYCLOAK_ISSUER`, so `consumer.apply(M2MAuthMiddleware)` needs no
 * factory provider to supply constructor args.
 */
@Injectable()
export class M2MAuthMiddleware implements NestMiddleware {
  async use(req: Request, _res: Response, next: NextFunction) {
    const authHeader = req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Authorization: Bearer <token> (machine-to-machine)');
    }
    const token = authHeader.slice('Bearer '.length);

    const issuer = process.env.KEYCLOAK_ISSUER;
    if (!issuer) {
      throw new Error('KEYCLOAK_ISSUER is not configured');
    }
    const allowedClientIds = (process.env.M2M_ALLOWED_CLIENT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    const { clientId } = await verifyM2MToken(token, { issuer });
    if (!allowedClientIds.includes(clientId)) {
      throw new ForbiddenException(`Client "${clientId}" is not an allowed machine-to-machine caller`);
    }

    const tenantId = req.header('x-tenant-id');
    if (!tenantId) {
      throw new UnauthorizedException('Missing x-tenant-id header');
    }
    const tenantContext: TenantContext = {
      tenantId,
      userId: req.header('x-user-id') ?? undefined,
      deviceId: req.header('x-device-id') ?? undefined,
    };
    req.tenantContext = tenantContext;
    next();
  }
}
