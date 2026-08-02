import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [AttendanceModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
