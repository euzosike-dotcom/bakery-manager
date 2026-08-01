import { IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateTripLogDto {
  // Client-generated primary key — same rationale as every other module's
  // offline-capturable aggregate (e.g. CreateGoodsReceiptDto.grnId).
  @IsOptional()
  @IsUUID()
  tripLogId?: string;

  @IsUUID()
  vehicleId!: string;

  @IsUUID()
  driverId!: string;

  @IsNumber()
  @Min(0)
  startMileage!: number;

  @IsNumber()
  @Min(0)
  endMileage!: number;

  @IsOptional()
  @IsString()
  destinationNote?: string;

  @IsOptional()
  @IsISO8601()
  tripDate?: string;

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
