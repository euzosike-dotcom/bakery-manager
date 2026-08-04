import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateAuditLogDto } from './dto/audit.dto';

/**
 * Recursively sorts object keys so the same logical value always
 * produces the same JSON.stringify output, regardless of the original
 * key insertion order. This matters specifically because
 * `old_value_snapshot`/`new_value_snapshot` are stored as Postgres
 * `jsonb`, which does NOT preserve original key order or text formatting
 * — its binary storage format reorders top-level (and nested) object
 * keys by (length, then lexicographic) when read back, not the order
 * they were inserted in. Without canonicalizing before hashing, the
 * hash computed at insert time (from the pre-jsonb-round-trip object)
 * would never match the hash recomputed at verify time (from the
 * jsonb-reordered object read back from Postgres) — found exactly this
 * way, as a genuine chain-verification failure on the very first test
 * row, not a hypothetical. Applying this same canonicalization on BOTH
 * sides makes the hash depend only on content, never on incidental key
 * order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

interface AuditContent {
  eventTime: string;
  userId: string | null;
  moduleName: string;
  recordIdRef: string;
  actionType: string;
  oldValueSnapshot: unknown;
  newValueSnapshot: unknown;
  ipOrDevice: string | null;
  overrideFlag: boolean;
  reasonCode: string | null;
}

export interface AuditLogRow {
  auditLogId: string;
  eventTime: Date;
  userId: string | null;
  moduleName: string;
  recordIdRef: string;
  actionType: string;
  oldValueSnapshot: unknown;
  newValueSnapshot: unknown;
  ipOrDevice: string | null;
  overrideFlag: boolean;
  reasonCode: string | null;
  prevHash: string | null;
  recordHash: string;
  chainSeq: bigint;
}

/**
 * Hash-chained, tamper-evident audit log (docs/SDD.md §4.2). Every row's
 * `record_hash` commits to its own content AND the previous row's hash —
 * altering any historical row (content or hash) breaks every subsequent
 * link, which `verifyChain` below detects by recomputing the chain from
 * scratch and comparing. The DB backstops this independently: `audit_log`
 * has `ON UPDATE/DELETE DO INSTEAD NOTHING` rules (migration 003) that
 * apply regardless of role, so even this service's own `governance_svc`
 * role — which additionally isn't even granted UPDATE on this table
 * (migration 021) — cannot mutate a posted row. The hash chain is what
 * makes that immutability actually MEAN something (nothing behind a
 * given hash can be silently altered without detection), not what
 * enforces it.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  private buildContent(row: {
    eventTime: string | Date;
    userId: string | null;
    moduleName: string;
    recordIdRef: string;
    actionType: string;
    oldValueSnapshot: unknown;
    newValueSnapshot: unknown;
    ipOrDevice: string | null;
    overrideFlag: boolean;
    reasonCode: string | null;
  }): AuditContent {
    // Field order here is load-bearing — JSON.stringify follows object key
    // insertion order, and this same shape/order is used both when
    // hashing at insert time and when recomputing at verify time. Do not
    // reorder without updating both call sites identically.
    return {
      eventTime: typeof row.eventTime === 'string' ? row.eventTime : row.eventTime.toISOString(),
      userId: row.userId,
      moduleName: row.moduleName,
      recordIdRef: row.recordIdRef,
      actionType: row.actionType,
      oldValueSnapshot: canonicalize(row.oldValueSnapshot ?? null),
      newValueSnapshot: canonicalize(row.newValueSnapshot ?? null),
      ipOrDevice: row.ipOrDevice,
      overrideFlag: row.overrideFlag,
      reasonCode: row.reasonCode,
    };
  }

  private hash(content: AuditContent, prevHash: string | null): string {
    return createHash('sha256')
      .update(JSON.stringify(content) + (prevHash ?? ''))
      .digest('hex');
  }

  async recordEntry(tenantId: string, dto: CreateAuditLogDto): Promise<AuditLogRow> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const last = await tx.auditLog.findFirst({ where: { tenantId }, orderBy: { chainSeq: 'desc' } });
      const prevHash = last?.recordHash ?? null;

      const auditLogId = randomUUID();
      const eventTime = new Date().toISOString();
      const overrideFlag = dto.overrideFlag ?? false;

      const content = this.buildContent({
        eventTime,
        userId: dto.userId ?? null,
        moduleName: dto.moduleName,
        recordIdRef: dto.recordIdRef,
        actionType: dto.actionType,
        oldValueSnapshot: dto.oldValueSnapshot ?? null,
        newValueSnapshot: dto.newValueSnapshot ?? null,
        ipOrDevice: dto.ipOrDevice ?? null,
        overrideFlag,
        reasonCode: dto.reasonCode ?? null,
      });
      const recordHash = this.hash(content, prevHash);

      // Raw insert, not tx.auditLog.create() — audit_log.chain_seq is a
      // bigserial with no Prisma-visible default, same reason every
      // other sync_seq-bearing table in this platform is written this
      // way rather than through the typed client.
      const rows = await tx.$queryRaw<Array<{ audit_log_id: string; chain_seq: bigint }>>`
        INSERT INTO audit_log (
          tenant_id, audit_log_id, event_time, user_id, module_name, record_id_ref, action_type,
          old_value_snapshot, new_value_snapshot, ip_or_device, override_flag, reason_code,
          prev_hash, record_hash
        ) VALUES (
          ${tenantId}::uuid, ${auditLogId}::uuid, ${eventTime}::timestamptz, ${dto.userId ?? null}::uuid,
          ${dto.moduleName}, ${dto.recordIdRef}, ${dto.actionType},
          ${dto.oldValueSnapshot ? JSON.stringify(dto.oldValueSnapshot) : null}::jsonb,
          ${dto.newValueSnapshot ? JSON.stringify(dto.newValueSnapshot) : null}::jsonb,
          ${dto.ipOrDevice ?? null}, ${overrideFlag}, ${dto.reasonCode ?? null},
          ${prevHash}, ${recordHash}
        )
        RETURNING audit_log_id, chain_seq
      `;

      return {
        auditLogId: rows[0].audit_log_id,
        eventTime: new Date(eventTime),
        userId: dto.userId ?? null,
        moduleName: dto.moduleName,
        recordIdRef: dto.recordIdRef,
        actionType: dto.actionType,
        oldValueSnapshot: dto.oldValueSnapshot ?? null,
        newValueSnapshot: dto.newValueSnapshot ?? null,
        ipOrDevice: dto.ipOrDevice ?? null,
        overrideFlag,
        reasonCode: dto.reasonCode ?? null,
        prevHash,
        recordHash,
        chainSeq: rows[0].chain_seq,
      };
    });
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const rows = await tx.auditLog.findMany({ where: { tenantId }, orderBy: { chainSeq: 'asc' } });
      return rows.map((r) => ({ ...r, chainSeq: r.chainSeq.toString() }));
    });
  }

  /**
   * Recomputes the chain from scratch and compares against each stored
   * `record_hash` — this is the actual tamper-evidence check, not just a
   * read. Returns as soon as it finds the first broken link (everything
   * after a break is unverifiable relative to a false starting point).
   */
  async verifyChain(tenantId: string) {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId }, orderBy: { chainSeq: 'asc' } }),
    );

    let expectedPrevHash: string | null = null;
    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAtAuditLogId: row.auditLogId,
          brokenAtChainSeq: row.chainSeq.toString(),
          reason: 'prev_hash does not match the preceding record\'s record_hash',
          totalRecords: rows.length,
        };
      }
      const content = this.buildContent(row);
      const expectedHash = this.hash(content, row.prevHash);
      if (expectedHash !== row.recordHash) {
        return {
          valid: false,
          brokenAtAuditLogId: row.auditLogId,
          brokenAtChainSeq: row.chainSeq.toString(),
          reason: 'record_hash does not match recomputed hash of this record\'s content',
          totalRecords: rows.length,
        };
      }
      expectedPrevHash = row.recordHash;
    }

    return { valid: true, totalRecords: rows.length };
  }
}
