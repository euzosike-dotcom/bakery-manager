import { Body, Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { CreateTripLogDto } from './dto/trip-log.dto';
import { TripsService } from './trips.service';

@Controller()
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  // Direct/online capture — offline-captured trip logs instead flow
  // through POST /sync/push, landing on the exact same service method.
  @Post('trip-logs')
  createTripLog(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateTripLogDto) {
    return this.trips.createTripLog(tenant.tenantId, dto, { createdOffline: false });
  }
}
