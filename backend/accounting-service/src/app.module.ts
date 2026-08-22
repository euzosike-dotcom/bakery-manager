import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  HealthModule,
  KeycloakAuthMiddleware,
  MetricsModule,
  RateLimitModule,
  RequestIdMiddleware,
} from '@metrock/backend-common';
import { PrismaModule } from './common/prisma.module';
import { KafkaModule } from './common/kafka.module';
import { GovernanceModule } from './common/governance.module';
import { BillsModule } from './bills/bills.module';
import { InvoicesModule } from './invoices/invoices.module';
import { JournalsModule } from './journals/journals.module';
import { ReportsModule } from './reports/reports.module';
import { PeriodCloseModule } from './period-close/period-close.module';
import { KafkaConsumerModule } from './kafka/kafka-consumer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RateLimitModule,
    HealthModule,
    MetricsModule.forRoot('accounting-service'),
    PrismaModule,
    KafkaModule,
    GovernanceModule,
    BillsModule,
    InvoicesModule,
    JournalsModule,
    ReportsModule,
    PeriodCloseModule,
    KafkaConsumerModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Phase 2 of the Keycloak retrofit — no exclusions needed here, unlike
    // most other Phase 2 services: accounting-service has no SyncModule
    // and none of its routes are called by the Flutter mobile app
    // (confirmed against apps/mobile/lib/core/sync/api_client.dart's
    // exact call list), matching the "Accounting has no Flutter UI"
    // known gap. The Kafka consumer is unaffected either way — it gets
    // tenantId straight from each event's own tenant_id field, never from
    // HTTP middleware. `health`/`metrics` ARE excluded below (observability
    // pass, docs/RUNBOOK.md) — unauthenticated on purpose.
    // RequestIdMiddleware runs first, for everything, so even a 401 gets
    // a correlated log line.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(KeycloakAuthMiddleware).exclude('health', 'metrics').forRoutes('*');
  }
}
