import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from '@metrock/backend-common';

/**
 * Same reasoning as PrismaModule in this directory: BillsModule and
 * InvoicesModule both need a KafkaProducerService (to emit
 * accounting.bill_paid.v1 / accounting.invoice_payment_received.v1) — one
 * shared producer connection, not one per module.
 */
@Global()
@Module({
  providers: [{ provide: KafkaProducerService, useFactory: () => new KafkaProducerService('accounting-service') }],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
