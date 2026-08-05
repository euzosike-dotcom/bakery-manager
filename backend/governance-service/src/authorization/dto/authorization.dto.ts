import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class CheckPostingAuthorityDto {
  // Optional deliberately — a caller with no identity at all (a missing
  // x-user-id, an anonymous/unauthenticated request) must still resolve
  // to a real answer, not a validation error, since "no identity" is
  // itself exactly the bypass-attempt scenario SDD §4.2 describes. See
  // AuthorizationService.checkAuthority for how an absent/unknown userId
  // is treated as an automatic denial, still audited (with user_id NULL
  // in that row) and still alerted — never silently skipped.
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsIn(['can_approve', 'can_post', 'can_override'])
  requiredPermission!: 'can_approve' | 'can_post' | 'can_override';

  @IsString()
  moduleName!: string;

  @IsString()
  recordIdRef!: string;
}
