import { Body, Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { CreateFuelRecordDto } from './dto/fuel-record.dto';
import { FuelService } from './fuel.service';

@Controller()
export class FuelController {
  constructor(private readonly fuel: FuelService) {}

  // Direct/online capture — offline-captured fuel records instead flow
  // through POST /sync/push, landing on the exact same service method.
  @Post('fuel-records')
  createFuelRecord(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateFuelRecordDto) {
    return this.fuel.createFuelRecord(tenant.tenantId, dto, { createdOffline: false });
  }
}
