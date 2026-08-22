import { Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { PeriodCloseService } from './period-close.service';

@Controller('period-close')
export class PeriodCloseController {
  constructor(private readonly periodClose: PeriodCloseService) {}

  @Post()
  closeBooks(@CurrentTenant() tenant: TenantContext) {
    return this.periodClose.closeBooks(tenant.tenantId, tenant.userId);
  }
}
