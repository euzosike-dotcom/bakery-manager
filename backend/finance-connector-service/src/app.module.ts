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
import { FinanceConnectorModule } from './sync/finance-connector.module';
import { PostingsModule } from './postings/postings.module';
import { ReviewModule } from './review/review.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RateLimitModule,
    HealthModule,
    MetricsModule.forRoot('finance-connector-service'),
    PrismaModule,
    FinanceConnectorModule,
    PostingsModule,
    ReviewModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(KeycloakAuthMiddleware).exclude('health', 'metrics').forRoutes('*');
  }
}
