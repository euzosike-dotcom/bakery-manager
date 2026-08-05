import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware, KeycloakAuthMiddleware } from '@metrock/backend-common';
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
    // Phase 2 of the Keycloak retrofit. GET /vehicles and /sync/push,
    // /sync/pull stay on the OLD header stub — called directly by the
    // Flutter mobile app (fetchVehicles(), and trip/fuel capture which
    // dispatch through /sync/push per sync.service.ts's
    // entityType==='trip_log'/'fuel_record' handling), which doesn't get
    // a real Keycloak token until Phase 3. GET /maintenance-requests and
    // POST /maintenance-requests/:id/complete (already
    // posting-authority-gated — now also gets real Keycloak auth for the
    // caller) both get real Keycloak auth.
    consumer.apply(TenantContextMiddleware).forRoutes('vehicles', 'sync/push', 'sync/pull');
    consumer.apply(KeycloakAuthMiddleware).exclude('vehicles', 'sync/push', 'sync/pull').forRoutes('*');
  }
}
