import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, M2MAuthMiddleware, MetricsModule, RateLimitModule, RequestIdMiddleware } from '@metrock/backend-common';
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
    // `/authorization-check` and `/approval-check` are the two
    // SERVICE-TO-SERVICE endpoints called by other backend services'
    // `PostingAuthorityClient` (packages/backend-common), not a user's
    // own Bearer token — `M2MAuthMiddleware` verifies a real Keycloak
    // client-credentials token (one registered client per calling
    // service, infra/keycloak/realm-export.json) against an allow-list
    // (M2M_ALLOWED_CLIENT_IDS below), replacing the old
    // `TenantContextMiddleware` plain `x-tenant-id`-header stub — see
    // docs/RUNBOOK.md's "Machine-to-machine auth" section. `GET /users`'
    // own exclusion (added for the Flutter mobile Users tab) was retired
    // here in Phase 3 once the mobile app started sending real Bearer
    // tokens for every call — see docs/RUNBOOK.md. `health`/`metrics`
    // are the observability pass's ones — unauthenticated on purpose.
    // RequestIdMiddleware runs first, for everything (including
    // authorization-check/approval-check, so a request-id forwarded by
    // another service's PostingAuthorityClient is honored rather than
    // overwritten — see request-id.middleware.ts).
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(M2MAuthMiddleware).forRoutes('authorization-check', 'approval-check');
    consumer
      .apply(KeycloakAuthMiddleware)
      .exclude('authorization-check', 'approval-check', 'health', 'metrics')
      .forRoutes('*');
  }
}
