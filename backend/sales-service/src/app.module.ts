import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware, KeycloakAuthMiddleware } from '@metrock/backend-common';
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
    // Phase 2 of the Keycloak retrofit. GET /agents and /sync/push,
    // /sync/pull stay on the OLD header stub — called directly by the
    // Flutter mobile app (fetchAgents(), and sales order/NCR capture
    // which dispatch through /sync/push per sync.service.ts's
    // entityType==='sales_order'/'ncr_collection' handling), which
    // doesn't get a real Keycloak token until Phase 3. POST
    // /sales-orders, POST /ncr-collections (curl/dev-testing only,
    // never called by mobile), and POST /ncr-collections/:ncrId/verify
    // (already posting-authority-gated — now also gets real Keycloak
    // auth for the caller) all get real Keycloak auth.
    consumer.apply(TenantContextMiddleware).forRoutes('agents', 'sync/push', 'sync/pull');
    consumer.apply(KeycloakAuthMiddleware).exclude('agents', 'sync/push', 'sync/pull').forRoutes('*');
  }
}
