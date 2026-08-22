import { CustomModuleConnector } from './custom-module.connector';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

const ROW = { queueId: 'queue-1', sourceModule: 'ACCOUNTING', sourceRecordId: 'journal-entry-1', transactionType: 'MANUAL_JOURNAL_ENTRY' };
const ENTRY = {
  journalEntryId: 'journal-entry-1',
  sourceModule: 'ACCOUNTING',
  transactionType: 'MANUAL_JOURNAL_ENTRY',
  lines: [
    { accountCode: '5100', debitAmount: '30000.00', creditAmount: '0.00', costCenterPlantId: null },
    { accountCode: '1000', debitAmount: '0.00', creditAmount: '30000.00', costCenterPlantId: null },
  ],
};

describe('CustomModuleConnector.post', () => {
  it('records the posting with the entry\'s own lines and returns a freshly generated CUSTOM-prefixed id', async () => {
    const tx = { externalLedgerPosting: { upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)) } };
    const connector = new CustomModuleConnector(makePrisma(tx));

    const result = await connector.post(TENANT, ROW, ENTRY);

    expect(tx.externalLedgerPosting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
        create: expect.objectContaining({ journalEntryId: 'journal-entry-1', linesJson: ENTRY.lines }),
      }),
    );
    expect(result.postedExternalId).toMatch(/^CUSTOM-/);
  });

  it('is idempotent: when the row was already synced by a prior crashed attempt, returns the ALREADY-STORED external id, not a freshly generated one', async () => {
    // Simulates upsert hitting its update branch (row already exists) —
    // the real DB would return the pre-existing row untouched by `update:
    // {}`, not the newly-generated `create` payload this test's default
    // mock stands in for.
    const alreadyStoredId = 'CUSTOM-already-synced-id';
    const tx = { externalLedgerPosting: { upsert: jest.fn().mockResolvedValue({ postedExternalId: alreadyStoredId }) } };
    const connector = new CustomModuleConnector(makePrisma(tx));

    const result = await connector.post(TENANT, ROW, ENTRY);

    expect(result.postedExternalId).toBe(alreadyStoredId);
  });
});
