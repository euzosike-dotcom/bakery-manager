import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { AgentOnboardingService } from './agent-onboarding.service';
import { SubmitAgentOnboardingDto } from './dto/agent-onboarding.dto';

@Controller('agent-onboarding-requests')
export class AgentOnboardingController {
  constructor(private readonly onboarding: AgentOnboardingService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.onboarding.findAllRequests(tenant.tenantId);
  }

  @Post()
  submit(@CurrentTenant() tenant: TenantContext, @Body() dto: SubmitAgentOnboardingDto) {
    return this.onboarding.submitOnboarding(tenant.tenantId, dto, tenant.userId);
  }

  @Post(':onboardingRequestId/approve')
  approve(@CurrentTenant() tenant: TenantContext, @Param('onboardingRequestId') onboardingRequestId: string) {
    return this.onboarding.approveOnboarding(tenant.tenantId, onboardingRequestId, tenant.userId);
  }

  @Post(':onboardingRequestId/reject')
  reject(@CurrentTenant() tenant: TenantContext, @Param('onboardingRequestId') onboardingRequestId: string) {
    return this.onboarding.rejectOnboarding(tenant.tenantId, onboardingRequestId, tenant.userId);
  }
}
