import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  roleCode!: string;

  @IsString()
  roleName!: string;

  @IsOptional()
  @IsString()
  roleCategory?: string;

  @IsOptional()
  @IsBoolean()
  canApprove?: boolean;

  @IsOptional()
  @IsBoolean()
  canPost?: boolean;

  @IsOptional()
  @IsBoolean()
  canOverride?: boolean;
}
