import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [ActivitiesModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
