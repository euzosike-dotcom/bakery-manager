import { Controller, Get } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('trial-balance')
  trialBalance(@CurrentTenant() tenant: TenantContext) {
    return this.reports.trialBalance(tenant.tenantId);
  }

  @Get('profit-and-loss')
  profitAndLoss(@CurrentTenant() tenant: TenantContext) {
    return this.reports.profitAndLoss(tenant.tenantId);
  }

  @Get('balance-sheet')
  balanceSheet(@CurrentTenant() tenant: TenantContext) {
    return this.reports.balanceSheet(tenant.tenantId);
  }
}
