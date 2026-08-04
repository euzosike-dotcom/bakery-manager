import { IsIn, IsString, IsUUID } from 'class-validator';

export class CheckPostingAuthorityDto {
  @IsUUID()
  userId!: string;

  @IsIn(['can_approve', 'can_post', 'can_override'])
  requiredPermission!: 'can_approve' | 'can_post' | 'can_override';

  @IsString()
  moduleName!: string;

  @IsString()
  recordIdRef!: string;
}
