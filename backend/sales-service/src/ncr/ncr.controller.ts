import { Body, Controller, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { SubmitNcrDto } from './dto/ncr.dto';
import { NcrService } from './ncr.service';

@Controller()
export class NcrController {
  constructor(private readonly ncr: NcrService) {}

  // Direct/online submission — offline-captured NCR submissions instead
  // flow through POST /sync/push, landing on the exact same service method.
  @Post('ncr-collections')
  submitNcr(@CurrentTenant() tenant: TenantContext, @Body() dto: SubmitNcrDto) {
    return this.ncr.submitNcr(tenant.tenantId, dto, { createdOffline: false });
  }

  // Deliberately online-only — no sync/push path for this one, see
  // NcrService's class doc comment.
  @Post('ncr-collections/:ncrId/verify')
  verifyNcr(@CurrentTenant() tenant: TenantContext, @Param('ncrId') ncrId: string) {
    return this.ncr.verifyNcr(tenant.tenantId, ncrId, tenant.userId);
  }
}
