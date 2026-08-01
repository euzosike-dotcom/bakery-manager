import { Controller, Get } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.vehicles.findAll(tenant.tenantId);
  }
}
