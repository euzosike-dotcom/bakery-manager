import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KeycloakAuthMiddleware } from '@metrock/backend-common';
import { PrismaModule } from './common/prisma.module';
import { KafkaModule } from './common/kafka.module';
import { GovernanceModule } from './common/governance.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { TripsModule } from './trips/trips.module';
import { FuelModule } from './fuel/fuel.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    KafkaModule,
    GovernanceModule,
    VehiclesModule,
    TripsModule,
    FuelModule,
    MaintenanceModule,
    SyncModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2's exclusions (GET /vehicles, /sync/push, /sync/pull) were
    // retired here in Phase 3 once the Flutter mobile app started
    // sending real Bearer tokens for every call — see docs/RUNBOOK.md.
    consumer.apply(KeycloakAuthMiddleware).forRoutes('*');
  }
}
