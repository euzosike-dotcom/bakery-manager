import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { MaintenanceService } from './maintenance.service';
import { CompleteMaintenanceRequestDto } from './dto/maintenance.dto';

@Controller('maintenance-requests')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.maintenance.findAll(tenant.tenantId);
  }

  // Deliberately online-only — no sync/push path for this one, see
  // MaintenanceService's class doc comment.
  @Post(':maintenanceRequestId/complete')
  complete(
    @CurrentTenant() tenant: TenantContext,
    @Param('maintenanceRequestId') maintenanceRequestId: string,
    @Body() dto: CompleteMaintenanceRequestDto,
  ) {
    return this.maintenance.completeMaintenanceRequest(tenant.tenantId, maintenanceRequestId, dto, tenant.userId);
  }
}
