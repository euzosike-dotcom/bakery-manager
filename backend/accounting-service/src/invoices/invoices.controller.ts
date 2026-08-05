import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { InvoicesService } from './invoices.service';
import { RecordInvoicePaymentDto } from './dto/invoice-payment.dto';

@Controller('customer-invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.invoices.findAll(tenant.tenantId);
  }

  @Get(':invoiceId')
  findOne(@CurrentTenant() tenant: TenantContext, @Param('invoiceId') invoiceId: string) {
    return this.invoices.findOne(tenant.tenantId, invoiceId);
  }

  @Post(':invoiceId/payments')
  recordPayment(
    @CurrentTenant() tenant: TenantContext,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: RecordInvoicePaymentDto,
  ) {
    return this.invoices.recordPayment(tenant.tenantId, invoiceId, dto, tenant.userId);
  }
}
