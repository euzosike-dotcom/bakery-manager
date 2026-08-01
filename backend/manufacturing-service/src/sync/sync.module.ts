import { Module } from '@nestjs/common';
import { ProductionModule } from '../production/production.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [ProductionModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
