import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ProductionService } from '../production/production.service';
import { SyncPushEventDto, SyncPushResultDto } from '../production/dto/production-batch.dto';

export type PullableEntity = 'production_batches';

export interface PullResult {
  entity: PullableEntity;
  records: unknown[];
  nextCursor: string;
}

/**
 * The Sync Gateway for this module — same idempotent-push /
 * cursor-based-pull design as procurement-service's SyncService (SDD §2.2).
 * Only `production_batches` is pull-cached client-side for now;
 * `production_consumption` lines are fetched inline via the direct
 * GET /production-batches/:id read path once that's needed (not yet, in
 * this slice — the mobile client only needs to know a batch's own
 * post-sync status, not replicate its consumption lines back down).
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly production: ProductionService,
  ) {}

  async push(tenantId: string, events: SyncPushEventDto[]): Promise<SyncPushResultDto[]> {
    const results: SyncPushResultDto[] = [];
    for (const event of events) {
      if (event.entityType === 'production_batch' && event.operation === 'CREATE') {
        const result = await this.production.closeProductionBatch(
          tenantId,
          { ...event.payload, clientEventId: event.clientEventId, deviceId: event.deviceId },
          { createdOffline: true },
        );
        results.push(result);
      } else {
        results.push({
          clientEventId: event.clientEventId,
          status: 'REJECTED',
          reasonCode: 'UNSUPPORTED_ENTITY_TYPE',
        });
      }
    }
    return results;
  }

  async pull(tenantId: string, entity: PullableEntity, since: bigint, limit: number): Promise<PullResult> {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM production_batches
        WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
        ORDER BY sync_seq ASC
        LIMIT ${limit}
      `,
    );
    const maxSeq = rows.reduce((max, row) => {
      const seq = BigInt(row.sync_seq as string | number | bigint);
      return seq > max ? seq : max;
    }, since);
    // Same BigInt->string sanitization bug procurement-service's SyncService
    // hit in production: $queryRaw returns bigserial columns as native JS
    // bigint, which JSON.stringify cannot serialize.
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
