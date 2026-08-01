import { Controller, Get, Param } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { AgentsService } from './agents.service';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  listAgents(@CurrentTenant() tenant: TenantContext) {
    return this.agents.listAgents(tenant.tenantId);
  }

  @Get(':agentId/capital-status')
  getCapitalStatus(@CurrentTenant() tenant: TenantContext, @Param('agentId') agentId: string) {
    return this.agents.getAgentCapitalStatus(tenant.tenantId, agentId);
  }
}
