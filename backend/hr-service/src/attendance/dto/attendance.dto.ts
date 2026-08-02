import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';

export class CreateAttendanceLogDto {
  @IsOptional()
  @IsUUID()
  attendanceLogId?: string;

  @IsUUID()
  employeeId!: string;

  @IsIn(['CLOCK_IN', 'CLOCK_OUT'])
  eventType!: 'CLOCK_IN' | 'CLOCK_OUT';

  @IsOptional()
  @IsISO8601()
  eventTime?: string;

  @IsOptional()
  @IsUUID()
  clientEventId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

export type SyncEventStatus = 'ACKED' | 'REJECTED' | 'NEEDS_REVIEW';

export interface SyncPushResultDto {
  clientEventId: string;
  status: SyncEventStatus;
  serverEntityId?: string;
  reasonCode?: string;
  message?: string;
}
