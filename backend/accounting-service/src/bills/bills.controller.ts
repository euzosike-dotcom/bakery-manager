import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { BillsService } from './bills.service';
import { RecordBillPaymentDto } from './dto/bill-payment.dto';

@Controller('vendor-bills')
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.bills.findAll(tenant.tenantId);
  }

  @Get(':billId')
  findOne(@CurrentTenant() tenant: TenantContext, @Param('billId') billId: string) {
    return this.bills.findOne(tenant.tenantId, billId);
  }

  @Post(':billId/payments')
  recordPayment(
    @CurrentTenant() tenant: TenantContext,
    @Param('billId') billId: string,
    @Body() dto: RecordBillPaymentDto,
  ) {
    return this.bills.recordPayment(tenant.tenantId, billId, dto);
  }
}
