import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware, KeycloakAuthMiddleware } from '@metrock/backend-common';
import { ProductionModule } from './production/production.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ProductionModule, SyncModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2 of the Keycloak retrofit. GET /recipes and /sync/push,
    // /sync/pull stay on the OLD header stub — called directly by the
    // Flutter mobile app (fetchRecipes(), and batch capture which
    // dispatches through /sync/push per sync.service.ts's
    // entityType==='production_batch' handling), which doesn't get a
    // real Keycloak token until Phase 3. POST /production-batches
    // (curl/dev-testing only, never called by mobile) gets real
    // Keycloak auth.
    consumer.apply(TenantContextMiddleware).forRoutes('recipes', 'sync/push', 'sync/pull');
    consumer.apply(KeycloakAuthMiddleware).exclude('recipes', 'sync/push', 'sync/pull').forRoutes('*');
  }
}
