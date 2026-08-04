import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { ReasonCodesService } from './reason-codes.service';
import { CreateReasonCodeDto } from './dto/reason-code.dto';

@Controller('reason-codes')
export class ReasonCodesController {
  constructor(private readonly reasonCodes: ReasonCodesService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateReasonCodeDto) {
    return this.reasonCodes.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.reasonCodes.findAll(tenant.tenantId);
  }
}
