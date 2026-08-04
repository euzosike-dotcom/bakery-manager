import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateApprovalMatrixDto {
  @IsString()
  moduleName!: string;

  @IsString()
  transactionType!: string;

  @IsOptional()
  @IsUUID()
  plantId?: string;

  @IsNumber()
  @Min(0)
  thresholdMin!: number;

  @IsOptional()
  @IsNumber()
  thresholdMax?: number;

  @IsOptional()
  @IsUUID()
  approvalLevel1RoleId?: string;

  @IsOptional()
  @IsUUID()
  approvalLevel2RoleId?: string;

  @IsOptional()
  @IsUUID()
  approvalLevel3RoleId?: string;
}
