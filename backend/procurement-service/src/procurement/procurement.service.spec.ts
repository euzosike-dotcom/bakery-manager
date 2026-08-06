import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { ProcurementService } from './procurement.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makeKafka(): KafkaProducerService {
  return { publish: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaProducerService;
}

function makePostingAuthority(overrides: Partial<PostingAuthorityClient> = {}): PostingAuthorityClient {
  return {
    checkApprovalAuthority: jest.fn().mockResolvedValue({ authorized: true, hasNextStage: false }),
    ...overrides,
  } as unknown as PostingAuthorityClient;
}

describe('ProcurementService.createGoodsReceipt (over-receipt detection)', () => {
  const warehouse = { warehouseId: 'wh-1', plantId: 'plant-1' };

  it('posts and publishes grn.posted.v1 when the accepted quantity is within the remaining PO line quantity', async () => {
    const poLine = { poLineId: 'line-1', orderedQty: 100, receivedQty: 20 };
    const tx = {
      goodsReceipt: { findUnique: jest.fn().mockResolvedValue(null) },
      warehouse: { findUnique: jest.fn().mockResolvedValue(warehouse) },
      purchaseOrderLine: { findMany: jest.fn().mockResolvedValue([poLine]) },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
    };
    const kafka = makeKafka();
    const service = new ProcurementService(makePrisma(tx), kafka, makePostingAuthority());

    const result = await service.createGoodsReceipt(
      TENANT,
      {
        grnNumber: 'GRN-1',
        poId: 'po-1',
        warehouseId: 'wh-1',
        lines: [{ poLineId: 'line-1', receivedQty: 30, acceptedQty: 30, rejectedQty: 0, uom: 'KG', unitCost: 10 }],
      },
      { createdOffline: false },
    );

    expect(result.status).toBe('ACKED');
    expect(result.reasonCode).toBeUndefined();
    expect(kafka.publish).toHaveBeenCalledWith(TENANT, 'grn.posted.v1', expect.objectContaining({ accepted_value: 300 }));
  });

  it('routes to NEEDS_REVIEW without posting when accepted quantity exceeds remaining PO line quantity', async () => {
    // Already received 90 of 100 ordered — receiving 30 more overshoots by 20.
    const poLine = { poLineId: 'line-1', orderedQty: 100, receivedQty: 90 };
    const tx = {
      goodsReceipt: { findUnique: jest.fn().mockResolvedValue(null) },
      warehouse: { findUnique: jest.fn().mockResolvedValue(warehouse) },
      purchaseOrderLine: { findMany: jest.fn().mockResolvedValue([poLine]) },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
    };
    const kafka = makeKafka();
    const service = new ProcurementService(makePrisma(tx), kafka, makePostingAuthority());

    const result = await service.createGoodsReceipt(
      TENANT,
      {
        grnNumber: 'GRN-2',
        poId: 'po-1',
        warehouseId: 'wh-1',
        lines: [{ poLineId: 'line-1', receivedQty: 30, acceptedQty: 30, rejectedQty: 0, uom: 'KG', unitCost: 10 }],
      },
      { createdOffline: false },
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasonCode).toBe('OVER_RECEIPT_VS_PO_LINE');
    expect(kafka.publish).not.toHaveBeenCalled();
  });

  it('is idempotent: replaying an already-applied clientEventId returns the original result without re-inserting', async () => {
    const tx = {
      goodsReceipt: {
        findUnique: jest.fn().mockResolvedValue({ postingStatus: 'PENDING', grnId: 'existing-grn' }),
      },
      warehouse: { findUnique: jest.fn() },
    };
    const kafka = makeKafka();
    const service = new ProcurementService(makePrisma(tx), kafka, makePostingAuthority());

    const result = await service.createGoodsReceipt(
      TENANT,
      { grnNumber: 'GRN-3', poId: 'po-1', warehouseId: 'wh-1', clientEventId: 'replayed-event', lines: [] },
      { createdOffline: false },
    );

    expect(result).toEqual({
      clientEventId: 'replayed-event',
      status: 'ACKED',
      serverEntityId: 'existing-grn',
      message: 'Already applied (idempotent replay)',
    });
    expect(tx.warehouse.findUnique).not.toHaveBeenCalled();
    expect(kafka.publish).not.toHaveBeenCalled();
  });
});

describe('ProcurementService.approvePurchaseOrder / rejectPurchaseOrder', () => {
  it('approvePurchaseOrder finalizes to APPROVED when the authority check reports no further stage', async () => {
    const po = { poId: 'po-1', approvalStatus: 'PENDING', totalPoValue: 320000, plantId: 'plant-1', currentApprovalStage: 1 };
    const tx = {
      purchaseOrder: {
        findUnique: jest.fn().mockResolvedValue(po),
        update: jest.fn().mockImplementation(({ data }) => ({ ...po, ...data })),
      },
    };
    const postingAuthority = makePostingAuthority({
      checkApprovalAuthority: jest.fn().mockResolvedValue({ authorized: true, hasNextStage: false }),
    });
    const service = new ProcurementService(makePrisma(tx), makeKafka(), postingAuthority);

    const result = await service.approvePurchaseOrder(TENANT, 'po-1', 'user-1');

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { approvalStatus: 'APPROVED', pendingApproverRoleId: null } }),
    );
    expect(result.approvalStatus).toBe('APPROVED');
  });

  it('approvePurchaseOrder advances the stage counter instead of finalizing when hasNextStage is true', async () => {
    const po = { poId: 'po-1', approvalStatus: 'PENDING', totalPoValue: 900000, plantId: 'plant-1', currentApprovalStage: 1 };
    const tx = {
      purchaseOrder: {
        findUnique: jest.fn().mockResolvedValue(po),
        update: jest.fn().mockImplementation(({ data }) => ({ ...po, ...data })),
      },
    };
    const postingAuthority = makePostingAuthority({
      checkApprovalAuthority: jest.fn().mockResolvedValue({ authorized: true, hasNextStage: true }),
    });
    const service = new ProcurementService(makePrisma(tx), makeKafka(), postingAuthority);

    await service.approvePurchaseOrder(TENANT, 'po-1', 'user-1');

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: { currentApprovalStage: 2 } }));
  });

  it('approvePurchaseOrder rejects a PO that is not PENDING without calling the authority check', async () => {
    const po = { poId: 'po-1', approvalStatus: 'APPROVED', totalPoValue: 320000, plantId: 'plant-1', currentApprovalStage: 1 };
    const tx = { purchaseOrder: { findUnique: jest.fn().mockResolvedValue(po) } };
    const postingAuthority = makePostingAuthority();
    const service = new ProcurementService(makePrisma(tx), makeKafka(), postingAuthority);

    await expect(service.approvePurchaseOrder(TENANT, 'po-1', 'user-1')).rejects.toThrow(BadRequestException);
    expect(postingAuthority.checkApprovalAuthority).not.toHaveBeenCalled();
  });

  it('approvePurchaseOrder 404s on a missing PO', async () => {
    const tx = { purchaseOrder: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new ProcurementService(makePrisma(tx), makeKafka(), makePostingAuthority());

    await expect(service.approvePurchaseOrder(TENANT, 'missing-po', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('rejectPurchaseOrder sets REJECTED after the same authority gate as approve', async () => {
    const po = { poId: 'po-1', approvalStatus: 'PENDING', totalPoValue: 320000, plantId: 'plant-1', currentApprovalStage: 1 };
    const tx = {
      purchaseOrder: {
        findUnique: jest.fn().mockResolvedValue(po),
        update: jest.fn().mockImplementation(({ data }) => ({ ...po, ...data })),
      },
    };
    const postingAuthority = makePostingAuthority();
    const service = new ProcurementService(makePrisma(tx), makeKafka(), postingAuthority);

    const result = await service.rejectPurchaseOrder(TENANT, 'po-1', 'user-1', { reasonCode: 'MANUAL_ADJUSTMENT' });

    expect(postingAuthority.checkApprovalAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: 'PROCUREMENT', transactionType: 'PURCHASE_ORDER', amount: 320000 }),
    );
    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: { approvalStatus: 'REJECTED' } }));
    expect(result.approvalStatus).toBe('REJECTED');
  });
});
