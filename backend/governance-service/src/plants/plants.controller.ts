import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { PlantsService } from './plants.service';
import { CreatePlantDto } from './dto/plant.dto';

@Controller('plants')
export class PlantsController {
  constructor(private readonly plants: PlantsService) {}

  @Post()
  create(@CurrentTenant() tenant: TenantContext, @Body() dto: CreatePlantDto) {
    return this.plants.create(tenant.tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.plants.findAll(tenant.tenantId);
  }
}
