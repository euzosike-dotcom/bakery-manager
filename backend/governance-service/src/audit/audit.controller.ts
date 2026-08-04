import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { AuditService } from './audit.service';
import { CreateAuditLogDto } from './dto/audit.dto';

@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateAuditLogDto) {
    return this.audit.recordEntry(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.audit.findAll(tenant.tenantId);
  }

  @Get('verify')
  verify(@CurrentTenant() tenant: TenantContext) {
    return this.audit.verifyChain(tenant.tenantId);
  }
}
