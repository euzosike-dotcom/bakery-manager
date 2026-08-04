import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreatePlantDto {
  @IsString()
  plantCode!: string;

  @IsString()
  plantName!: string;

  @IsOptional()
  @IsString()
  plantType?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  capacityKgPerDay?: number;

  @IsOptional()
  @IsBoolean()
  supportsAgentSales?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsProduction?: boolean;
}
