import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CreateGoodsReceiptDto, SyncPushResultDto } from './dto/goods-receipt.dto';
import { RejectPurchaseOrderDto } from './dto/purchase-order-approval.dto';

export interface CreateGoodsReceiptOptions {
  createdOffline: boolean;
}

@Injectable()
export class ProcurementService {
  private readonly logger = new Logger(ProcurementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  listSuppliers(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.supplier.findMany());
  }

  listPurchaseOrders(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.purchaseOrder.findMany({ include: { lines: true, supplier: true } }),
    );
  }

  async getPurchaseOrder(tenantId: string, poId: string) {
    const po = await this.prisma.forTenant(tenantId, (tx) =>
      tx.purchaseOrder.findUnique({ where: { tenantId_poId: { tenantId, poId } }, include: { lines: true } }),
    );
    if (!po) throw new NotFoundException(`Purchase order ${poId} not found`);
    return po;
  }

  /**
   * Creates a Goods Receipt + lines, validates against remaining PO quantity
   * (Conflict Resolution Matrix scenario #3 in docs/SDD.md §2.3), and — if
   * valid — publishes grn.posted.v1 per accepted line so the ledger-service
   * can post the Dr Raw Material Inventory / Cr Accounts Payable entry.
   *
   * Idempotent on `dto.clientEventId`: re-submitting the same offline event
   * (e.g. a retried sync push) is a no-op that returns the original result.
   *
   * KNOWN SIMPLIFICATION: Kafka publish happens synchronously right after
   * the DB commit, not inside a transactional outbox. If the broker is
   * briefly unavailable the GRN is still safely persisted (posting_status
   * stays PENDING) but the ledger event is not retried automatically yet —
   * a transactional outbox + relay is the correct next hardening step
   * before this touches production financial data.
   */
  async createGoodsReceipt(
    tenantId: string,
    dto: CreateGoodsReceiptDto,
    options: CreateGoodsReceiptOptions,
  ): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.goodsReceipt.findUnique({
        where: { tenantId_clientEventId: { tenantId, clientEventId } },
      }),
    );
    if (existing) {
      this.logger.log(`GRN clientEventId=${clientEventId} already applied — idempotent no-op`);
      return {
        clientEventId,
        status: existing.postingStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'ACKED',
        serverEntityId: existing.grnId,
        message: 'Already applied (idempotent replay)',
      };
    }

    const warehouse = await this.prisma.forTenant(tenantId, (tx) =>
      tx.warehouse.findUnique({ where: { tenantId_warehouseId: { tenantId, warehouseId: dto.warehouseId } } }),
    );
    if (!warehouse) throw new NotFoundException(`Warehouse ${dto.warehouseId} not found`);

    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const poLines = await tx.purchaseOrderLine.findMany({
        where: { tenantId, poId: dto.poId, poLineId: { in: dto.lines.map((l) => l.poLineId) } },
      });
      const poLineById = new Map(poLines.map((l) => [l.poLineId, l]));

      let overReceipt = false;
      for (const line of dto.lines) {
        const poLine = poLineById.get(line.poLineId);
        if (!poLine) throw new NotFoundException(`PO line ${line.poLineId} not found on PO ${dto.poId}`);
        const alreadyReceived = Number(poLine.receivedQty);
        const ordered = Number(poLine.orderedQty);
        if (alreadyReceived + line.receivedQty > ordered) {
          overReceipt = true;
        }
      }

      const grnId = dto.grnId ?? randomUUID();
      const postingStatus = overReceipt ? 'NEEDS_REVIEW' : 'PENDING';

      await tx.$executeRaw`
        INSERT INTO goods_receipts (
          tenant_id, grn_id, grn_number, po_id, receipt_date, warehouse_id,
          receiver_user_id, qc_status, posting_status, client_event_id,
          device_id, created_offline
        ) VALUES (
          ${tenantId}::uuid, ${grnId}::uuid, ${dto.grnNumber}, ${dto.poId}::uuid,
          ${dto.receiptDate ? new Date(dto.receiptDate) : new Date()}, ${dto.warehouseId}::uuid,
          ${dto.receiverUserId ?? null}::uuid, 'PENDING', ${postingStatus}, ${clientEventId}::uuid,
          ${dto.deviceId ?? null}::uuid, ${options.createdOffline}
        )
      `;

      const lineIds: { poLineId: string; grnLineId: string; acceptedQty: number; unitCost: number }[] = [];
      for (const line of dto.lines) {
        const grnLineId = line.grnLineId ?? randomUUID();
        // The line's own client_event_id column exists for schema parity
        // with the original module register, but idempotency for the whole
        // GRN (including all its lines) is already decided by the
        // goods_receipts.client_event_id check above, before this loop is
        // ever reached — so a fresh UUID here is safe, not a shortcut.
        await tx.$executeRaw`
          INSERT INTO goods_receipt_lines (
            tenant_id, grn_line_id, grn_id, po_line_id, received_qty,
            accepted_qty, rejected_qty, uom, unit_cost, client_event_id
          ) VALUES (
            ${tenantId}::uuid, ${grnLineId}::uuid, ${grnId}::uuid, ${line.poLineId}::uuid,
            ${line.receivedQty}, ${line.acceptedQty}, ${line.rejectedQty}, ${line.uom},
            ${line.unitCost}, ${randomUUID()}::uuid
          )
        `;
        lineIds.push({ poLineId: line.poLineId, grnLineId, acceptedQty: line.acceptedQty, unitCost: line.unitCost });

        if (!overReceipt) {
          const poLine = poLineById.get(line.poLineId)!;
          const newReceivedQty = Number(poLine.receivedQty) + line.receivedQty;
          const newStatus = newReceivedQty >= Number(poLine.orderedQty) ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED';
          await tx.$executeRaw`
            UPDATE purchase_order_lines
            SET received_qty = ${newReceivedQty}, line_status = ${newStatus}
            WHERE tenant_id = ${tenantId}::uuid AND po_line_id = ${line.poLineId}::uuid
          `;
        }
      }

      return { grnId, postingStatus, lineIds, plantId: warehouse.plantId };
    });

    if (result.postingStatus !== 'NEEDS_REVIEW') {
      for (const line of result.lineIds) {
        const acceptedValue = line.acceptedQty * line.unitCost;
        if (acceptedValue <= 0) continue;
        await this.kafka.publish(tenantId, 'grn.posted.v1', {
          event_id: line.grnLineId,
          tenant_id: tenantId,
          grn_id: result.grnId,
          grn_line_id: line.grnLineId,
          po_line_id: line.poLineId,
          plant_id: result.plantId,
          accepted_qty: line.acceptedQty,
          unit_cost: line.unitCost,
          accepted_value: acceptedValue,
          posted_at: new Date().toISOString(),
        });
      }
      await this.prisma.forTenant(tenantId, (tx) =>
        tx.$executeRaw`UPDATE goods_receipts SET posting_status = 'POSTED' WHERE tenant_id = ${tenantId}::uuid AND grn_id = ${result.grnId}::uuid`,
      );
    }

    return {
      clientEventId,
      status: result.postingStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'ACKED',
      serverEntityId: result.grnId,
      reasonCode: result.postingStatus === 'NEEDS_REVIEW' ? 'OVER_RECEIPT_VS_PO_LINE' : undefined,
      message:
        result.postingStatus === 'NEEDS_REVIEW'
          ? 'Received quantity exceeds remaining PO line quantity — routed to Variance Review, not posted to inventory/ledger yet.'
          : 'GRN posted; grn.posted.v1 emitted per accepted line.',
    };
  }

  /**
   * Approves a PO at its current approval_matrix stage. Delegates the
   * actual "who is allowed to approve this amount" decision entirely to
   * governance-service's checkApprovalAuthority — this method only acts on
   * the result (advance the stage counter, or finalize to APPROVED).
   */
  async approvePurchaseOrder(tenantId: string, poId: string, userId: string | undefined) {
    const po = await this.prisma.forTenant(tenantId, (tx) =>
      tx.purchaseOrder.findUnique({ where: { tenantId_poId: { tenantId, poId } } }),
    );
    if (!po) throw new NotFoundException(`Purchase order ${poId} not found`);
    if (po.approvalStatus !== 'PENDING') {
      throw new BadRequestException(`Purchase order ${poId} is not pending approval (status=${po.approvalStatus})`);
    }

    const result = await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'PROCUREMENT',
      transactionType: 'PURCHASE_ORDER',
      recordIdRef: poId,
      amount: Number(po.totalPoValue),
      plantId: po.plantId,
      stage: po.currentApprovalStage,
    });

    const nextStage = po.currentApprovalStage + 1;
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.purchaseOrder.update({
        where: { tenantId_poId: { tenantId, poId } },
        data: result.hasNextStage
          ? { currentApprovalStage: nextStage }
          : { approvalStatus: 'APPROVED', pendingApproverRoleId: null },
      }),
    );
  }

  /**
   * Rejecting requires the SAME approval-tier gate as approving — a
   * Procurement Manager can reject what they could have approved, but not
   * reject a PO that's above their tier (that's Finance's call to make,
   * even the rejection).
   */
  async rejectPurchaseOrder(
    tenantId: string,
    poId: string,
    userId: string | undefined,
    dto: RejectPurchaseOrderDto,
  ) {
    const po = await this.prisma.forTenant(tenantId, (tx) =>
      tx.purchaseOrder.findUnique({ where: { tenantId_poId: { tenantId, poId } } }),
    );
    if (!po) throw new NotFoundException(`Purchase order ${poId} not found`);
    if (po.approvalStatus !== 'PENDING') {
      throw new BadRequestException(`Purchase order ${poId} is not pending approval (status=${po.approvalStatus})`);
    }

    await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'PROCUREMENT',
      transactionType: 'PURCHASE_ORDER',
      recordIdRef: poId,
      amount: Number(po.totalPoValue),
      plantId: po.plantId,
      stage: po.currentApprovalStage,
    });

    this.logger.log(`PO ${poId} rejected by userId=${userId} reasonCode=${dto.reasonCode}`);
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.purchaseOrder.update({
        where: { tenantId_poId: { tenantId, poId } },
        data: { approvalStatus: 'REJECTED' },
      }),
    );
  }
}
