import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware, KeycloakAuthMiddleware } from '@metrock/backend-common';
import { ProcurementModule } from './procurement/procurement.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ProcurementModule, SyncModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2 of the Keycloak retrofit. GET /purchase-orders and
    // /sync/(push|pull) stay on the OLD header stub — both are called
    // directly by the Flutter mobile app (fetchPurchaseOrders(), and GRN
    // capture which the app dispatches through /sync/push rather than
    // calling POST /goods-receipts directly — confirmed via sync.service.ts's
    // entityType==='goods_receipt' dispatch), which doesn't get a real
    // Keycloak token until Phase 3. Everything else — GET /suppliers,
    // GET /purchase-orders/:poId, and POST /goods-receipts (curl/dev-testing
    // only, never called by mobile) — gets real Keycloak auth.
    consumer.apply(TenantContextMiddleware).forRoutes('purchase-orders', 'sync/push', 'sync/pull');
    consumer
      .apply(KeycloakAuthMiddleware)
      .exclude('purchase-orders', 'sync/push', 'sync/pull')
      .forRoutes('*');
  }
}
