import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  HealthModule,
  KeycloakAuthMiddleware,
  MetricsModule,
  RateLimitModule,
  RequestIdMiddleware,
} from '@metrock/backend-common';
import { PrismaModule } from './common/prisma.module';
import { KafkaModule } from './common/kafka.module';
import { GovernanceModule } from './common/governance.module';
import { AgentsModule } from './agents/agents.module';
import { SalesModule } from './sales/sales.module';
import { NcrModule } from './ncr/ncr.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RateLimitModule,
    HealthModule,
    MetricsModule.forRoot('sales-service'),
    PrismaModule,
    KafkaModule,
    GovernanceModule,
    AgentsModule,
    SalesModule,
    NcrModule,
    SyncModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2's exclusions (GET /agents, /sync/push, /sync/pull) were
    // retired here in Phase 3 once the Flutter mobile app started
    // sending real Bearer tokens for every call — see docs/RUNBOOK.md.
    // `health`/`metrics` are the new ones (observability pass,
    // docs/RUNBOOK.md) — unauthenticated on purpose. RequestIdMiddleware
    // runs first, for everything, so even a 401 gets a correlated log line.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(KeycloakAuthMiddleware).exclude('health', 'metrics').forRoutes('*');
  }
}
