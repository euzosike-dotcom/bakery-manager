import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module';
import { NcrModule } from '../ncr/ncr.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [SalesModule, NcrModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
