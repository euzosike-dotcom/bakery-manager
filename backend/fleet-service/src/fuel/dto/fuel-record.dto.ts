import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateFuelRecordDto {
  @IsOptional()
  @IsUUID()
  fuelRecordId?: string;

  @IsUUID()
  vehicleId!: string;

  @IsOptional()
  @IsUUID()
  tripLogId?: string;

  @IsNumber()
  @Min(0.01)
  litres!: number;

  @IsNumber()
  @Min(0)
  fuelCost!: number;

  @IsOptional()
  @IsString()
  expenseClaimReference?: string;

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
