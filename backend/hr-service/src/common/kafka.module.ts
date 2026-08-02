import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from '@metrock/backend-common';

/**
 * Same reasoning as PrismaModule in this directory: only PayrollModule
 * needs a KafkaProducerService today, but @Global() here keeps this
 * service consistent with every other module's copy of this file and
 * costs nothing if a second feature module needs it later.
 */
@Global()
@Module({
  providers: [{ provide: KafkaProducerService, useFactory: () => new KafkaProducerService('hr-service') }],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
