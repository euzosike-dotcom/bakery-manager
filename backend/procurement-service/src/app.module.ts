import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware } from '@metrock/backend-common';
import { ProcurementModule } from './procurement/procurement.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ProcurementModule, SyncModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
