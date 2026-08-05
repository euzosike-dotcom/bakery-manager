import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
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
    // `/authorization-check` is a SERVICE-TO-SERVICE endpoint — called by
    // sales/accounting/fleet/hr-service's PostingAuthorityClient
    // (packages/backend-common) with a plain x-tenant-id header, not a
    // user's own Bearer token (see docs/RUNBOOK.md's posting-authority
    // retrofit section). It deliberately keeps the OLD stub middleware
    // rather than requiring Keycloak auth — that's a separate,
    // out-of-scope machine-to-machine auth story (client-credentials
    // grant, one Keycloak client per calling service), not something
    // Phase 1 attempts. Every other route on this service — the ones an
    // actual end user or admin UI would call — gets the real thing.
    consumer.apply(TenantContextMiddleware).forRoutes('authorization-check');
    consumer.apply(KeycloakAuthMiddleware).exclude('authorization-check').forRoutes('*');
  }
}
