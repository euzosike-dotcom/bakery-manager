import { Module } from '@nestjs/common';
import { BillsModule } from '../bills/bills.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { KafkaConsumerService } from './kafka-consumer.service';

@Module({
  imports: [BillsModule, InvoicesModule],
  providers: [KafkaConsumerService],
})
export class KafkaConsumerModule {}
