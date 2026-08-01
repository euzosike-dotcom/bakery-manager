import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ConsumptionLineInputDto {
  @IsUUID()
  ingredientSkuId!: string;

  @IsNumber()
  @Min(0)
  plannedQty!: number;

  @IsNumber()
  @Min(0)
  actualQty!: number;
}

export class CloseProductionBatchDto {
  // Client-generated primary key — same rationale as CreateGoodsReceiptDto.grnId
  // in procurement-service: the device that creates the batch offline mints
  // its ID up front so the local cache and the eventual server row are the
  // same record, not two reconciled after the fact.
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @IsString()
  batchNumber!: string;

  @IsUUID()
  plantId!: string;

  @IsUUID()
  skuId!: string;

  // Snapshot-pinned at batch creation (SDD §2.3 Conflict Matrix scenario #5)
  // — the client captured this from whatever recipe version was "current"
  // when the batch started, and the server never re-resolves it to "the
  // latest" version even if the recipe has since been revised.
  @IsUUID()
  recipeVersionId!: string;

  @IsOptional()
  @IsISO8601()
  batchDate?: string;

  @IsNumber()
  @Min(0)
  plannedQty!: number;

  @IsNumber()
  @Min(0)
  actualOutputQty!: number;

  @IsNumber()
  @Min(0)
  actualWasteQty!: number;

  @IsOptional()
  @IsUUID()
  supervisorUserId?: string;

  @IsOptional()
  @IsUUID()
  clientEventId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConsumptionLineInputDto)
  consumptionLines!: ConsumptionLineInputDto[];
}

export class SyncPushEventDto {
  @IsUUID()
  clientEventId!: string;

  @IsIn(['production_batch'])
  entityType!: 'production_batch';

  @IsIn(['CREATE'])
  operation!: 'CREATE';

  @IsString()
  hlcTimestamp!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ValidateNested()
  @Type(() => CloseProductionBatchDto)
  payload!: CloseProductionBatchDto;
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
  yieldPercent?: number;
}
