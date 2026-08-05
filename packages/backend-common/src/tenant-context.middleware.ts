import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  deviceId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
    }
  }
}

/**
 * STUB AUTH — the pre-Keycloak header-based mechanism SDD §1.2 describes
 * being replaced by real OIDC token validation. As of the Keycloak auth
 * retrofit (docs/RUNBOOK.md, Phases 1-3), every service's actual
 * user-facing HTTP surface has moved to `KeycloakAuthMiddleware`
 * (governance-service's own DB-backed variant, or this package's shared
 * dependency-free one) — this class now has exactly one caller left in
 * the whole platform: governance-service's `/authorization-check`, a
 * SERVICE-TO-SERVICE endpoint called by `PostingAuthorityClient` with a
 * plain `x-tenant-id` header (no user identity involved at all, hence no
 * `x-user-id` sent either — `userId` below is `undefined` on every real
 * call this class still receives). Real machine-to-machine auth
 * (client-credentials grant, one Keycloak client per calling service) is
 * the only thing that would ever retire this last usage; still
 * out-of-scope. Dropped `roleCode`/`x-role-code` (Phase 4 cleanup) —
 * confirmed by grep that no authorization logic anywhere ever read it;
 * `AuthorizationService` always re-resolves role by a DB join from
 * `userId`, never from a caller-supplied header.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId = req.header('x-tenant-id');
    if (!tenantId) {
      throw new UnauthorizedException('Missing x-tenant-id header (stub auth)');
    }
    req.tenantContext = {
      tenantId,
      userId: req.header('x-user-id') ?? undefined,
      deviceId: req.header('x-device-id') ?? undefined,
    };
    next();
  }
}
