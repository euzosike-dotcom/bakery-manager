import { Body, Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { AuthorizationService } from './authorization.service';
import { CheckPostingAuthorityDto } from './dto/authorization.dto';

@Controller('authorization-check')
export class AuthorizationController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Post()
  check(@CurrentTenant() tenant: TenantContext, @Body() dto: CheckPostingAuthorityDto) {
    return this.authorization.checkAuthority(tenant.tenantId, dto);
  }
}
