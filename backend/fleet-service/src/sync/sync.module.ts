import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import { FuelModule } from '../fuel/fuel.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [TripsModule, FuelModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
