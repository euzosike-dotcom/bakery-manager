import { Controller, Get, Module } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * Unauthenticated liveness probe — `GET /health` returned a bare `401`
 * before this (no route existed at all, so `KeycloakAuthMiddleware`
 * rejected it like any other unauthenticated request), which nothing
 * that isn't already holding a Bearer token could ever use to check if
 * a service is up: not `docker-compose`'s own healthcheck mechanism, not
 * a real orchestrator's liveness/readiness probe, not even a plain
 * `curl` during incident triage.
 *
 * Each consuming service's `AppModule.configure()` MUST exclude this
 * path from `KeycloakAuthMiddleware` (`.exclude({ path: 'health',
 * method: RequestMethod.GET }, ...)`) — this controller alone doesn't
 * make the route unauthenticated, the middleware exclusion does.
 * `@SkipThrottle()` opts it out of the flat per-IP rate limit
 * (`RateLimitModule`) too, since a health check can legitimately be
 * polled far more often than real traffic.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
