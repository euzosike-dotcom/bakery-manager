import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from '@metrock/backend-common';

/**
 * Same reasoning as PrismaModule in this directory: TripsModule,
 * FuelModule and MaintenanceModule all need a KafkaProducerService — one
 * shared producer connection, not one per module.
 */
@Global()
@Module({
  providers: [{ provide: KafkaProducerService, useFactory: () => new KafkaProducerService('fleet-service') }],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
