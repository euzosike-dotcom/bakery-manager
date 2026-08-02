import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateAttendanceLogDto, SyncPushResultDto } from './dto/attendance.dto';

export interface CreateAttendanceLogOptions {
  createdOffline: boolean;
}

/**
 * Attendance clock-in/out is the one offline-capturable surface in this
 * module (SDD §3.F). Dedupe runs in two independent layers:
 *
 *   1. The standard client_event_id idempotency (checked first, below) —
 *      an exact retry of the same request (e.g. a sync retry after a
 *      dropped response).
 *   2. Matrix Scenario #8's (employee_id, event_type, time_bucket)
 *      dedupe — a genuinely DIFFERENT event (different client_event_id,
 *      different device) representing the same real-world clock-in,
 *      e.g. a phone and a plant kiosk both firing for one employee within
 *      the same shift window. Enforced via the DB's UNIQUE constraint
 *      (migration 019) and detected here with `INSERT ... ON CONFLICT ...
 *      DO NOTHING RETURNING` — if nothing comes back, the bucket was
 *      already claimed by an earlier event, and this one is deduped
 *      (still ACKED — SDD's own framing is "prevents double-counted
 *      attendance", not "reject the second scan").
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordAttendance(
    tenantId: string,
    dto: CreateAttendanceLogDto,
    options: CreateAttendanceLogOptions,
  ): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.attendanceLog.findUnique({ where: { tenantId_clientEventId: { tenantId, clientEventId } } }),
    );
    if (existing) {
      this.logger.log(`Attendance clientEventId=${clientEventId} already applied — idempotent no-op`);
      return { clientEventId, status: 'ACKED', serverEntityId: existing.attendanceLogId, message: 'Already applied (idempotent replay)' };
    }

    const attendanceLogId = dto.attendanceLogId ?? randomUUID();
    const eventTime = dto.eventTime ? new Date(dto.eventTime) : new Date();
    // Floor to the hour, in UTC — a stand-in for "same shift window"
    // (see migration 019's doc comment on why this isn't a generated
    // column, and why a fixed calendar-hour bucket is a deliberate
    // simplification rather than a configured shift boundary).
    const timeBucket = new Date(Math.floor(eventTime.getTime() / 3_600_000) * 3_600_000);

    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const employee = await tx.employee.findUnique({ where: { tenantId_employeeId: { tenantId, employeeId: dto.employeeId } } });
      if (!employee) throw new NotFoundException(`Employee ${dto.employeeId} not found`);

      const inserted = await tx.$queryRaw<Array<{ attendance_log_id: string }>>`
        INSERT INTO attendance_logs (
          tenant_id, attendance_log_id, employee_id, event_type, event_time, time_bucket,
          client_event_id, device_id, created_offline
        ) VALUES (
          ${tenantId}::uuid, ${attendanceLogId}::uuid, ${dto.employeeId}::uuid, ${dto.eventType},
          ${eventTime}, ${timeBucket}, ${clientEventId}::uuid, ${dto.deviceId ?? null}::uuid, ${options.createdOffline}
        )
        ON CONFLICT (tenant_id, employee_id, event_type, time_bucket) DO NOTHING
        RETURNING attendance_log_id
      `;

      if (inserted.length > 0) {
        return { attendanceLogId: inserted[0].attendance_log_id, deduped: false };
      }

      // Scenario #8 fired — someone (possibly this same request, via a
      // different device) already logged this employee/event/bucket.
      const deduped = await tx.attendanceLog.findFirst({
        where: { tenantId, employeeId: dto.employeeId, eventType: dto.eventType, timeBucket },
      });
      return { attendanceLogId: deduped!.attendanceLogId, deduped: true };
    });

    return {
      clientEventId,
      status: 'ACKED',
      serverEntityId: result.attendanceLogId,
      message: result.deduped
        ? 'Duplicate clock event within the same shift window — deduped, not double-counted (Matrix Scenario #8).'
        : 'Attendance recorded.',
    };
  }
}
