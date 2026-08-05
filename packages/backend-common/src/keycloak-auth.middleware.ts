import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { verifyKeycloakToken } from './keycloak-auth';

/**
 * Shared, dependency-free Keycloak auth middleware for every service
 * EXCEPT governance-service (Phase 2 of the Keycloak retrofit — see
 * docs/RUNBOOK.md). governance-service owns the `users` table and
 * resolves the JWT's `sub` to a local `user_id` via a live DB lookup (its
 * own bespoke `KeycloakAuthMiddleware`, in that service's `src/common/`);
 * every OTHER service's Postgres role has no grant on `users` at all, so
 * this version reads the already-resolved `local_user_id` claim straight
 * off the verified token instead — no new DB grant or Prisma model
 * needed per service, and no per-request DB round-trip either. That
 * claim is set once, at provisioning time, by
 * `infra/keycloak/seed-users.sh`, not resolved live.
 *
 * Has no constructor dependencies (unlike governance-service's variant,
 * which injects PrismaService), so it can be a single shared class
 * rather than a bespoke file duplicated into each consuming service.
 */
@Injectable()
export class KeycloakAuthMiddleware implements NestMiddleware {
  async use(req: Request, _res: Response, next: NextFunction) {
    const authHeader = req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Authorization: Bearer <token>');
    }
    const token = authHeader.slice('Bearer '.length);

    const issuer = process.env.KEYCLOAK_ISSUER;
    if (!issuer) {
      throw new Error('KEYCLOAK_ISSUER is not configured');
    }

    const identity = await verifyKeycloakToken(token, { issuer });

    req.tenantContext = {
      tenantId: identity.tenantId,
      userId: identity.localUserId,
      deviceId: req.header('x-device-id') ?? undefined,
    };
    next();
  }
}
