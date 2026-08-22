import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CloseProductionBatchDto, SyncPushResultDto } from './dto/production-batch.dto';

interface ApprovalBandRow {
  approval_level_1_role_id: string;
}

export interface CloseProductionBatchOptions {
  createdOffline: boolean;
}

/**
 * Yield %:
 *
 *   Yield % = Output Quantity / Input Quantity * 100
 *
 * (docs/SDD.md §3.C). "Input Quantity" here is the sum of *actual* ingredient
 * consumption for the batch, not the recipe's planned/standard quantities —
 * yield is meant to catch real-world over/under-consumption relative to
 * output, which planned figures can't reveal.
 */
@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  listRecipes(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.recipe.findMany({
        include: { versions: { where: { archivedFlag: false }, include: { ingredients: true } }, sku: true },
      }),
    );
  }

  async findAllBatches(tenantId: string) {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM production_batches WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at DESC
      `,
    );
    // sync_seq is bigserial — Postgres/pg returns it as a native JS
    // BigInt via $queryRaw, which JSON.stringify (and Nest's default
    // response serializer) cannot handle, throwing at response-send
    // time, not compile time. The exact same gotcha crm-service's
    // ActivitiesService.findAll hit first (see its doc comment) — this
    // is the first GET endpoint in manufacturing-service returning a
    // sync_seq column at all, so the same fix is needed here too.
    return rows.map((r) => ({ ...r, sync_seq: typeof r.sync_seq === 'bigint' ? r.sync_seq.toString() : r.sync_seq }));
  }

  /**
   * Closes a production batch: records ingredient consumption and finished-
   * goods output in one atomic submission (a real plant floor typically
   * records both together at the end of a production run — modelling every
   * intermediate WIP state transition is a natural extension, not required
   * to prove the pattern), computes yield, and — if the batch's pinned
   * recipe version is actually APPROVED — emits the ledger events for
   * consumption, output, and whichever yield-variance direction applies.
   *
   * Idempotent on `dto.clientEventId`, same as
   * ProcurementService.createGoodsReceipt.
   *
   * Mirrors that method's over-receipt guard with a different gate: a batch
   * against an unapproved recipe_version is recorded (evidence preserved)
   * but routed to NEEDS_REVIEW with no ledger postings, rather than either
   * silently posting against an unvetted recipe or rejecting the capture
   * outright.
   */
  async closeProductionBatch(
    tenantId: string,
    dto: CloseProductionBatchDto,
    options: CloseProductionBatchOptions,
  ): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.productionBatch.findUnique({ where: { tenantId_clientEventId: { tenantId, clientEventId } } }),
    );
    if (existing) {
      this.logger.log(`Batch clientEventId=${clientEventId} already applied — idempotent no-op`);
      return {
        clientEventId,
        status: existing.batchStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'ACKED',
        serverEntityId: existing.batchId,
        yieldPercent: existing.yieldPercent ? Number(existing.yieldPercent) : undefined,
        message: 'Already applied (idempotent replay)',
      };
    }

    const recipeVersion = await this.prisma.forTenant(tenantId, (tx) =>
      tx.recipeVersion.findUnique({
        where: { tenantId_recipeVersionId: { tenantId, recipeVersionId: dto.recipeVersionId } },
        include: { ingredients: true, recipe: true },
      }),
    );
    if (!recipeVersion) throw new NotFoundException(`Recipe version ${dto.recipeVersionId} not found`);
    if (recipeVersion.recipe.skuId !== dto.skuId) {
      throw new BadRequestException(
        `Recipe version ${dto.recipeVersionId} belongs to SKU ${recipeVersion.recipe.skuId}, not ${dto.skuId}`,
      );
    }

    const outputSku = await this.prisma.forTenant(tenantId, (tx) =>
      tx.productSku.findUnique({ where: { tenantId_skuId: { tenantId, skuId: dto.skuId } } }),
    );
    if (!outputSku) throw new NotFoundException(`SKU ${dto.skuId} not found`);

    const ingredientByskuId = new Map(recipeVersion.ingredients.map((i) => [i.ingredientSkuId, i]));
    for (const line of dto.consumptionLines) {
      if (!ingredientByskuId.has(line.ingredientSkuId)) {
        throw new BadRequestException(
          `SKU ${line.ingredientSkuId} is not an ingredient of recipe version ${dto.recipeVersionId}`,
        );
      }
    }

    const totalActualQty = dto.consumptionLines.reduce((sum, l) => sum + l.actualQty, 0);
    if (totalActualQty <= 0) {
      throw new BadRequestException('Total actual consumption quantity must be greater than zero');
    }

    // Yield % = Output / Input * 100 (SDD §3.C) only makes sense when both
    // sides are the same unit of measure. Ingredient consumption is always
    // mass-based (KG) in this recipe model, but finished-good output is
    // frequently counted in discrete units (e.g. "UNIT" = one 500g loaf) —
    // comparing a unit count directly against a KG total silently produces
    // a meaningless percentage (caught during manual verification: 870
    // loaves vs 348kg of ingredients came out as a nonsensical 250%).
    // Converting through the SKU's standardWeightKg fixes it; a SKU that's
    // already mass-denominated (standardWeightKg is null) needs no conversion.
    const outputMassKg = outputSku.standardWeightKg
      ? dto.actualOutputQty * Number(outputSku.standardWeightKg)
      : dto.actualOutputQty;
    const yieldPercent = (outputMassKg / totalActualQty) * 100;
    const isRecipeApproved = recipeVersion.approvalStatus === 'APPROVED';
    const batchStatus = isRecipeApproved ? 'CLOSED' : 'NEEDS_REVIEW';
    const yieldAlertTriggered = yieldPercent < Number(recipeVersion.yieldThresholdPercent);

    const batchCost = dto.actualOutputQty * Number(recipeVersion.standardCost);

    // Does batchCost match any configured MANUFACTURING/BATCH_COST band?
    // Plain read, not checkApprovalAuthority — see migration
    // 024_manufacturing_batch_cost_review.sql's comment for why a
    // never-blocking, offline-capturable action can't use that call's
    // per-user, fail-closed-on-no-band semantics here. "No matching row"
    // correctly means "no review needed", not "denied".
    const band = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<ApprovalBandRow[]>`
        SELECT approval_level_1_role_id FROM approval_matrix
        WHERE tenant_id = ${tenantId}::uuid AND module_name = 'MANUFACTURING' AND transaction_type = 'BATCH_COST'
          AND is_active = true AND threshold_min <= ${batchCost}
          AND (threshold_max IS NULL OR threshold_max > ${batchCost})
        LIMIT 1
      `,
    );
    const costReviewStatus = band.length > 0 ? 'PENDING_APPROVAL' : 'NOT_REQUIRED';
    const pendingApproverRoleId = band.length > 0 ? band[0].approval_level_1_role_id : null;

    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const batchId = dto.batchId ?? randomUUID();

      await tx.$executeRaw`
        INSERT INTO production_batches (
          tenant_id, batch_id, batch_number, plant_id, sku_id, recipe_version_id,
          batch_date, planned_qty, actual_output_qty, actual_waste_qty,
          yield_percent, yield_alert_triggered, batch_status, supervisor_user_id,
          client_event_id, device_id, created_offline, batch_cost, cost_review_status,
          pending_approver_role_id
        ) VALUES (
          ${tenantId}::uuid, ${batchId}::uuid, ${dto.batchNumber}, ${dto.plantId}::uuid, ${dto.skuId}::uuid,
          ${dto.recipeVersionId}::uuid, ${dto.batchDate ? new Date(dto.batchDate) : new Date()},
          ${dto.plannedQty}, ${dto.actualOutputQty}, ${dto.actualWasteQty},
          ${yieldPercent}, ${yieldAlertTriggered}, ${batchStatus}, ${dto.supervisorUserId ?? null}::uuid,
          ${clientEventId}::uuid, ${dto.deviceId ?? null}::uuid, ${options.createdOffline}, ${batchCost},
          ${costReviewStatus}, ${pendingApproverRoleId}::uuid
        )
      `;

      let consumptionValue = 0;
      for (const line of dto.consumptionLines) {
        const ingredient = ingredientByskuId.get(line.ingredientSkuId)!;
        const unitCost = Number(ingredient.unitCost);
        consumptionValue += line.actualQty * unitCost;
        await tx.$executeRaw`
          INSERT INTO production_consumption (
            tenant_id, consumption_id, batch_id, ingredient_sku_id, planned_qty, actual_qty, unit_cost
          ) VALUES (
            ${tenantId}::uuid, ${randomUUID()}::uuid, ${batchId}::uuid, ${line.ingredientSkuId}::uuid,
            ${line.plannedQty}, ${line.actualQty}, ${unitCost}
          )
        `;
      }

      return { batchId, consumptionValue, outputValue: batchCost, plantId: dto.plantId };
    });

    if (batchStatus === 'CLOSED') {
      await this.postLedgerEvents(tenantId, result.batchId, result.plantId, result.consumptionValue, result.outputValue);
    }

    return {
      clientEventId,
      status: batchStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'ACKED',
      serverEntityId: result.batchId,
      yieldPercent,
      reasonCode: batchStatus === 'NEEDS_REVIEW' ? 'RECIPE_VERSION_NOT_APPROVED' : undefined,
      message:
        batchStatus === 'NEEDS_REVIEW'
          ? 'Recipe version is not fully approved (lab/finance/executive) — batch recorded but not posted to the ledger; routed for review.'
          : costReviewStatus === 'PENDING_APPROVAL'
            ? `Batch closed and posted to the ledger; cost (${batchCost.toFixed(2)}) exceeds the review threshold — flagged for retrospective sign-off, not blocked.`
            : yieldAlertTriggered
              ? `Batch closed; yield ${yieldPercent.toFixed(2)}% is below the ${Number(recipeVersion.yieldThresholdPercent)}% threshold — flagged for investigation (not blocked).`
              : 'Batch closed and posted to the ledger.',
    };
  }

  private async postLedgerEvents(
    tenantId: string,
    batchId: string,
    plantId: string,
    consumptionValue: number,
    outputValue: number,
  ): Promise<void> {
    // Each event's `event_id` doubles as journal_entries.source_event_id
    // (idempotency key for the ledger), so it must be a real UUID — it does
    // NOT need to be deterministic across retries: postLedgerEvents is only
    // ever invoked once per successful closeProductionBatch call, and that
    // outer call is already the idempotency boundary (guarded by
    // production_batches.client_event_id at the top of this method, same as
    // ProcurementService.createGoodsReceipt). A random UUID per event is
    // therefore correct, not a shortcut.
    await this.kafka.publish(tenantId, 'batch.consumption_recorded.v1', {
      event_id: randomUUID(),
      tenant_id: tenantId,
      batch_id: batchId,
      plant_id: plantId,
      consumption_value: consumptionValue,
      posted_at: new Date().toISOString(),
    });

    await this.kafka.publish(tenantId, 'batch.output_recorded.v1', {
      event_id: randomUUID(),
      tenant_id: tenantId,
      batch_id: batchId,
      plant_id: plantId,
      output_value: outputValue,
      posted_at: new Date().toISOString(),
    });

    const variance = consumptionValue - outputValue;
    if (Math.abs(variance) < 0.005) return; // effectively zero — nothing to clear

    const eventType = variance > 0 ? 'batch.yield_variance_unfavorable.v1' : 'batch.yield_variance_favorable.v1';
    await this.kafka.publish(tenantId, eventType, {
      event_id: randomUUID(),
      tenant_id: tenantId,
      batch_id: batchId,
      plant_id: plantId,
      variance_value: Math.abs(variance),
      posted_at: new Date().toISOString(),
    });
  }

  /**
   * Retrospective sign-off on a high-cost batch (migration
   * 024_manufacturing_batch_cost_review.sql) — unlike PO/journal-entry/
   * maintenance approve, this NEVER gates a posting: the batch's GL
   * events already went out, unconditionally, at close time. Approving
   * just records that someone with real authority reviewed it;
   * rejecting flags it for investigation — neither undoes anything
   * already posted. A real correction, if one turns out to be needed,
   * is a manual reversing journal entry (accounting-service's existing
   * path), same as every other correction in this ledger.
   */
  async approveBatchCostReview(tenantId: string, batchId: string, userId: string | undefined) {
    const batch = await this.getBatchForReview(tenantId, batchId);

    const result = await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'MANUFACTURING',
      transactionType: 'BATCH_COST',
      recordIdRef: batchId,
      amount: Number(batch.batch_cost),
      stage: batch.current_approval_stage,
    });

    if (result.hasNextStage) {
      await this.prisma.forTenant(tenantId, (tx) =>
        tx.$executeRaw`
          UPDATE production_batches SET current_approval_stage = ${batch.current_approval_stage + 1}
          WHERE tenant_id = ${tenantId}::uuid AND batch_id = ${batchId}::uuid
        `,
      );
    } else {
      await this.prisma.forTenant(tenantId, (tx) =>
        tx.$executeRaw`
          UPDATE production_batches SET cost_review_status = 'APPROVED', pending_approver_role_id = NULL
          WHERE tenant_id = ${tenantId}::uuid AND batch_id = ${batchId}::uuid
        `,
      );
    }

    return this.getBatchForReview(tenantId, batchId);
  }

  async rejectBatchCostReview(tenantId: string, batchId: string, userId: string | undefined) {
    const batch = await this.getBatchForReview(tenantId, batchId);

    // Same approval-tier gate as approving — the identical reasoning
    // procurement-service's rejectPurchaseOrder documents.
    await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'MANUFACTURING',
      transactionType: 'BATCH_COST',
      recordIdRef: batchId,
      amount: Number(batch.batch_cost),
      stage: batch.current_approval_stage,
    });

    await this.prisma.forTenant(tenantId, (tx) =>
      tx.$executeRaw`
        UPDATE production_batches SET cost_review_status = 'REJECTED', pending_approver_role_id = NULL
        WHERE tenant_id = ${tenantId}::uuid AND batch_id = ${batchId}::uuid
      `,
    );

    return this.getBatchForReview(tenantId, batchId);
  }

  private async getBatchForReview(
    tenantId: string,
    batchId: string,
  ): Promise<{ batch_cost: string; cost_review_status: string; current_approval_stage: number }> {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ batch_cost: string; cost_review_status: string; current_approval_stage: number }>>`
        SELECT batch_cost, cost_review_status, current_approval_stage FROM production_batches
        WHERE tenant_id = ${tenantId}::uuid AND batch_id = ${batchId}::uuid
      `,
    );
    if (rows.length === 0) throw new NotFoundException(`Production batch ${batchId} not found`);
    if (rows[0].cost_review_status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Production batch ${batchId} is not pending cost review (cost_review_status=${rows[0].cost_review_status})`,
      );
    }
    return rows[0];
  }
}
