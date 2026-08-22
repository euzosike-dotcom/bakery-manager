import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { ProductionService } from './production.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makeKafka(): KafkaProducerService {
  return { publish: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaProducerService;
}

// Not exercised by closeProductionBatch itself (that path reads
// approval_matrix via a plain tx.$queryRaw, not this client — see
// production.service.ts's comment) — only present because
// approveBatchCostReview/rejectBatchCostReview need a real constructor
// argument.
function makePostingAuthority(): PostingAuthorityClient {
  return { checkApprovalAuthority: jest.fn() } as unknown as PostingAuthorityClient;
}

const APPROVED_RECIPE_VERSION = {
  ingredients: [{ ingredientSkuId: 'flour-sku', unitCost: 480 }],
  recipe: { skuId: 'loaf-sku' },
  approvalStatus: 'APPROVED',
  yieldThresholdPercent: 90,
  standardCost: 500,
};

function baseDto(overrides: Record<string, unknown> = {}) {
  return {
    batchNumber: 'BATCH-1',
    plantId: 'plant-1',
    skuId: 'loaf-sku',
    recipeVersionId: 'rv-1',
    plannedQty: 1000,
    actualOutputQty: 870,
    actualWasteQty: 0,
    consumptionLines: [{ ingredientSkuId: 'flour-sku', plannedQty: 350, actualQty: 348 }],
    ...overrides,
  };
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    productionBatch: { findUnique: jest.fn().mockResolvedValue(null) },
    recipeVersion: { findUnique: jest.fn().mockResolvedValue(APPROVED_RECIPE_VERSION) },
    productSku: { findUnique: jest.fn().mockResolvedValue({ standardWeightKg: null }) },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    // No approval_matrix band matches by default — every existing test
    // below predates cost review entirely and expects NOT_REQUIRED.
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('ProductionService.closeProductionBatch — yield calculation', () => {
  it('computes yield as output/input * 100 directly when the output SKU has no standardWeightKg (already mass-based)', async () => {
    const tx = makeTx({ productSku: { findUnique: jest.fn().mockResolvedValue({ standardWeightKg: null }) } });
    const service = new ProductionService(makePrisma(tx), makeKafka(), makePostingAuthority());

    // 870 kg output / 348 kg input * 100 = 250% if actualOutputQty were
    // treated as unit count against a mass-based SKU, but here the output SKU
    // itself is mass-based (standardWeightKg null), so actualOutputQty (870)
    // is already in KG.
    const result = await service.closeProductionBatch(TENANT, baseDto(), { createdOffline: false });

    expect(result.yieldPercent).toBeCloseTo((870 / 348) * 100, 5);
  });

  it('converts output through standardWeightKg before computing yield when the output SKU is unit-denominated', async () => {
    // The documented real bug this guards against: 870 discrete loaves
    // against 348kg of ingredients is meaningless as a raw ratio (250%)
    // unless converted through the SKU's per-unit mass first.
    const tx = makeTx({ productSku: { findUnique: jest.fn().mockResolvedValue({ standardWeightKg: 0.5 }) } });
    const service = new ProductionService(makePrisma(tx), makeKafka(), makePostingAuthority());

    const result = await service.closeProductionBatch(TENANT, baseDto({ actualOutputQty: 870 }), { createdOffline: false });

    const expectedOutputMassKg = 870 * 0.5; // 435kg
    expect(result.yieldPercent).toBeCloseTo((expectedOutputMassKg / 348) * 100, 5);
  });

  it('routes to NEEDS_REVIEW and skips ledger posting when the pinned recipe version is not APPROVED', async () => {
    const tx = makeTx({
      recipeVersion: { findUnique: jest.fn().mockResolvedValue({ ...APPROVED_RECIPE_VERSION, approvalStatus: 'DRAFT' }) },
    });
    const kafka = makeKafka();
    const service = new ProductionService(makePrisma(tx), kafka, makePostingAuthority());

    const result = await service.closeProductionBatch(TENANT, baseDto(), { createdOffline: false });

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasonCode).toBe('RECIPE_VERSION_NOT_APPROVED');
    expect(kafka.publish).not.toHaveBeenCalled();
  });

  it('closes and posts even when yield is below threshold, only flagging it (never blocking)', async () => {
    // 300kg output-equivalent / 348kg input = ~86.2%, below the 90% threshold.
    const tx = makeTx();
    const kafka = makeKafka();
    const service = new ProductionService(makePrisma(tx), kafka, makePostingAuthority());

    const result = await service.closeProductionBatch(TENANT, baseDto({ actualOutputQty: 300 }), { createdOffline: false });

    expect(result.status).toBe('ACKED');
    expect(result.message).toMatch(/below the 90% threshold/);
    expect(kafka.publish).toHaveBeenCalledWith(TENANT, 'batch.consumption_recorded.v1', expect.anything());
  });

  it('emits an UNFAVORABLE variance event when consumption value exceeds output value', async () => {
    // 348kg @ 480/kg = 167040 consumption value; 870 output @ standardCost
    // 500 = flagged below via a cheap standardCost to force consumption > output.
    const tx = makeTx({
      recipeVersion: { findUnique: jest.fn().mockResolvedValue({ ...APPROVED_RECIPE_VERSION, standardCost: 1 }) },
    });
    const kafka = makeKafka();
    const service = new ProductionService(makePrisma(tx), kafka, makePostingAuthority());

    await service.closeProductionBatch(TENANT, baseDto(), { createdOffline: false });

    expect(kafka.publish).toHaveBeenCalledWith(TENANT, 'batch.yield_variance_unfavorable.v1', expect.anything());
  });

  it('emits a FAVORABLE variance event when output value exceeds consumption value', async () => {
    const tx = makeTx({
      recipeVersion: { findUnique: jest.fn().mockResolvedValue({ ...APPROVED_RECIPE_VERSION, standardCost: 10000 }) },
    });
    const kafka = makeKafka();
    const service = new ProductionService(makePrisma(tx), kafka, makePostingAuthority());

    await service.closeProductionBatch(TENANT, baseDto(), { createdOffline: false });

    expect(kafka.publish).toHaveBeenCalledWith(TENANT, 'batch.yield_variance_favorable.v1', expect.anything());
  });

  it('rejects a consumption line whose SKU is not part of the pinned recipe version', async () => {
    const tx = makeTx();
    const service = new ProductionService(makePrisma(tx), makeKafka(), makePostingAuthority());

    await expect(
      service.closeProductionBatch(
        TENANT,
        baseDto({ consumptionLines: [{ ingredientSkuId: 'not-an-ingredient', plannedQty: 10, actualQty: 10 }] }),
        { createdOffline: false },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s when the pinned recipe version does not exist', async () => {
    const tx = makeTx({ recipeVersion: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = new ProductionService(makePrisma(tx), makeKafka(), makePostingAuthority());

    await expect(service.closeProductionBatch(TENANT, baseDto(), { createdOffline: false })).rejects.toThrow(NotFoundException);
  });

  it('is idempotent: replaying an already-applied clientEventId returns the original result', async () => {
    const tx = makeTx({
      productionBatch: {
        findUnique: jest.fn().mockResolvedValue({ batchStatus: 'CLOSED', batchId: 'existing-batch', yieldPercent: 95.5 }),
      },
    });
    const kafka = makeKafka();
    const service = new ProductionService(makePrisma(tx), kafka, makePostingAuthority());

    const result = await service.closeProductionBatch(TENANT, baseDto({ clientEventId: 'replayed-event' }), {
      createdOffline: false,
    });

    expect(result).toEqual({
      clientEventId: 'replayed-event',
      status: 'ACKED',
      serverEntityId: 'existing-batch',
      yieldPercent: 95.5,
      message: 'Already applied (idempotent replay)',
    });
    expect(kafka.publish).not.toHaveBeenCalled();
  });
});

describe('ProductionService.findAllBatches — BigInt sync_seq serialization', () => {
  // Regression test for a real bug found during this platform's build
  // (docs/RUNBOOK.md's "approval_matrix expansion" section): $queryRaw
  // returns the bigserial sync_seq column as a native JS BigInt, which
  // JSON.stringify (and therefore Nest's default response serializer)
  // throws on at response-send time, not compile time — a type checker
  // cannot catch it. crm-service's ActivitiesService.findAll hit the
  // identical gotcha first (see its own regression test); this is the
  // first GET endpoint in manufacturing-service returning a sync_seq
  // column at all.
  it('converts sync_seq from BigInt to string so the response is JSON-serializable', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        { batch_id: 'batch-1', sync_seq: 42n },
        { batch_id: 'batch-2', sync_seq: null },
      ]),
    };
    const service = new ProductionService(makePrisma(tx), makeKafka(), makePostingAuthority());

    const result = await service.findAllBatches(TENANT);

    expect(result[0].sync_seq).toBe('42');
    expect(typeof result[0].sync_seq).toBe('string');
    expect(result[1].sync_seq).toBeNull();
    // The real assertion: JSON.stringify must not throw (this is exactly
    // what failed live — "Do not know how to serialize a BigInt").
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
