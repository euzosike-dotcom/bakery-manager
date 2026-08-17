/**
 * `TenantContext` outlived the middleware it was originally named for.
 * The plain-header `TenantContextMiddleware` class that used to live in
 * this file was the platform's last stub-auth holdout — governance-
 * service's `/authorization-check`/`/approval-check`, called by
 * `PostingAuthorityClient` — and was deleted once `M2MAuthMiddleware`
 * (docs/RUNBOOK.md's "Machine-to-machine auth" section) took over
 * populating `req.tenantContext` for those two routes, gated behind a
 * real Keycloak client-credentials token instead of a self-reported
 * header. `x-tenant-id`/`x-user-id`/`x-device-id` still travel as plain
 * headers exactly as before (a service-account token has no tenant of
 * its own to assert) — only the trust mechanism in front of them
 * changed, not this shape.
 */
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
