import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { CustomersService } from './customers.service';
import { CreateCustomerDto, UpdateCustomerStatusDto } from './dto/customer.dto';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateCustomerDto) {
    return this.customers.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.customers.findAll(tenant.tenantId);
  }

  @Get(':customerId')
  findOne(@CurrentTenant() tenant: TenantContext, @Param('customerId') customerId: string) {
    return this.customers.findOne(tenant.tenantId, customerId);
  }

  @Patch(':customerId/status')
  updateStatus(
    @CurrentTenant() tenant: TenantContext,
    @Param('customerId') customerId: string,
    @Body() dto: UpdateCustomerStatusDto,
  ) {
    return this.customers.updateStatus(tenant.tenantId, customerId, dto);
  }
}
