import { IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateOpportunityDto {
  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsUUID()
  customerId!: string;

  @IsString()
  opportunityName!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedValue?: number;

  @IsOptional()
  @IsISO8601()
  expectedCloseDate?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;
}
