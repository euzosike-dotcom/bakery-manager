import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { WarehousesService } from './warehouses.service';
import { CreateWarehouseDto } from './dto/warehouse.dto';

@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateWarehouseDto) {
    return this.warehouses.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.warehouses.findAll(tenant.tenantId);
  }
}
