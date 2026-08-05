import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { PayrollService } from './payroll.service';
import { CalculatePayrollRunDto } from './dto/payroll.dto';

@Controller('payroll-runs')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  // Online-only, finance-gated batch process (SDD §3.F) — never offline,
  // never queued. Calculates the pool + per-employee records but does
  // NOT post to the GL yet; see postRun below.
  @Post()
  calculateRun(@CurrentTenant() tenant: TenantContext, @Body() dto: CalculatePayrollRunDto) {
    return this.payroll.calculateRun(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.payroll.findAll(tenant.tenantId);
  }

  // The actual "posted_to_books_flag = true" action — online-only,
  // mirrors NcrService.verifyNcr's separation of submit vs. verify.
  @Post(':payrollRunId/post')
  postRun(@CurrentTenant() tenant: TenantContext, @Param('payrollRunId') payrollRunId: string) {
    return this.payroll.postRun(tenant.tenantId, payrollRunId, tenant.userId);
  }
}
