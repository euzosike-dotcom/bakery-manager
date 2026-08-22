import { FinanceConnectorService } from './finance-connector.service';
import { PrismaService } from '../common/prisma.service';
import { ConnectorRegistry } from '../connectors/connector-registry';
import { ConnectorStrategy } from '../connectors/connector-strategy';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>, tenants: Array<{ tenantId: string }> = [{ tenantId: TENANT }]): PrismaService {
  return {
    tenantRegistry: { findMany: jest.fn().mockResolvedValue(tenants) },
    forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
}

function makeConnectors(strategy: Partial<ConnectorStrategy> = {}): ConnectorRegistry {
  const post = jest.fn().mockResolvedValue({ postedExternalId: 'CUSTOM-generated-id' });
  const fake: ConnectorStrategy = { externalSystem: 'CUSTOM_MODULE', post, ...strategy };
  return { get: jest.fn().mockReturnValue(fake) } as unknown as ConnectorRegistry;
}

const QUEUE_ROW = {
  queueId: 'queue-1',
  sourceModule: 'ACCOUNTING',
  sourceRecordId: 'journal-entry-1',
  transactionType: 'MANUAL_JOURNAL_ENTRY',
  externalSystem: 'CUSTOM_MODULE',
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
    integrationQueue: {
      findMany: jest.fn().mockResolvedValue([QUEUE_ROW]),
      update: jest.fn().mockResolvedValue(undefined),
    },
    failedPostingReview: { create: jest.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('FinanceConnectorService.pollAllTenants', () => {
  it('polls every tenant with ANY connector configured (not just CUSTOM_MODULE), and processes each one', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx, [{ tenantId: TENANT }]);
    const service = new FinanceConnectorService(prisma, makeConnectors());

    await service.pollAllTenants();

    expect(prisma.tenantRegistry.findMany).toHaveBeenCalledWith({
      where: { financeConnectorType: { not: 'NONE' } },
      select: { tenantId: true },
    });
    expect(tx.integrationQueue.findMany).toHaveBeenCalled();
  });
});

describe('FinanceConnectorService.pollTenant — query shape', () => {
  it('queries PENDING rows for any real external_system, not one hardcoded connector type', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = new FinanceConnectorService(prisma, makeConnectors());

    await service.pollTenant(TENANT);

    expect(tx.integrationQueue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { queueStatus: 'PENDING', externalSystem: { not: 'NONE' } } }),
    );
  });
});

describe('FinanceConnectorService.processQueueRow — happy path', () => {
  it('looks up the connector matching the row\'s own external_system, builds the entry for posting, and marks the queue row POSTED with the returned id', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const connectors = makeConnectors();
    const service = new FinanceConnectorService(prisma, connectors);

    await service.pollTenant(TENANT);

    expect(connectors.get).toHaveBeenCalledWith('CUSTOM_MODULE');
    const strategy = connectors.get('CUSTOM_MODULE');
    expect(strategy.post).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ queueId: 'queue-1' }),
      expect.objectContaining({
        journalEntryId: 'journal-entry-1',
        lines: [
          { accountCode: '5100', debitAmount: '30000.00', creditAmount: '0.00', costCenterPlantId: null },
          { accountCode: '1000', debitAmount: '0.00', creditAmount: '30000.00', costCenterPlantId: null },
        ],
      }),
    );
    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { queueStatus: 'POSTED', postedExternalId: 'CUSTOM-generated-id' },
    });
    expect(tx.failedPostingReview.create).not.toHaveBeenCalled();
  });
});

describe('FinanceConnectorService.processQueueRow — failure and retry escalation', () => {
  it('increments retry_count and leaves the row PENDING when under the retry threshold', async () => {
    const tx = makeTx({
      journalEntry: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const prisma = makePrisma(tx);
    const service = new FinanceConnectorService(prisma, makeConnectors());

    await service.pollTenant(TENANT);

    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { retryCount: 1, lastErrorMessage: expect.stringContaining('journal_entries row not found') },
    });
    expect(tx.failedPostingReview.create).not.toHaveBeenCalled();
  });

  it('a failure inside the connector itself (e.g. an unimplemented provider) escalates through the same retry path as a missing journal entry', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const failingConnectors = makeConnectors({
      post: jest.fn().mockRejectedValue(new Error('No connector implementation exists for external_system=ZOHO_BOOKS yet.')),
    });
    const service = new FinanceConnectorService(prisma, failingConnectors);

    await service.pollTenant(TENANT);

    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { retryCount: 1, lastErrorMessage: expect.stringContaining('No connector implementation exists') },
    });
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
    const service = new FinanceConnectorService(prisma, makeConnectors());

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
