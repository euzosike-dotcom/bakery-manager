import { IsBoolean, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateAuditLogDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsString()
  moduleName!: string;

  @IsString()
  recordIdRef!: string;

  @IsString()
  actionType!: string;

  @IsOptional()
  @IsObject()
  oldValueSnapshot?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  newValueSnapshot?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  ipOrDevice?: string;

  @IsOptional()
  @IsBoolean()
  overrideFlag?: boolean;

  @IsOptional()
  @IsString()
  reasonCode?: string;
}
