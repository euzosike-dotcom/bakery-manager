import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateWarehouseDto {
  @IsString()
  warehouseCode!: string;

  @IsString()
  warehouseName!: string;

  @IsUUID()
  plantId!: string;

  @IsOptional()
  @IsString()
  warehouseType?: string;
}
