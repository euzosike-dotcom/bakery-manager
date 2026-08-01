import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';

export class SyncPushEventDto {
  @IsUUID()
  clientEventId!: string;

  @IsIn(['trip_log', 'fuel_record'])
  entityType!: 'trip_log' | 'fuel_record';

  @IsIn(['CREATE'])
  operation!: 'CREATE';

  @IsString()
  hlcTimestamp!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  // Loosely typed on purpose: two different payload shapes depending on
  // entityType — SyncService validates the concrete DTO per branch after
  // dispatch. `@IsObject()` (not `@ValidateNested()` + `@Type()`, which
  // would force one concrete shape) is still required, though — without
  // ANY class-validator decorator here, Nest's global ValidationPipe
  // (`whitelist: true, forbidNonWhitelisted: true`) treats `payload` as an
  // unrecognized property and rejects the entire request. See
  // sales-service's SyncPushEventDto for the full story on this gotcha.
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
