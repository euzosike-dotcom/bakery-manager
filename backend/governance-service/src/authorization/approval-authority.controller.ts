import { Body, Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { AuthorizationService } from './authorization.service';
import { CheckApprovalAuthorityDto } from './dto/approval-authority.dto';

/**
 * Separate top-level route from AuthorizationController deliberately —
 * that controller's own @Controller('authorization-check') decorator
 * makes its base path the route itself, so a method added there would
 * nest under it (authorization-check/approval-check) rather than sit
 * alongside it. Shares AuthorizationService with that controller since
 * the role-resolution/audit/alert scaffolding is the same; only the
 * decision logic differs (see AuthorizationService.checkApprovalAuthority's
 * doc comment for why this is a genuinely different check, not a
 * duplicate of checkAuthority).
 *
 * Same header-stub auth as /authorization-check (see this service's
 * app.module.ts) — this is ALSO a service-to-service endpoint, called by
 * PostingAuthorityClient from another backend service, never directly
 * by an end user's own Bearer token.
 */
@Controller('approval-check')
export class ApprovalAuthorityController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Post()
  check(@CurrentTenant() tenant: TenantContext, @Body() dto: CheckApprovalAuthorityDto) {
    return this.authorization.checkApprovalAuthority(tenant.tenantId, dto);
  }
}
