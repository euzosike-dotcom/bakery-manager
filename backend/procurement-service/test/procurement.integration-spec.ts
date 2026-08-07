import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { ProcurementService } from '../src/procurement/procurement.service';
import { PrismaService } from '../src/common/prisma.service';

/**
 * Real Postgres, real generated Prisma client, real `procurement_svc` role
 * — everything the Phase 1/2 unit tests (procurement.service.spec.ts)
 * mocked at the `PrismaService.forTenant` boundary. Those tests prove the
 * BUSINESS LOGIC is right against a fake transaction; these prove the
 * actual SQL (raw `$executeRaw` inserts, Prisma `update` calls, column
 * names, type casts, composite keys) is right against a real database —
 * a class of bug the unit tests structurally cannot catch, since a mock
 * `tx.purchaseOrder.update` never notices a wrong WHERE clause.
 *
 * Only two collaborators are still faked: KafkaProducerService (publishing
 * to a real broker isn't what this file is testing — see the CI Phase 2
 * doc comment on why ledger-service's own PostingEngine.Handle is
 * similarly deferred) and PostingAuthorityClient (re-verifying
 * governance-service's own approval-tier logic needs Keycloak +
 * governance-service running, which this file deliberately does not
 * stand up — that HTTP boundary is exactly what the manual curl
 * verification in docs/RUNBOOK.md's "Approval-matrix enforcement" section
 * already proves end-to-end).
 *
 * No DELETE grant exists for procurement_svc (007_app_role.sql — SELECT/
 * INSERT/UPDATE only), so fixture rows this file inserts are NOT cleaned
 * up afterward. Each run uses a fresh randomUUID() po_id/grn_id, so this
 * is harmless — repeated local runs just accumulate inert TEST-prefixed
 * rows in the dev database, and CI's Postgres service container is torn
 * down with the job regardless.
 */
const TENANT_ID = 'b17d9226-2a43-43eb-8c5e-a923637b23c5'; // METROCK, dev_seed.sql
const SUPPLIER_ID = 'cb6e3879-86db-482e-a602-8a696d2b5a40'; // SUP-001, dev_seed.sql
const PLANT_ID = 'aba294c3-c28c-43a9-a465-67ced442a487'; // PLT-1, dev_seed.sql
const WAREHOUSE_ID = '7840f37a-13eb-4779-aa16-84bf10f7d351'; // WH-PLT1-RM, dev_seed.sql

function makeKafka(): KafkaProducerService {
  return { publish: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaProducerService;
}

function makePostingAuthority(): PostingAuthorityClient {
  return {
    checkApprovalAuthority: jest.fn().mockResolvedValue({ authorized: true, hasNextStage: false }),
  } as unknown as PostingAuthorityClient;
}

describe('ProcurementService against real Postgres', () => {
  let prisma: PrismaService;
  let service: ProcurementService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ProcurementService(prisma, makeKafka(), makePostingAuthority());
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function insertTestPo(overrides: { totalPoValue?: number } = {}) {
    const poId = randomUUID();
    const poLineId = randomUUID();
    await prisma.forTenant(TENANT_ID, (tx) => tx.$executeRaw`
      INSERT INTO purchase_orders (
        tenant_id, po_id, po_number, supplier_id, plant_id, po_date, currency,
        approval_status, po_status, total_po_value, current_approval_stage
      ) VALUES (
        ${TENANT_ID}::uuid, ${poId}::uuid, ${'PO-TEST-' + poId.slice(0, 8)}, ${SUPPLIER_ID}::uuid,
        ${PLANT_ID}::uuid, current_date, 'NGN', 'PENDING', 'OPEN',
        ${overrides.totalPoValue ?? 100000}, 1
      )
    `);
    await prisma.forTenant(TENANT_ID, (tx) => tx.$executeRaw`
      INSERT INTO purchase_order_lines (
        tenant_id, po_line_id, po_id, sku_description, ordered_qty, received_qty, uom, unit_cost
      ) VALUES (
        ${TENANT_ID}::uuid, ${poLineId}::uuid, ${poId}::uuid, 'Integration test line', 100, 90, 'KG', 10
      )
    `);
    return { poId, poLineId };
  }

  it('persists an over-receipt to real Postgres as NEEDS_REVIEW without advancing purchase_order_lines.received_qty', async () => {
    const { poId, poLineId } = await insertTestPo();

    const result = await service.createGoodsReceipt(
      TENANT_ID,
      {
        grnNumber: 'GRN-TEST-' + poId.slice(0, 8),
        poId,
        warehouseId: WAREHOUSE_ID,
        lines: [{ poLineId, receivedQty: 30, acceptedQty: 30, rejectedQty: 0, uom: 'KG', unitCost: 10 }],
      },
      { createdOffline: false },
    );

    expect(result.status).toBe('NEEDS_REVIEW');

    const [grn] = await prisma.forTenant(TENANT_ID, (tx) =>
      tx.$queryRaw<{ posting_status: string }[]>`SELECT posting_status FROM goods_receipts WHERE grn_id = ${result.serverEntityId}::uuid`,
    );
    expect(grn.posting_status).toBe('NEEDS_REVIEW');

    const [line] = await prisma.forTenant(TENANT_ID, (tx) =>
      tx.$queryRaw<{ received_qty: string }[]>`SELECT received_qty FROM purchase_order_lines WHERE po_line_id = ${poLineId}::uuid`,
    );
    // Still 90 — the over-receipt branch deliberately skips the UPDATE.
    expect(Number(line.received_qty)).toBe(90);
  });

  it('is idempotent against real Postgres: replaying the same clientEventId inserts exactly one goods_receipts row', async () => {
    const { poId, poLineId } = await insertTestPo();
    const clientEventId = randomUUID();
    const dto = {
      clientEventId,
      grnNumber: 'GRN-TEST-' + poId.slice(0, 8),
      poId,
      warehouseId: WAREHOUSE_ID,
      lines: [{ poLineId, receivedQty: 5, acceptedQty: 5, rejectedQty: 0, uom: 'KG', unitCost: 10 }],
    };

    const first = await service.createGoodsReceipt(TENANT_ID, dto, { createdOffline: false });
    const second = await service.createGoodsReceipt(TENANT_ID, dto, { createdOffline: false });

    expect(second.serverEntityId).toBe(first.serverEntityId);
    expect(second.message).toBe('Already applied (idempotent replay)');

    const rows = await prisma.forTenant(TENANT_ID, (tx) =>
      tx.$queryRaw<unknown[]>`SELECT grn_id FROM goods_receipts WHERE client_event_id = ${clientEventId}::uuid`,
    );
    expect(rows).toHaveLength(1);
  });

  it('persists an approval to real Postgres: approval_status actually flips to APPROVED', async () => {
    const { poId } = await insertTestPo({ totalPoValue: 50000 });

    const result = await service.approvePurchaseOrder(TENANT_ID, poId, 'integration-test-user');
    expect(result.approvalStatus).toBe('APPROVED');

    const [row] = await prisma.forTenant(TENANT_ID, (tx) =>
      tx.$queryRaw<{ approval_status: string }[]>`SELECT approval_status FROM purchase_orders WHERE po_id = ${poId}::uuid`,
    );
    expect(row.approval_status).toBe('APPROVED');
  });
});
