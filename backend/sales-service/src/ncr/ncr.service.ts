import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { SubmitNcrDto } from './dto/ncr.dto';
import { SyncPushResultDto } from '../sales/dto/sales-order.dto';

export interface SubmitNcrOptions {
  createdOffline: boolean;
}

/**
 * NCR (cash collected from the market and returned to the company) is
 * submitted here in two distinct steps, matching the real business process
 * (docs/SDD.md §3.D):
 *
 *   1. `submitNcr` — the agent/driver reports cash collected. Offline-
 *      capturable. Creates an UNVERIFIED record. Does NOT touch capital.
 *   2. `verifyNcr` — a back-office/finance action confirming the cash
 *      actually reached the bank. Deliberately ONLINE-ONLY (no offline
 *      path, no client_event_id/sync plumbing) since it's inherently a
 *      connected back-office action, not a field capture — same scope
 *      decision as CAPEX approval etc. in a full system. Only this step
 *      restores trading capital and posts to the ledger.
 *
 * Restoring capital on submission instead of verification would let an
 * agent claim an arbitrary cash collection to instantly unblock their own
 * orders — the entire point of the verified_flag gate.
 */
@Injectable()
export class NcrService {
  private readonly logger = new Logger(NcrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async submitNcr(tenantId: string, dto: SubmitNcrDto, options: SubmitNcrOptions): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.ncrCollection.findUnique({ where: { tenantId_clientEventId: { tenantId, clientEventId } } }),
    );
    if (existing) {
      this.logger.log(`NCR clientEventId=${clientEventId} already applied — idempotent no-op`);
      return { clientEventId, status: 'ACKED', serverEntityId: existing.ncrId, message: 'Already applied (idempotent replay)' };
    }

    const ncrId = dto.ncrId ?? randomUUID();
    await this.prisma.forTenant(tenantId, async (tx) => {
      const agent = await tx.agentMaster.findUnique({ where: { tenantId_agentId: { tenantId, agentId: dto.agentId } } });
      if (!agent) throw new NotFoundException(`Agent ${dto.agentId} not found`);

      await tx.$executeRaw`
        INSERT INTO ncr_collections (
          tenant_id, ncr_id, ncr_reference, agent_id, collection_date, amount,
          verified_flag, client_event_id, device_id, created_offline
        ) VALUES (
          ${tenantId}::uuid, ${ncrId}::uuid, ${dto.ncrReference}, ${dto.agentId}::uuid,
          ${dto.collectionDate ? new Date(dto.collectionDate) : new Date()}, ${dto.amount},
          false, ${clientEventId}::uuid, ${dto.deviceId ?? null}::uuid, ${options.createdOffline}
        )
      `;
    });

    return { clientEventId, status: 'ACKED', serverEntityId: ncrId, message: 'NCR submitted; awaiting finance verification before capital is restored.' };
  }

  /** Online-only. Not part of the offline sync surface — see class doc comment. */
  async verifyNcr(tenantId: string, ncrId: string, verifiedByUserId: string | undefined) {
    await this.postingAuthority.checkAuthority({
      tenantId,
      userId: verifiedByUserId,
      requiredPermission: 'can_post',
      moduleName: 'SALES',
      recordIdRef: ncrId,
    });

    // Kafka publish happens AFTER this transaction commits, not inside it —
    // same reasoning as ProcurementService.createGoodsReceipt and
    // ProductionService.closeProductionBatch: a slow/unavailable broker
    // must not roll back a capital restoration that has already succeeded
    // in Postgres (same known transactional-outbox simplification noted
    // there applies here too).
    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const ncr = await tx.ncrCollection.findUnique({ where: { tenantId_ncrId: { tenantId, ncrId } } });
      if (!ncr) throw new NotFoundException(`NCR ${ncrId} not found`);
      if (ncr.verifiedFlag) throw new BadRequestException(`NCR ${ncrId} is already verified`);

      await tx.$executeRaw`
        UPDATE ncr_collections
        SET verified_flag = true, verified_by = ${verifiedByUserId ?? null}::uuid, verified_at = now()
        WHERE tenant_id = ${tenantId}::uuid AND ncr_id = ${ncrId}::uuid
      `;

      // Synchronous, same-transaction restoration of the operational
      // sub-ledger — mirrors the debit side in SalesService.createSalesOrder.
      await tx.$executeRaw`
        INSERT INTO trading_capital_ledger (tenant_id, tcl_entry_id, agent_id, entry_type, reference_no, debit_value, credit_value)
        VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${ncr.agentId}::uuid, 'CREDIT_RECOVERY', ${ncr.ncrReference}, 0, ${Number(ncr.amount)})
      `;

      return { agentId: ncr.agentId, amount: Number(ncr.amount) };
    });

    await this.kafka.publish(tenantId, 'ncr.verified.v1', {
      event_id: randomUUID(),
      tenant_id: tenantId,
      ncr_id: ncrId,
      agent_id: result.agentId,
      ncr_amount: result.amount,
      posted_at: new Date().toISOString(),
    });

    return { ncrId, verified: true };
  }
}
