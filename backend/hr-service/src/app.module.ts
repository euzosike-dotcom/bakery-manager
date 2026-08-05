import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware, KeycloakAuthMiddleware } from '@metrock/backend-common';
import { PrismaModule } from './common/prisma.module';
import { KafkaModule } from './common/kafka.module';
import { GovernanceModule } from './common/governance.module';
import { EmployeesModule } from './employees/employees.module';
import { AttendanceModule } from './attendance/attendance.module';
import { PayrollModule } from './payroll/payroll.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    KafkaModule,
    GovernanceModule,
    EmployeesModule,
    AttendanceModule,
    PayrollModule,
    SyncModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2 of the Keycloak retrofit. GET /employees and /sync/push,
    // /sync/pull stay on the OLD header stub — called directly by the
    // Flutter mobile app (fetchEmployees(), and attendance capture which
    // dispatches through /sync/push per sync.service.ts's
    // entityType==='attendance_log' handling), which doesn't get a real
    // Keycloak token until Phase 3. POST/GET /payroll-runs and POST
    // /payroll-runs/:id/post (already posting-authority-gated — now also
    // gets real Keycloak auth for the caller) all get real Keycloak auth.
    consumer.apply(TenantContextMiddleware).forRoutes('employees', 'sync/push', 'sync/pull');
    consumer.apply(KeycloakAuthMiddleware).exclude('employees', 'sync/push', 'sync/pull').forRoutes('*');
  }
}
