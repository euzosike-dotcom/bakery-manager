import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { ActivitiesService } from './activities.service';
import { CreateActivityDto } from './dto/activity.dto';

@Controller()
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  // Direct/online capture — offline-captured activities instead flow
  // through POST /sync/push but land on the exact same service method,
  // mirroring every other module's structure.
  @Post('activities')
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateActivityDto) {
    return this.activities.createActivity(tenant.tenantId, dto, { createdOffline: false });
  }

  @Get('activities')
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.activities.findAll(tenant.tenantId);
  }
}
