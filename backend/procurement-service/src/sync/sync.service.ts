import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ProcurementService } from '../procurement/procurement.service';
import { SyncPushEventDto, SyncPushResultDto } from '../procurement/dto/goods-receipt.dto';

export type PullableEntity = 'goods_receipts' | 'goods_receipt_lines';

export interface PullResult {
  entity: PullableEntity;
  records: unknown[];
  nextCursor: string;
}

/**
 * The Sync Gateway (docs/SDD.md §2.2): idempotent push of offline-captured
 * outbox events, and cursor-based pull of server-authoritative state.
 *
 * Push is intent-application (each event is re-validated against current
 * server state, never blindly applied). Pull is state-replication (the
 * client's local cache is simply overwritten with what's returned here) —
 * that asymmetry is deliberate, see SDD §2.2.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly procurement: ProcurementService,
  ) {}

  async push(tenantId: string, events: SyncPushEventDto[]): Promise<SyncPushResultDto[]> {
    // Process sequentially, in the order the client sent them (client sorts
    // by hlc_timestamp before batching — SDD §2.2 "batching & ordering").
    const results: SyncPushResultDto[] = [];
    for (const event of events) {
      if (event.entityType === 'goods_receipt' && event.operation === 'CREATE') {
        const result = await this.procurement.createGoodsReceipt(
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
    if (entity === 'goods_receipts') {
      const rows = await this.prisma.forTenant(tenantId, (tx) =>
        tx.$queryRaw<Array<Record<string, unknown>>>`
          SELECT * FROM goods_receipts
          WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
          ORDER BY sync_seq ASC
          LIMIT ${limit}
        `,
      );
      return this.toPullResult('goods_receipts', rows, since);
    }
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM goods_receipt_lines
        WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
        ORDER BY sync_seq ASC
        LIMIT ${limit}
      `,
    );
    return this.toPullResult('goods_receipt_lines', rows, since);
  }

  private toPullResult(entity: PullableEntity, rows: Array<Record<string, unknown>>, since: bigint): PullResult {
    const maxSeq = rows.reduce((max, row) => {
      const seq = BigInt(row.sync_seq as string | number | bigint);
      return seq > max ? seq : max;
    }, since);
    // $queryRaw returns Postgres BIGINT/BIGSERIAL columns (sync_seq) as
    // native JS `bigint`, which JSON.stringify cannot serialize — it throws
    // at response-send time, not at compile time, so this is easy to miss
    // until the first real pull request. Every row must be sanitized before
    // it leaves this service.
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
