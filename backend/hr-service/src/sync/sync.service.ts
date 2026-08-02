import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AttendanceService } from '../attendance/attendance.service';
import { SyncPushEventDto } from './dto/sync.dto';

export type PullableEntity = 'attendance_logs';

export interface PullResult {
  entity: PullableEntity;
  records: unknown[];
  nextCursor: string;
}

interface SyncPushResult {
  clientEventId: string;
  status: 'ACKED' | 'REJECTED' | 'NEEDS_REVIEW';
  serverEntityId?: string;
  reasonCode?: string;
  message?: string;
}

/**
 * The Sync Gateway for this module (docs/SDD.md §2.2) — one entity type
 * (`attendance_log`), same single-entity-type shape as procurement-
 * service's copy of this file. Payroll runs have no offline path at all
 * (SDD §3.F: online-only, finance-gated, never queued).
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
  ) {}

  async push(tenantId: string, events: SyncPushEventDto[]): Promise<SyncPushResult[]> {
    const results: SyncPushResult[] = [];
    for (const event of events) {
      if (event.entityType === 'attendance_log' && event.operation === 'CREATE') {
        const result = await this.attendance.recordAttendance(
          tenantId,
          { ...event.payload, clientEventId: event.clientEventId, deviceId: event.deviceId },
          { createdOffline: true },
        );
        results.push(result);
      } else {
        results.push({ clientEventId: event.clientEventId, status: 'REJECTED', reasonCode: 'UNSUPPORTED_ENTITY_TYPE' });
      }
    }
    return results;
  }

  async pull(tenantId: string, entity: PullableEntity, since: bigint, limit: number): Promise<PullResult> {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM attendance_logs WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
        ORDER BY sync_seq ASC LIMIT ${limit}
      `,
    );

    const maxSeq = rows.reduce((max, row) => {
      const seq = BigInt(row.sync_seq as string | number | bigint);
      return seq > max ? seq : max;
    }, since);
    const safeRows = rows.map(serializeBigInts);
    return { entity, records: safeRows, nextCursor: maxSeq.toString() };
  }
}

function serializeBigInts(row: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    safe[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return safe;
}
