import { Body, Controller, Get, Post } from '@nestjs/common';
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

  // Direct/online batch close — offline-captured batches instead flow
  // through POST /sync/push (src/sync/sync.controller.ts) but land on the
  // exact same service method, mirroring procurement-service's structure.
  @Post('production-batches')
  closeProductionBatch(@CurrentTenant() tenant: TenantContext, @Body() dto: CloseProductionBatchDto) {
    return this.production.closeProductionBatch(tenant.tenantId, dto, { createdOffline: false });
  }
}
