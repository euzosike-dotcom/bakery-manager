import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from '@metrock/backend-common';

/**
 * Same reasoning as PrismaModule in this directory: SalesModule and
 * NcrModule both need a KafkaProducerService, and declaring it locally in
 * each (as procurement-service/manufacturing-service do — harmlessly,
 * since each of those only has one module using it) would open two
 * separate producer connections to the broker here instead of one.
 */
@Global()
@Module({
  providers: [{ provide: KafkaProducerService, useFactory: () => new KafkaProducerService('sales-service') }],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
