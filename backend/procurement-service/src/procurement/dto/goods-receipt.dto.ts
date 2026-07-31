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

export class GoodsReceiptLineInputDto {
  // Client-generated (offline-first entity IDs are minted by the device that
  // creates the aggregate, not the server — see CreateGoodsReceiptDto.grnId
  // for the matching rationale). Falls back to server-generated if omitted
  // (e.g. a direct online POST from the web console).
  @IsOptional()
  @IsUUID()
  grnLineId?: string;

  @IsUUID()
  poLineId!: string;

  @IsNumber()
  @Min(0)
  receivedQty!: number;

  @IsNumber()
  @Min(0)
  acceptedQty!: number;

  @IsNumber()
  @Min(0)
  rejectedQty!: number;

  @IsString()
  uom!: string;

  @IsNumber()
  @Min(0)
  unitCost!: number;
}

export class CreateGoodsReceiptDto {
  // Client-generated primary key (SDD §2.1: the device that creates an
  // entity offline mints its ID up front so the local cache and the eventual
  // server row are the *same* record, not two records reconciled after the
  // fact). Distinct from `clientEventId`, which identifies the sync *event*,
  // not the entity — a later STATUS_TRANSITION event against this same GRN
  // would carry a new clientEventId but the same grnId. Optional because a
  // direct/online POST (e.g. from the web console) has no client-side
  // identity to preserve and can let the server generate one.
  @IsOptional()
  @IsUUID()
  grnId?: string;

  @IsString()
  grnNumber!: string;

  @IsUUID()
  poId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsOptional()
  @IsISO8601()
  receiptDate?: string;

  @IsOptional()
  @IsUUID()
  receiverUserId?: string;

  // The idempotency key (SDD §2.1). The Flutter client always supplies this
  // (generated client-side as a ULID/UUID at capture time); a direct online
  // POST that omits it gets one generated server-side.
  @IsOptional()
  @IsUUID()
  clientEventId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptLineInputDto)
  lines!: GoodsReceiptLineInputDto[];
}

export class SyncPushEventDto {
  @IsUUID()
  clientEventId!: string;

  @IsIn(['goods_receipt'])
  entityType!: 'goods_receipt';

  @IsIn(['CREATE'])
  operation!: 'CREATE';

  @IsString()
  hlcTimestamp!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ValidateNested()
  @Type(() => CreateGoodsReceiptDto)
  payload!: CreateGoodsReceiptDto;
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
