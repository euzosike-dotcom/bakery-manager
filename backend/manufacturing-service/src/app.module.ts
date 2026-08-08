import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KeycloakAuthMiddleware, RateLimitModule } from '@metrock/backend-common';
import { ProductionModule } from './production/production.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), RateLimitModule, ProductionModule, SyncModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2's exclusions (GET /recipes, /sync/push, /sync/pull) were
    // retired here in Phase 3 once the Flutter mobile app started
    // sending real Bearer tokens for every call — see docs/RUNBOOK.md.
    consumer.apply(KeycloakAuthMiddleware).forRoutes('*');
  }
}
