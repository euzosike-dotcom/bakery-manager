import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderLineInputDto {
  @IsUUID()
  skuId!: string;

  @IsNumber()
  @Min(0.001)
  orderedQty!: number;

  @IsNumber()
  @Min(0)
  unitPrice!: number;
}

export class CreateSalesOrderDto {
  // Client-generated primary key — same rationale as CreateGoodsReceiptDto.grnId
  // and CloseProductionBatchDto.batchId.
  @IsOptional()
  @IsUUID()
  salesOrderId?: string;

  @IsString()
  orderNumber!: string;

  @IsUUID()
  agentId!: string;

  @IsUUID()
  plantId!: string;

  // Optional CRM link (migration 012's nullable sales_orders.customer_id).
  // NULL means "no CRM customer recorded for this order" — does not affect
  // the agent-capital eligibility gate above, which is unchanged either
  // way. When present, accounting-service's sales.order_fulfilled.v1
  // consumer uses it to auto-raise a Customer Invoice.
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsISO8601()
  orderDate?: string;

  @IsOptional()
  @IsUUID()
  clientEventId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines!: OrderLineInputDto[];
}

export class SyncPushEventDto {
  @IsUUID()
  clientEventId!: string;

  @IsIn(['sales_order', 'ncr_collection'])
  entityType!: 'sales_order' | 'ncr_collection';

  @IsIn(['CREATE'])
  operation!: 'CREATE';

  @IsString()
  hlcTimestamp!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  // Loosely typed on purpose: the concrete shape depends on entityType, and
  // the two services (SalesService/NcrService) validate their own DTOs
  // internally once dispatched — see SyncService.push. `@IsObject()` (not
  // `@ValidateNested()` + `@Type()`, which would force one concrete shape)
  // is still required, though — without ANY class-validator decorator here,
  // Nest's global ValidationPipe (`whitelist: true, forbidNonWhitelisted:
  // true`) treats `payload` as an unrecognized property and rejects the
  // entire request with "property payload should not exist" before
  // SyncService.push ever runs. Caught during manual verification: nothing
  // synced, and the cause wasn't visible from the app side at all — only a
  // direct curl to /sync/push surfaced the actual 400.
  @IsObject()
  payload!: Record<string, unknown>;
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
  availableCapital?: number;
}
