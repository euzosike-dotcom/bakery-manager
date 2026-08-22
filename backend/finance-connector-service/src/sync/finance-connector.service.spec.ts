import { FinanceConnectorService } from './finance-connector.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>, tenants: Array<{ tenantId: string }> = [{ tenantId: TENANT }]): PrismaService {
  return {
    tenantRegistry: { findMany: jest.fn().mockResolvedValue(tenants) },
    forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
}

const QUEUE_ROW = {
  queueId: 'queue-1',
  sourceModule: 'ACCOUNTING',
  sourceRecordId: 'journal-entry-1',
  transactionType: 'MANUAL_JOURNAL_ENTRY',
  retryCount: 0,
};

const JOURNAL_ENTRY = {
  tenantId: TENANT,
  journalEntryId: 'journal-entry-1',
  lines: [
    { accountCode: '5100', debitAmount: { toString: () => '30000.00' }, creditAmount: { toString: () => '0.00' }, costCenterPlantId: null },
    { accountCode: '1000', debitAmount: { toString: () => '0.00' }, creditAmount: { toString: () => '30000.00' }, costCenterPlantId: null },
  ],
};

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    journalEntry: { findUnique: jest.fn().mockResolvedValue(JOURNAL_ENTRY) },
    externalLedgerPosting: {
      upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
    },
    integrationQueue: {
      findMany: jest.fn().mockResolvedValue([QUEUE_ROW]),
      update: jest.fn().mockResolvedValue(undefined),
    },
    failedPostingReview: { create: jest.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('FinanceConnectorService.pollAllTenants', () => {
  it('polls only tenants configured for the CUSTOM_MODULE connector, and processes each one', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx, [{ tenantId: TENANT }]);
    const service = new FinanceConnectorService(prisma);

    await service.pollAllTenants();

    expect(prisma.tenantRegistry.findMany).toHaveBeenCalledWith({
      where: { financeConnectorType: 'CUSTOM_MODULE' },
      select: { tenantId: true },
    });
    expect(tx.integrationQueue.findMany).toHaveBeenCalled();
  });
});

describe('FinanceConnectorService.processQueueRow — happy path', () => {
  it('builds lines_json from the journal entry, records the posting, and marks the queue row POSTED', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = new FinanceConnectorService(prisma);

    await service.pollTenant(TENANT);

    expect(tx.externalLedgerPosting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
        create: expect.objectContaining({
          journalEntryId: 'journal-entry-1',
          linesJson: [
            { accountCode: '5100', debitAmount: '30000.00', creditAmount: '0.00', costCenterPlantId: null },
            { accountCode: '1000', debitAmount: '0.00', creditAmount: '30000.00', costCenterPlantId: null },
          ],
        }),
      }),
    );
    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { queueStatus: 'POSTED', postedExternalId: expect.stringMatching(/^CUSTOM-/) },
    });
    expect(tx.failedPostingReview.create).not.toHaveBeenCalled();
  });

  it('is idempotent: when the row was already synced by a prior crashed attempt, the queue is marked POSTED with the ALREADY-STORED external id, not a freshly generated one', async () => {
    // Simulates upsert hitting its update branch (row already exists) —
    // the real DB would return the pre-existing row untouched by `update:
    // {}`, not the newly-generated `create` payload this test's default
    // mock stands in for.
    const alreadyStoredId = 'CUSTOM-already-synced-id';
    const tx = makeTx({
      externalLedgerPosting: {
        upsert: jest.fn().mockResolvedValue({ postedExternalId: alreadyStoredId }),
      },
    });
    const prisma = makePrisma(tx);
    const service = new FinanceConnectorService(prisma);

    await service.pollTenant(TENANT);

    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { queueStatus: 'POSTED', postedExternalId: alreadyStoredId },
    });
  });
});

describe('FinanceConnectorService.processQueueRow — failure and retry escalation', () => {
  it('increments retry_count and leaves the row PENDING when under the retry threshold', async () => {
    const tx = makeTx({
      journalEntry: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const prisma = makePrisma(tx);
    const service = new FinanceConnectorService(prisma);

    await service.pollTenant(TENANT);

    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { retryCount: 1, lastErrorMessage: expect.stringContaining('journal_entries row not found') },
    });
    expect(tx.failedPostingReview.create).not.toHaveBeenCalled();
  });

  it('escalates to FAILED and opens a failed_posting_review row once retry_count reaches the max', async () => {
    const tx = makeTx({
      journalEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      integrationQueue: {
        findMany: jest.fn().mockResolvedValue([{ ...QUEUE_ROW, retryCount: 2 }]),
        update: jest.fn().mockResolvedValue(undefined),
      },
    });
    const prisma = makePrisma(tx);
    const service = new FinanceConnectorService(prisma);

    await service.pollTenant(TENANT);

    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { queueStatus: 'FAILED', retryCount: 3, lastErrorMessage: expect.any(String) },
    });
    expect(tx.failedPostingReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: TENANT, queueId: 'queue-1', reviewStatus: 'OPEN' }),
      }),
    );
  });
});
