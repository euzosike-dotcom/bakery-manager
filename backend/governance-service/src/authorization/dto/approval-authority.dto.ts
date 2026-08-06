import { IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Min } from 'class-validator';

export class CheckApprovalAuthorityDto {
  // Optional for the same reason as CheckPostingAuthorityDto.userId — an
  // anonymous caller must resolve to a real denial, not a validation
  // error. See AuthorizationService.checkApprovalAuthority.
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsString()
  moduleName!: string;

  @IsString()
  transactionType!: string;

  @IsString()
  recordIdRef!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsUUID()
  plantId?: string;

  // Which approval_matrix level this checks (approval_level_{stage}_role_id)
  // — matches purchase_orders.current_approval_stage (or the equivalent
  // column on any other module's transaction). Defaults to 1 since most
  // transaction types in this platform only ever populate level 1.
  @IsOptional()
  @IsInt()
  @IsPositive()
  stage?: number;
}
