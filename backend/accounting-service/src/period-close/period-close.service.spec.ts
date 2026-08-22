import { BadRequestException } from '@nestjs/common';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { PeriodCloseService } from './period-close.service';
import { PrismaService } from '../common/prisma.service';
import { AccountBalance, ReportsService } from '../reports/reports.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makeReports(balances: AccountBalance[]): ReportsService {
  return { accountBalances: jest.fn().mockResolvedValue(balances) } as unknown as ReportsService;
}

function makePostingAuthority(): PostingAuthorityClient {
  return { checkAuthority: jest.fn().mockResolvedValue(undefined) } as unknown as PostingAuthorityClient;
}

function makeTx() {
  const lines: Array<{ accountCode: string; debitAmount: number; creditAmount: number }> = [];
  return {
    journalEntry: {
      create: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockImplementation(() => ({ journalEntryId: 'entry-1', lines })),
    },
    journalLine: {
      create: jest.fn().mockImplementation(({ data }) => {
        lines.push({ accountCode: data.accountCode, debitAmount: data.debitAmount, creditAmount: data.creditAmount });
      }),
    },
    _lines: lines,
  };
}

describe('PeriodCloseService.closeBooks', () => {
  it('zeroes revenue (credit) and expense (debit) balances, crediting the surplus to Retained Earnings', async () => {
    const balances: AccountBalance[] = [
      { accountCode: '4000', accountName: 'Sales Revenue', accountType: 'REVENUE', totalDebit: 0, totalCredit: 200000 },
      { accountCode: '5000', accountName: 'COGS', accountType: 'EXPENSE', totalDebit: 150000, totalCredit: 0 },
    ];
    const tx = makeTx();
    const postingAuthority = makePostingAuthority();
    const service = new PeriodCloseService(makePrisma(tx), makeReports(balances), postingAuthority);

    await service.closeBooks(TENANT, 'user-1');

    expect(postingAuthority.checkAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermission: 'can_post', moduleName: 'ACCOUNTING' }),
    );
    expect(tx._lines).toEqual([
      { accountCode: '4000', debitAmount: 200000, creditAmount: 0 }, // zero the revenue credit balance
      { accountCode: '5000', debitAmount: 0, creditAmount: 150000 }, // zero the expense debit balance
      { accountCode: '3100', debitAmount: 0, creditAmount: 50000 }, // net income 50,000 credited to Retained Earnings
    ]);
  });

  it('debits Retained Earnings instead when the period is a loss', async () => {
    const balances: AccountBalance[] = [
      { accountCode: '4000', accountName: 'Sales Revenue', accountType: 'REVENUE', totalDebit: 0, totalCredit: 100000 },
      { accountCode: '5000', accountName: 'COGS', accountType: 'EXPENSE', totalDebit: 150000, totalCredit: 0 },
    ];
    const tx = makeTx();
    const service = new PeriodCloseService(makePrisma(tx), makeReports(balances), makePostingAuthority());

    await service.closeBooks(TENANT, 'user-1');

    expect(tx._lines).toContainEqual({ accountCode: '3100', debitAmount: 50000, creditAmount: 0 });
  });

  it('omits the Retained Earnings line entirely when net income is exactly zero, since a zero-amount line would violate one_sided_line', async () => {
    const balances: AccountBalance[] = [
      { accountCode: '4000', accountName: 'Sales Revenue', accountType: 'REVENUE', totalDebit: 0, totalCredit: 100000 },
      { accountCode: '5000', accountName: 'COGS', accountType: 'EXPENSE', totalDebit: 100000, totalCredit: 0 },
    ];
    const tx = makeTx();
    const service = new PeriodCloseService(makePrisma(tx), makeReports(balances), makePostingAuthority());

    await service.closeBooks(TENANT, 'user-1');

    expect(tx._lines.find((l) => l.accountCode === '3100')).toBeUndefined();
    expect(tx._lines).toHaveLength(2);
  });

  it('ignores accounts with no real activity (asset/liability, and revenue/expense already at zero)', async () => {
    const balances: AccountBalance[] = [
      { accountCode: '1310', accountName: 'Inventory', accountType: 'ASSET', totalDebit: 400000, totalCredit: 100000 },
      { accountCode: '4000', accountName: 'Sales Revenue', accountType: 'REVENUE', totalDebit: 0, totalCredit: 0 },
      { accountCode: '5000', accountName: 'COGS', accountType: 'EXPENSE', totalDebit: 75000, totalCredit: 0 },
    ];
    const tx = makeTx();
    const service = new PeriodCloseService(makePrisma(tx), makeReports(balances), makePostingAuthority());

    await service.closeBooks(TENANT, 'user-1');

    // Only the expense line (75,000) and its Retained Earnings offset —
    // the ASSET account and the already-zero REVENUE account never
    // appear.
    expect(tx._lines).toEqual([
      { accountCode: '5000', debitAmount: 0, creditAmount: 75000 },
      { accountCode: '3100', debitAmount: 75000, creditAmount: 0 },
    ]);
  });

  it('correctly zeroes an EXPENSE account carrying a net CREDIT balance, not just the textbook debit-normal case', async () => {
    // Regression test for a real bug found running this against the live
    // dev database: manufacturing's favorable-variance postings (see
    // production.service.ts) credit an expense account more than they
    // debit it (e.g. real account 5310, "Manufacturing Variance
    // Expense"). The original implementation assumed every EXPENSE
    // account needed a CREDIT to close it and blindly used its
    // (possibly negative) debit-minus-credit balance as creditAmount,
    // which is invalid — journal_lines' one_sided_line CHECK rejects a
    // negative creditAmount outright, and Postgres actually threw a real
    // 23514 constraint violation on this exact shape of data.
    const balances: AccountBalance[] = [
      { accountCode: '4000', accountName: 'Sales Revenue', accountType: 'REVENUE', totalDebit: 0, totalCredit: 300000 },
      // Credit-heavy: totalCredit > totalDebit, a net CREDIT position on
      // an EXPENSE account.
      { accountCode: '5310', accountName: 'Manufacturing Variance Expense', accountType: 'EXPENSE', totalDebit: 20000, totalCredit: 1500000 },
    ];
    const tx = makeTx();
    const service = new PeriodCloseService(makePrisma(tx), makeReports(balances), makePostingAuthority());

    const result = await service.closeBooks(TENANT, 'user-1');

    expect(result).toBeDefined();
    // Revenue (net credit 300,000) is debited to zero; the expense
    // account's net CREDIT position (1,480,000) is debited to zero too —
    // never a negative creditAmount anywhere.
    expect(tx._lines).toEqual([
      { accountCode: '4000', debitAmount: 300000, creditAmount: 0 },
      { accountCode: '5310', debitAmount: 1480000, creditAmount: 0 },
      // Both lines end up on the debit side, so Retained Earnings takes
      // the entire 1,780,000 as a credit to balance the entry — a large
      // profit, driven by the favorable variance reducing recorded
      // expense below zero.
      { accountCode: '3100', debitAmount: 0, creditAmount: 1780000 },
    ]);
    expect(tx._lines.every((l) => l.debitAmount >= 0 && l.creditAmount >= 0)).toBe(true);
  });

  it('rejects with no write and no authority check when every revenue/expense account is already at zero', async () => {
    const balances: AccountBalance[] = [
      { accountCode: '1310', accountName: 'Inventory', accountType: 'ASSET', totalDebit: 400000, totalCredit: 100000 },
      { accountCode: '4000', accountName: 'Sales Revenue', accountType: 'REVENUE', totalDebit: 0, totalCredit: 0 },
    ];
    const tx = makeTx();
    const postingAuthority = makePostingAuthority();
    const service = new PeriodCloseService(makePrisma(tx), makeReports(balances), postingAuthority);

    await expect(service.closeBooks(TENANT, 'user-1')).rejects.toThrow(BadRequestException);
    expect(postingAuthority.checkAuthority).not.toHaveBeenCalled();
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });
});
