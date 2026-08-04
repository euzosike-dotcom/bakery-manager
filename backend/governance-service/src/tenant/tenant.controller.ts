import { Controller, Get } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { TenantService } from './tenant.service';

@Controller('tenant')
export class TenantController {
  constructor(private readonly tenant: TenantService) {}

  @Get()
  findCurrent(@CurrentTenant() tenant: TenantContext) {
    return this.tenant.findCurrent(tenant.tenantId);
  }
}
