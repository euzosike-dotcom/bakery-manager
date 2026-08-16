import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  HealthModule,
  MetricsModule,
  RateLimitModule,
  RequestIdMiddleware,
  TenantContextMiddleware,
} from '@metrock/backend-common';
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
    RateLimitModule,
    HealthModule,
    MetricsModule.forRoot('governance-service'),
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
    // `/authorization-check` and `/approval-check` are the two remaining
    // routes on the OLD header stub — both SERVICE-TO-SERVICE endpoints
    // called by other backend services' `PostingAuthorityClient`
    // (packages/backend-common) with a plain x-tenant-id header, not a
    // user's own Bearer token. Real machine-to-machine auth
    // (client-credentials grant, one Keycloak client per caller) is a
    // separate, still out-of-scope story. `GET /users`' own exclusion
    // (added for the Flutter mobile Users tab) was retired here in
    // Phase 3 once the mobile app started sending real Bearer tokens for
    // every call — see docs/RUNBOOK.md. `health`/`metrics` are the new
    // ones (observability pass, docs/RUNBOOK.md) — unauthenticated on
    // purpose. RequestIdMiddleware runs first, for everything (including
    // authorization-check/approval-check, so a request-id forwarded by
    // another service's PostingAuthorityClient is honored rather than
    // overwritten — see request-id.middleware.ts).
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(TenantContextMiddleware).forRoutes('authorization-check', 'approval-check');
    consumer
      .apply(KeycloakAuthMiddleware)
      .exclude('authorization-check', 'approval-check', 'health', 'metrics')
      .forRoutes('*');
  }
}
