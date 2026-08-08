import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

/**
 * Basic flood/DoS protection — NOT the SDD's per-tenant-tier rate
 * limiting (docs/SDD.md §1.1's API Gateway responsibilities), which
 * genuinely doesn't apply yet: this platform has exactly one tenant, so
 * there's nothing to tier limits by. This is the different, always-
 * applicable thing underneath that: a flat cap on requests per client,
 * regardless of tenant, the same way `helmet`'s headers apply
 * unconditionally rather than waiting for a reason not to.
 *
 * Deliberately a SEPARATE layer from `infra/nginx/nginx.conf`'s own
 * `limit_req_zone`, not a replacement for it: the gateway only sees
 * traffic that goes through `localhost:8000`, but every service is also
 * directly reachable on its own port (this whole platform's established
 * dev-convenience pattern — this session's own manual verification has
 * hit services directly on their ports throughout). Without this module,
 * rate limiting would only cover the subset of traffic that happens to
 * go through the gateway, leaving direct-port access completely
 * unprotected.
 *
 * 100 requests/minute per client (tracked by IP by default) — a
 * generous, clearly-dev-appropriate default, not an attempt to
 * reverse-engineer real production SLA numbers, which the SDD itself
 * ties to a tenant tier that doesn't exist yet.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
