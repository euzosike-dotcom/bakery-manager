import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  HealthModule,
  KeycloakAuthMiddleware,
  MetricsModule,
  RateLimitModule,
  RequestIdMiddleware,
} from '@metrock/backend-common';
import { ProcurementModule } from './procurement/procurement.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RateLimitModule,
    HealthModule,
    MetricsModule.forRoot('procurement-service'),
    ProcurementModule,
    SyncModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2's exclusions (GET /purchase-orders, /sync/push, /sync/pull
    // — the routes the Flutter mobile app calls directly) were retired
    // here in Phase 3 once the mobile app started sending real Bearer
    // tokens for every call instead of the old header stub — see
    // docs/RUNBOOK.md. `health`/`metrics` are the new ones (observability
    // pass, docs/RUNBOOK.md) — unauthenticated on purpose, see
    // HealthController's/MetricsModule's own doc comments. RequestIdMiddleware
    // runs first, for everything, so even a 401 gets a correlated log line.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(KeycloakAuthMiddleware).exclude('health', 'metrics').forRoutes('*');
  }
}
