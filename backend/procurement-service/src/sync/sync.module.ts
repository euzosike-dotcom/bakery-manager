import { Module } from '@nestjs/common';
import { ProcurementModule } from '../procurement/procurement.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [ProcurementModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
