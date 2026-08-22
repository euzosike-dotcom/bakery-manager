import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { CloseProductionBatchDto } from './dto/production-batch.dto';
import { ProductionService } from './production.service';

@Controller()
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

  @Get('recipes')
  listRecipes(@CurrentTenant() tenant: TenantContext) {
    return this.production.listRecipes(tenant.tenantId);
  }

  @Get('production-batches')
  findAllBatches(@CurrentTenant() tenant: TenantContext) {
    return this.production.findAllBatches(tenant.tenantId);
  }

  // Direct/online batch close — offline-captured batches instead flow
  // through POST /sync/push (src/sync/sync.controller.ts) but land on the
  // exact same service method, mirroring procurement-service's structure.
  @Post('production-batches')
  closeProductionBatch(@CurrentTenant() tenant: TenantContext, @Body() dto: CloseProductionBatchDto) {
    return this.production.closeProductionBatch(tenant.tenantId, dto, { createdOffline: false });
  }

  // Retrospective cost-review sign-off (docs/RUNBOOK.md's "approval_matrix
  // expansion" section) — never gates the batch itself, see
  // ProductionService.approveBatchCostReview's doc comment.
  @Post('production-batches/:batchId/approve')
  approveBatchCostReview(@CurrentTenant() tenant: TenantContext, @Param('batchId') batchId: string) {
    return this.production.approveBatchCostReview(tenant.tenantId, batchId, tenant.userId);
  }

  @Post('production-batches/:batchId/reject')
  rejectBatchCostReview(@CurrentTenant() tenant: TenantContext, @Param('batchId') batchId: string) {
    return this.production.rejectBatchCostReview(tenant.tenantId, batchId, tenant.userId);
  }
}
