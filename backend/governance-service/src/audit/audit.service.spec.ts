import { AuditService } from './audit.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

/**
 * Fake Prisma tx: `findFirst` backs recordEntry's "what's the last row"
 * lookup, `$queryRaw` backs the raw INSERT (only `audit_log_id`/`chain_seq`
 * are read from its result — recordEntry computes prevHash/recordHash
 * itself, in JS, before ever calling $queryRaw), `findMany` backs
 * verifyChain's read of the whole chain.
 */
function makeTx(overrides: {
  lastRow?: { recordHash: string } | null;
  chainSeq?: bigint;
  findManyRows?: unknown[];
}) {
  return {
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(overrides.lastRow ?? null),
      findMany: jest.fn().mockResolvedValue(overrides.findManyRows ?? []),
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ audit_log_id: 'generated-id', chain_seq: overrides.chainSeq ?? 1n }]),
  };
}

function makePrisma(tx: ReturnType<typeof makeTx>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

describe('AuditService.recordEntry', () => {
  it('chains off the previous row: prevHash equals the last stored recordHash', async () => {
    const tx = makeTx({ lastRow: { recordHash: 'PREVIOUS_HASH_123' }, chainSeq: 2n });
    const service = new AuditService(makePrisma(tx));

    const entry = await service.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-1',
      actionType: 'APPROVAL_CHECK',
    });

    expect(entry.prevHash).toBe('PREVIOUS_HASH_123');
    expect(entry.recordHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.recordHash).not.toBe(entry.prevHash);
  });

  it('starts the chain with prevHash=null when there is no prior row', async () => {
    const tx = makeTx({ lastRow: null });
    const service = new AuditService(makePrisma(tx));

    const entry = await service.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-1',
      actionType: 'APPROVAL_CHECK',
    });

    expect(entry.prevHash).toBeNull();
  });

  it('produces a different recordHash for different content, same prevHash', async () => {
    const tx = makeTx({ lastRow: null });
    const service = new AuditService(makePrisma(tx));

    const entryA = await service.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-1',
      actionType: 'APPROVAL_CHECK',
    });
    const entryB = await service.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-2',
      actionType: 'APPROVAL_CHECK',
    });

    expect(entryA.recordHash).not.toBe(entryB.recordHash);
  });
});

describe('AuditService.verifyChain', () => {
  it('verifies a real chain built from two consecutive recordEntry calls', async () => {
    const insertTx = makeTx({ lastRow: null, chainSeq: 1n });
    const insertService = new AuditService(makePrisma(insertTx));
    const entry1 = await insertService.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-1',
      actionType: 'APPROVAL_CHECK',
      userId: 'user-1',
    });

    const insertTx2 = makeTx({ lastRow: { recordHash: entry1.recordHash }, chainSeq: 2n });
    const insertService2 = new AuditService(makePrisma(insertTx2));
    const entry2 = await insertService2.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-2',
      actionType: 'APPROVAL_DENIED',
      overrideFlag: true,
      reasonCode: 'INSUFFICIENT_APPROVAL_TIER',
    });

    const verifyTx = makeTx({
      findManyRows: [
        { ...entry1, auditLogId: 'log-1' },
        { ...entry2, auditLogId: 'log-2' },
      ],
    });
    const verifyService = new AuditService(makePrisma(verifyTx));

    const result = await verifyService.verifyChain(TENANT);

    expect(result).toEqual({ valid: true, totalRecords: 2 });
  });

  it('detects a tampered row: content changed without recomputing its hash', async () => {
    const insertTx = makeTx({ lastRow: null, chainSeq: 1n });
    const insertService = new AuditService(makePrisma(insertTx));
    const entry1 = await insertService.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-1',
      actionType: 'APPROVAL_CHECK',
    });

    const tampered = { ...entry1, auditLogId: 'log-1', actionType: 'APPROVAL_DENIED' };
    const verifyTx = makeTx({ findManyRows: [tampered] });
    const verifyService = new AuditService(makePrisma(verifyTx));

    const result = await verifyService.verifyChain(TENANT);

    expect(result).toMatchObject({ valid: false, brokenAtAuditLogId: 'log-1' });
  });

  it('detects a broken prevHash link between two rows', async () => {
    const insertTx = makeTx({ lastRow: null, chainSeq: 1n });
    const insertService = new AuditService(makePrisma(insertTx));
    const entry1 = await insertService.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-1',
      actionType: 'APPROVAL_CHECK',
    });

    const insertTx2 = makeTx({ lastRow: { recordHash: entry1.recordHash }, chainSeq: 2n });
    const insertService2 = new AuditService(makePrisma(insertTx2));
    const entry2 = await insertService2.recordEntry(TENANT, {
      moduleName: 'PROCUREMENT',
      recordIdRef: 'po-2',
      actionType: 'APPROVAL_CHECK',
    });

    // Simulate someone splicing a row out of the middle of the chain: entry2's
    // prevHash no longer matches entry1's actual recordHash.
    const spliced = { ...entry2, auditLogId: 'log-2', prevHash: 'SOMETHING_ELSE_ENTIRELY' };
    const verifyTx = makeTx({ findManyRows: [{ ...entry1, auditLogId: 'log-1' }, spliced] });
    const verifyService = new AuditService(makePrisma(verifyTx));

    const result = await verifyService.verifyChain(TENANT);

    expect(result).toMatchObject({ valid: false, brokenAtAuditLogId: 'log-2' });
  });

  it('reports valid with zero records for an empty chain', async () => {
    const tx = makeTx({ findManyRows: [] });
    const service = new AuditService(makePrisma(tx));

    const result = await service.verifyChain(TENANT);

    expect(result).toEqual({ valid: true, totalRecords: 0 });
  });
});
