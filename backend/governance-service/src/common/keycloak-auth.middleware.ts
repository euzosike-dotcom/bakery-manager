import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { verifyKeycloakToken } from '@metrock/backend-common';
import { PrismaService } from './prisma.service';

/**
 * Real Keycloak auth (SDD §1.2) — replaces TenantContextMiddleware's
 * stub header trust. Phase 1 of the retrofit: wired into
 * governance-service ONLY as the pilot; the other 7 services stay on
 * the header stub until Phase 2 repeats this same swap in each of
 * their app.module.ts (see docs/RUNBOOK.md "Keycloak auth retrofit").
 *
 * Verifies the Bearer token's signature + issuer via
 * `@metrock/backend-common`'s `verifyKeycloakToken` (JWKS-backed,
 * CJS-safe), then resolves the JWT's Keycloak `sub` to this tenant's
 * LOCAL `users.user_id` via `keycloak_subject_id` — the column the
 * schema has carried unused since migration 003_governance.sql.
 *
 * A verified token with no matching local user row (deprovisioned
 * employee, or a Keycloak account never linked by
 * infra/keycloak/seed-users.sh) is NOT rejected outright — tenantId is
 * already trustworthy from the signed claim, and `userId` resolving to
 * undefined is exactly the "no identity" case
 * AuthorizationService.checkAuthority already treats as an automatic,
 * audited denial wherever a posting-authority check actually gates on
 * it. Most of this service's own routes (roles/users/reason-codes CRUD,
 * audit-log reads) don't require a specific userId at all.
 */
@Injectable()
export class KeycloakAuthMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

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

    const localUser = await this.prisma.forTenant(identity.tenantId, (tx) =>
      tx.user.findFirst({
        where: { tenantId: identity.tenantId, keycloakSubjectId: identity.keycloakSubjectId },
      }),
    );

    req.tenantContext = {
      tenantId: identity.tenantId,
      userId: localUser?.userId,
      deviceId: req.header('x-device-id') ?? undefined,
    };
    next();
  }
}
