import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware, KeycloakAuthMiddleware } from '@metrock/backend-common';
import { PrismaModule } from './common/prisma.module';
import { CustomersModule } from './customers/customers.module';
import { OpportunitiesModule } from './opportunities/opportunities.module';
import { ActivitiesModule } from './activities/activities.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CustomersModule,
    OpportunitiesModule,
    ActivitiesModule,
    SyncModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2 of the Keycloak retrofit. GET /customers and /sync/push,
    // /sync/pull stay on the OLD header stub — called directly by the
    // Flutter mobile app (fetchCustomers(), and Activity capture which
    // dispatches through /sync/push per sync.service.ts's
    // entityType==='activity' handling), which doesn't get a real
    // Keycloak token until Phase 3. Method-precise on /customers since
    // POST is also registered at that same path and mobile never creates
    // customers, only reads them for the picker — POST /customers, GET
    // /customers/:id, opportunities, and GET/POST /activities all get
    // real Keycloak auth.
    const customersGet = { path: 'customers', method: RequestMethod.GET };
    consumer.apply(TenantContextMiddleware).forRoutes(customersGet, 'sync/push', 'sync/pull');
    consumer.apply(KeycloakAuthMiddleware).exclude(customersGet, 'sync/push', 'sync/pull').forRoutes('*');
  }
}
