import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware } from '@metrock/backend-common';
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
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
