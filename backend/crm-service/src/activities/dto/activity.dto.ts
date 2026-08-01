import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class CreateActivityDto {
  // Client-generated primary key — same rationale as every other module's
  // offline-capturable aggregate (e.g. CreateGoodsReceiptDto.grnId).
  @IsOptional()
  @IsUUID()
  activityId?: string;

  @IsUUID()
  customerId!: string;

  @IsIn(['CALL', 'VISIT', 'EMAIL', 'NOTE'])
  activityType!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsISO8601()
  activityDate?: string;

  @IsOptional()
  @IsUUID()
  createdByUserId?: string;

  @IsOptional()
  @IsUUID()
  clientEventId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

export class SyncPushEventDto {
  @IsUUID()
  clientEventId!: string;

  @IsIn(['activity'])
  entityType!: 'activity';

  @IsIn(['CREATE'])
  operation!: 'CREATE';

  @IsString()
  hlcTimestamp!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ValidateNested()
  @Type(() => CreateActivityDto)
  payload!: CreateActivityDto;
}

export class SyncPushRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SyncPushEventDto)
  events!: SyncPushEventDto[];
}

export type SyncEventStatus = 'ACKED' | 'REJECTED' | 'NEEDS_REVIEW';

export interface SyncPushResultDto {
  clientEventId: string;
  status: SyncEventStatus;
  serverEntityId?: string;
  reasonCode?: string;
  message?: string;
}
