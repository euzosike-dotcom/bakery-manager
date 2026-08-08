import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KeycloakAuthMiddleware, RateLimitModule } from '@metrock/backend-common';
import { ProcurementModule } from './procurement/procurement.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), RateLimitModule, ProcurementModule, SyncModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2's exclusions (GET /purchase-orders, /sync/push, /sync/pull
    // — the routes the Flutter mobile app calls directly) were retired
    // here in Phase 3 once the mobile app started sending real Bearer
    // tokens for every call instead of the old header stub — see
    // docs/RUNBOOK.md.
    consumer.apply(KeycloakAuthMiddleware).forRoutes('*');
  }
}
