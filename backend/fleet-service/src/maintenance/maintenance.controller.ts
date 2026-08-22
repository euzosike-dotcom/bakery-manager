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
  // MaintenanceService's class doc comment. Submits the now-known repair
  // cost and moves the request to PENDING_APPROVAL — does NOT post to
  // the GL yet, see approve() below.
  @Post(':maintenanceRequestId/complete')
  submit(
    @CurrentTenant() tenant: TenantContext,
    @Param('maintenanceRequestId') maintenanceRequestId: string,
    @Body() dto: CompleteMaintenanceRequestDto,
  ) {
    return this.maintenance.submitMaintenanceRequest(tenant.tenantId, maintenanceRequestId, dto, tenant.userId);
  }

  @Post(':maintenanceRequestId/approve')
  approve(@CurrentTenant() tenant: TenantContext, @Param('maintenanceRequestId') maintenanceRequestId: string) {
    return this.maintenance.approveMaintenanceCompletion(tenant.tenantId, maintenanceRequestId, tenant.userId);
  }

  @Post(':maintenanceRequestId/reject')
  reject(@CurrentTenant() tenant: TenantContext, @Param('maintenanceRequestId') maintenanceRequestId: string) {
    return this.maintenance.rejectMaintenanceCompletion(tenant.tenantId, maintenanceRequestId, tenant.userId);
  }
}
