import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  deviceId?: string;
  roleCode?: string;
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
 * STUB AUTH — stands in for real Keycloak OIDC token validation (SDD §1.2).
 *
 * Reads tenant/user/device/role identity from headers instead of verifying a
 * signed JWT. This is intentionally isolated to this one file so swapping in
 * real token verification later is a single-file change, not a rewrite of
 * every controller in every service. DO NOT deploy this middleware as-is to
 * any environment that touches real tenant data.
 *
 * Originally duplicated per-service (procurement-service, manufacturing-
 * service each had their own copy); extracted here once a third service
 * (sales-service) needed it too — see root README.md "Known gaps".
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
      roleCode: req.header('x-role-code') ?? undefined,
    };
    next();
  }
}
