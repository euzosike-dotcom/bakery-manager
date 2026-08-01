import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { CreateGoodsReceiptDto } from './dto/goods-receipt.dto';
import { ProcurementService } from './procurement.service';

@Controller()
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get('suppliers')
  listSuppliers(@CurrentTenant() tenant: TenantContext) {
    return this.procurement.listSuppliers(tenant.tenantId);
  }

  @Get('purchase-orders')
  listPurchaseOrders(@CurrentTenant() tenant: TenantContext) {
    return this.procurement.listPurchaseOrders(tenant.tenantId);
  }

  @Get('purchase-orders/:poId')
  getPurchaseOrder(@CurrentTenant() tenant: TenantContext, @Param('poId') poId: string) {
    return this.procurement.getPurchaseOrder(tenant.tenantId, poId);
  }

  // Direct/online GRN creation — the web console / a connected tablet uses
  // this path. Offline-captured GRNs instead flow through POST /sync/push
  // (src/sync/sync.controller.ts) but land on the exact same service method.
  @Post('goods-receipts')
  createGoodsReceipt(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateGoodsReceiptDto) {
    return this.procurement.createGoodsReceipt(tenant.tenantId, dto, { createdOffline: false });
  }
}
