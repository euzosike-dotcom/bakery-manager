import { Body, Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { CreateSalesOrderDto } from './dto/sales-order.dto';
import { SalesService } from './sales.service';

@Controller()
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  // Direct/online order creation — offline-captured orders instead flow
  // through POST /sync/push (src/sync/sync.controller.ts) but land on the
  // exact same service method, mirroring the other two modules' structure.
  @Post('sales-orders')
  createSalesOrder(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateSalesOrderDto) {
    return this.sales.createSalesOrder(tenant.tenantId, dto, { createdOffline: false });
  }
}
