import { Body, Controller, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { CreateAttendanceLogDto } from './dto/attendance.dto';
import { AttendanceService } from './attendance.service';

@Controller()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // Direct/online capture — offline-captured attendance instead flows
  // through POST /sync/push, landing on the exact same service method.
  @Post('attendance-logs')
  recordAttendance(@CurrentTenant() tenant: TenantContext, @Body() dto: CreateAttendanceLogDto) {
    return this.attendance.recordAttendance(tenant.tenantId, dto, { createdOffline: false });
  }
}
