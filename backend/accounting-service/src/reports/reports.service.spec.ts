import { ReportsService } from './reports.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

const ACCOUNTS = [
  { tenantId: TENANT, accountCode: '1310', accountName: 'Raw Material Inventory', accountType: 'ASSET', isActive: true },
  { tenantId: TENANT, accountCode: '2110', accountName: 'Accounts Payable', accountType: 'LIABILITY', isActive: true },
  { tenantId: TENANT, accountCode: '3100', accountName: 'Owner Equity', accountType: 'EQUITY', isActive: true },
  { tenantId: TENANT, accountCode: '4000', accountName: 'Sales Revenue', accountType: 'REVENUE', isActive: true },
  { tenantId: TENANT, accountCode: '5000', accountName: 'Cost of Goods Sold', accountType: 'EXPENSE', isActive: true },
  // Zero-activity account — should be excluded from Trial Balance rows but
  // still present in accountBalances (its type-specific reports filter on
  // amount != 0 too, only implicitly via balances summing to 0).
  { tenantId: TENANT, accountCode: '9999', accountName: 'Unused Account', accountType: 'ASSET', isActive: true },
];

// A genuinely BALANCED trial balance (sum of all debits == sum of all
// credits, 700,000 each) — required for the balance-sheet-vs-P&L identity
// test below to mean anything; an unbalanced fixture would make that
// invariant fail for a reason having nothing to do with ReportsService.
const GROUPED_SUMS = [
  { accountCode: '1310', _sum: { debitAmount: 400000, creditAmount: 100000 } },
  { accountCode: '2110', _sum: { debitAmount: 50000, creditAmount: 300000 } },
  { accountCode: '3100', _sum: { debitAmount: 0, creditAmount: 100000 } },
  { accountCode: '4000', _sum: { debitAmount: 0, creditAmount: 200000 } },
  { accountCode: '5000', _sum: { debitAmount: 250000, creditAmount: 0 } },
];

function makePrisma(): PrismaService {
  const tx = {
    chartOfAccount: { findMany: jest.fn().mockResolvedValue(ACCOUNTS) },
    journalLine: { groupBy: jest.fn().mockResolvedValue(GROUPED_SUMS) },
  };
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

describe('ReportsService', () => {
  it('trialBalance sums total debit and total credit across all accounts and excludes zero-activity accounts', async () => {
    const service = new ReportsService(makePrisma());

    const result = await service.trialBalance(TENANT);

    expect(result.totalDebit).toBe(700000);
    expect(result.totalCredit).toBe(700000);
    expect(result.rows.find((r) => r.accountCode === '9999')).toBeUndefined();
    expect(result.rows).toHaveLength(5);
  });

  it('profitAndLoss computes revenue as credit-debit and expense as debit-credit, netIncome as their difference', async () => {
    const service = new ReportsService(makePrisma());

    const result = await service.profitAndLoss(TENANT);

    // Revenue (4000): credit 200000 - debit 0 = 200000
    expect(result.totalRevenue).toBe(200000);
    // Expense (5000): debit 250000 - credit 0 = 250000
    expect(result.totalExpense).toBe(250000);
    expect(result.netIncome).toBe(200000 - 250000);
  });

  it('balanceSheet computes assets as debit-credit, liabilities/equity as credit-debit', async () => {
    const service = new ReportsService(makePrisma());

    const result = await service.balanceSheet(TENANT);

    // Assets (1310 + 9999): (400000-100000) + (0-0) = 300000
    expect(result.totalAssets).toBe(300000);
    // Liabilities (2110): 300000 - 50000 = 250000
    expect(result.totalLiabilities).toBe(250000);
    // Equity (3100): 100000 - 0 = 100000
    expect(result.totalEquity).toBe(100000);
  });

  it('balanceSheet intentionally leaves unclosed net income out of equity (totalAssets differs from liabilities+equity by exactly netIncome, given a balanced trial balance)', async () => {
    const service = new ReportsService(makePrisma());

    const balanceSheet = await service.balanceSheet(TENANT);
    const profitAndLoss = await service.profitAndLoss(TENANT);

    // 300000 - (250000 + 100000) = -50000, matching netIncome (200000 - 250000).
    const difference = balanceSheet.totalAssets - (balanceSheet.totalLiabilities + balanceSheet.totalEquity);
    expect(difference).toBe(profitAndLoss.netIncome);
  });
});
