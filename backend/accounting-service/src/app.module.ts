import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware } from '@metrock/backend-common';
import { PrismaModule } from './common/prisma.module';
import { KafkaModule } from './common/kafka.module';
import { BillsModule } from './bills/bills.module';
import { InvoicesModule } from './invoices/invoices.module';
import { JournalsModule } from './journals/journals.module';
import { ReportsModule } from './reports/reports.module';
import { KafkaConsumerModule } from './kafka/kafka-consumer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    KafkaModule,
    BillsModule,
    InvoicesModule,
    JournalsModule,
    ReportsModule,
    KafkaConsumerModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Only the HTTP surface needs stub-auth tenant resolution — the Kafka
    // consumer gets tenantId straight from each event's own tenant_id field.
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
