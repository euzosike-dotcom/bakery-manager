import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { CreateAttendanceLogDto } from '../../attendance/dto/attendance.dto';

export class SyncPushEventDto {
  @IsUUID()
  clientEventId!: string;

  @IsIn(['attendance_log'])
  entityType!: 'attendance_log';

  @IsIn(['CREATE'])
  operation!: 'CREATE';

  @IsString()
  hlcTimestamp!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ValidateNested()
  @Type(() => CreateAttendanceLogDto)
  payload!: CreateAttendanceLogDto;
}

export class SyncPushRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SyncPushEventDto)
  events!: SyncPushEventDto[];
}
