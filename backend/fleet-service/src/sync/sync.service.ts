import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { TripsService } from '../trips/trips.service';
import { FuelService } from '../fuel/fuel.service';
import { CreateTripLogDto } from '../trips/dto/trip-log.dto';
import { CreateFuelRecordDto } from '../fuel/dto/fuel-record.dto';
import { SyncPushEventDto } from './dto/sync.dto';

export type PullableEntity = 'trip_logs' | 'fuel_records';

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
 * The Sync Gateway for this module (docs/SDD.md §2.2) — two entity types
 * (`trip_log`, `fuel_record`), same discriminated-dispatch shape as
 * sales-service's copy of this file (two payload shapes depending on
 * entityType, so `payload` is loosely typed and validated manually here
 * per branch — see that file's doc comment for the full "why").
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly fuel: FuelService,
  ) {}

  async push(tenantId: string, events: SyncPushEventDto[]): Promise<SyncPushResult[]> {
    const results: SyncPushResult[] = [];
    for (const event of events) {
      if (event.entityType === 'trip_log' && event.operation === 'CREATE') {
        const dto = plainToInstance(CreateTripLogDto, event.payload);
        const errors = await validate(dto);
        if (errors.length > 0) {
          results.push({ clientEventId: event.clientEventId, status: 'REJECTED', reasonCode: 'INVALID_PAYLOAD', message: errors.map((e) => Object.values(e.constraints ?? {}).join('; ')).join(', ') });
          continue;
        }
        dto.clientEventId = event.clientEventId;
        dto.deviceId = event.deviceId;
        results.push(await this.trips.createTripLog(tenantId, dto, { createdOffline: true }));
      } else if (event.entityType === 'fuel_record' && event.operation === 'CREATE') {
        const dto = plainToInstance(CreateFuelRecordDto, event.payload);
        const errors = await validate(dto);
        if (errors.length > 0) {
          results.push({ clientEventId: event.clientEventId, status: 'REJECTED', reasonCode: 'INVALID_PAYLOAD', message: errors.map((e) => Object.values(e.constraints ?? {}).join('; ')).join(', ') });
          continue;
        }
        dto.clientEventId = event.clientEventId;
        dto.deviceId = event.deviceId;
        results.push(await this.fuel.createFuelRecord(tenantId, dto, { createdOffline: true }));
      } else {
        results.push({ clientEventId: event.clientEventId, status: 'REJECTED', reasonCode: 'UNSUPPORTED_ENTITY_TYPE' });
      }
    }
    return results;
  }

  async pull(tenantId: string, entity: PullableEntity, since: bigint, limit: number): Promise<PullResult> {
    const rows =
      entity === 'trip_logs'
        ? await this.prisma.forTenant(tenantId, (tx) =>
            tx.$queryRaw<Array<Record<string, unknown>>>`
              SELECT * FROM trip_logs WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
              ORDER BY sync_seq ASC LIMIT ${limit}
            `,
          )
        : await this.prisma.forTenant(tenantId, (tx) =>
            tx.$queryRaw<Array<Record<string, unknown>>>`
              SELECT * FROM fuel_records WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
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
