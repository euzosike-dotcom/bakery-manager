import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware } from '@metrock/backend-common';
import { KeycloakAuthMiddleware } from './common/keycloak-auth.middleware';
import { PrismaModule } from './common/prisma.module';
import { TenantModule } from './tenant/tenant.module';
import { PlantsModule } from './plants/plants.module';
import { WarehousesModule } from './warehouses/warehouses.module';
import { RolesModule } from './roles/roles.module';
import { UsersModule } from './users/users.module';
import { ReasonCodesModule } from './reason-codes/reason-codes.module';
import { ApprovalMatrixModule } from './approval-matrix/approval-matrix.module';
import { AuditModule } from './audit/audit.module';
import { AuthorizationModule } from './authorization/authorization.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    TenantModule,
    PlantsModule,
    WarehousesModule,
    RolesModule,
    UsersModule,
    ReasonCodesModule,
    ApprovalMatrixModule,
    AuditModule,
    AuthorizationModule,
  ],
  providers: [KeycloakAuthMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Two routes deliberately stay on the OLD header stub rather than
    // requiring real Keycloak auth — both discovered by tracing actual
    // callers, not assumed:
    //
    // - `/authorization-check` is SERVICE-TO-SERVICE — called by
    //   sales/accounting/fleet/hr-service's PostingAuthorityClient
    //   (packages/backend-common) with a plain x-tenant-id header, not a
    //   user's own Bearer token. Real machine-to-machine auth
    //   (client-credentials grant, one Keycloak client per caller) is a
    //   separate, out-of-scope story.
    // - `GET /users` is called by the Flutter mobile app's Users tab
    //   (apps/mobile/lib/core/sync/api_client.dart's fetchUsers()) using
    //   the same header stub — mobile doesn't get a real Keycloak token
    //   until Phase 3 (PKCE). This one was MISSED in Phase 1's first
    //   pass (caught auditing every service's mobile surface before
    //   Phase 2) — GET /users was silently 401ing for the mobile app
    //   since Phase 1 shipped. POST /users (create) was never called by
    //   mobile, so it keeps real Keycloak auth.
    //
    // Every other route on this service gets the real thing.
    consumer.apply(TenantContextMiddleware).forRoutes(
      'authorization-check',
      { path: 'users', method: RequestMethod.GET },
    );
    consumer
      .apply(KeycloakAuthMiddleware)
      .exclude('authorization-check', { path: 'users', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
