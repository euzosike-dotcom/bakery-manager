import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto } from './dto/opportunity.dto';

@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateOpportunityDto) {
    return this.opportunities.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.opportunities.findAll(tenant.tenantId);
  }
}
