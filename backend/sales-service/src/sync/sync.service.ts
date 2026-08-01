import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { SalesService } from '../sales/sales.service';
import { NcrService } from '../ncr/ncr.service';
import { CreateSalesOrderDto, SyncPushEventDto, SyncPushResultDto } from '../sales/dto/sales-order.dto';
import { SubmitNcrDto } from '../ncr/dto/ncr.dto';

export type PullableEntity = 'sales_orders' | 'ncr_collections';

export interface PullResult {
  entity: PullableEntity;
  records: unknown[];
  nextCursor: string;
}

/**
 * The Sync Gateway for this module — same idempotent-push / cursor-based-
 * pull design as the other two services (SDD §2.2). Dispatches by
 * `entityType` to SalesService or NcrService; NCR *verification* has no
 * offline path (see NcrService's class doc comment), only submission does.
 *
 * Unlike procurement-service/manufacturing-service (one entity type each,
 * so `SyncPushEventDto.payload` could be strongly typed with
 * `@ValidateNested()` and validated automatically by Nest's global
 * ValidationPipe), this service's push endpoint carries two different
 * payload shapes depending on `entityType`. `class-validator` doesn't
 * natively validate a "type A or type B based on a sibling discriminator"
 * shape, so `payload` is declared loosely (`Record<string, unknown>`) and
 * validated manually here, per branch, before it ever reaches
 * SalesService/NcrService — skipping this and just casting the raw payload
 * (which an earlier draft of this file did) would mean a malformed offline
 * payload skips all `class-validator` checks entirely and hits raw
 * Prisma/SQL errors instead of a clean rejection.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
    private readonly ncr: NcrService,
  ) {}

  async push(tenantId: string, events: SyncPushEventDto[]): Promise<SyncPushResultDto[]> {
    const results: SyncPushResultDto[] = [];
    for (const event of events) {
      if (event.entityType === 'sales_order' && event.operation === 'CREATE') {
        const dto = plainToInstance(CreateSalesOrderDto, event.payload);
        const errors = await validate(dto);
        if (errors.length > 0) {
          results.push({ clientEventId: event.clientEventId, status: 'REJECTED', reasonCode: 'INVALID_PAYLOAD', message: errors.map((e) => Object.values(e.constraints ?? {}).join('; ')).join(', ') });
          continue;
        }
        dto.clientEventId = event.clientEventId;
        dto.deviceId = event.deviceId;
        results.push(await this.sales.createSalesOrder(tenantId, dto, { createdOffline: true }));
      } else if (event.entityType === 'ncr_collection' && event.operation === 'CREATE') {
        const dto = plainToInstance(SubmitNcrDto, event.payload);
        const errors = await validate(dto);
        if (errors.length > 0) {
          results.push({ clientEventId: event.clientEventId, status: 'REJECTED', reasonCode: 'INVALID_PAYLOAD', message: errors.map((e) => Object.values(e.constraints ?? {}).join('; ')).join(', ') });
          continue;
        }
        dto.clientEventId = event.clientEventId;
        dto.deviceId = event.deviceId;
        results.push(await this.ncr.submitNcr(tenantId, dto, { createdOffline: true }));
      } else {
        results.push({ clientEventId: event.clientEventId, status: 'REJECTED', reasonCode: 'UNSUPPORTED_ENTITY_TYPE' });
      }
    }
    return results;
  }

  async pull(tenantId: string, entity: PullableEntity, since: bigint, limit: number): Promise<PullResult> {
    const rows =
      entity === 'sales_orders'
        ? await this.prisma.forTenant(tenantId, (tx) =>
            tx.$queryRaw<Array<Record<string, unknown>>>`
              SELECT * FROM sales_orders WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
              ORDER BY sync_seq ASC LIMIT ${limit}
            `,
          )
        : await this.prisma.forTenant(tenantId, (tx) =>
            tx.$queryRaw<Array<Record<string, unknown>>>`
              SELECT * FROM ncr_collections WHERE tenant_id = ${tenantId}::uuid AND sync_seq > ${since}
              ORDER BY sync_seq ASC LIMIT ${limit}
            `,
          );

    const maxSeq = rows.reduce((max, row) => {
      const seq = BigInt(row.sync_seq as string | number | bigint);
      return seq > max ? seq : max;
    }, since);
    // Same BigInt->string sanitization needed by both prior services'
    // pull endpoints: $queryRaw returns bigserial columns as native JS
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
