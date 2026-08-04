import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { ApprovalMatrixService } from './approval-matrix.service';
import { CreateApprovalMatrixDto } from './dto/approval-matrix.dto';

@Controller('approval-matrix')
export class ApprovalMatrixController {
  constructor(private readonly approvalMatrix: ApprovalMatrixService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateApprovalMatrixDto) {
    return this.approvalMatrix.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.approvalMatrix.findAll(tenant.tenantId);
  }
}
