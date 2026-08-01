import { IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class SubmitNcrDto {
  @IsOptional()
  @IsUUID()
  ncrId?: string;

  @IsString()
  ncrReference!: string;

  @IsUUID()
  agentId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsISO8601()
  collectionDate?: string;

  @IsOptional()
  @IsUUID()
  clientEventId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;
}
