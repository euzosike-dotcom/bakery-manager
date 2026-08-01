import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import { SyncPushEventDto, SyncPushResultDto } from '../activities/dto/activity.dto';

export type PullableEntity = 'activities';

export interface PullResult {
  entity: PullableEntity;
  records: unknown[];
  nextCursor: string;
}

/**
 * The Sync Gateway for this module (docs/SDD.md §2.2) — one entity type
 * (`activity`), same single-entity-type shape as procurement-service's copy
 * of this file. Customers/Opportunities have no offline path (see
 * migration 012's header comment) — only Activities do.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  async push(tenantId: string, events: SyncPushEventDto[]): Promise<SyncPushResultDto[]> {
    const results: SyncPushResultDto[] = [];
    for (const event of events) {
      if (event.entityType === 'activity' && event.operation === 'CREATE') {
        const result = await this.activities.createActivity(
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
        SELECT * FROM activities WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
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
