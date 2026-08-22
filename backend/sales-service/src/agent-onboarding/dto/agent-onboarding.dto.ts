import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class SubmitAgentOnboardingDto {
  @IsString()
  agentCode!: string;

  @IsString()
  agentName!: string;

  @IsOptional()
  @IsString()
  agentType?: string;

  @IsUUID()
  plantId!: string;

  @IsNumber()
  @Min(0.01)
  requestedTradingCapital!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  capitalCap?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  baseDiscountPercent?: number;
}
