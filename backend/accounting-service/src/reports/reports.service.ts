import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface AccountBalance {
  accountCode: string;
  accountName: string;
  accountType: string;
  totalDebit: number;
  totalCredit: number;
}

/**
 * Reads the SAME journal_entries/journal_lines ledger-service already
 * posts to (migration 005) — this module adds no new financial truth, only
 * ways of looking at what's already there. These reports are all-time
 * as-of-now snapshots — there is no period concept anywhere in this
 * platform's journal_entries (no period column, no date-range filtering
 * here), so Trial Balance/P&L/Balance Sheet always reflect everything
 * ever posted, not "this month" or "this year" in isolation.
 *
 * Period-close (../period-close/period-close.service.ts) is a real,
 * explicit action — not automatic — that zeroes current REVENUE/EXPENSE
 * balances into an EQUITY "Retained Earnings" account. Until it's
 * triggered, Balance Sheet's totalAssets will differ from
 * totalLiabilities + totalEquity by exactly whatever net income hasn't
 * been closed yet; that's expected, not a bug in the numbers shown.
 *
 * `journalEntry: { status: 'POSTED' }` below matters more than it looks —
 * migration 022 (approval_matrix expansion, docs/RUNBOOK.md) gave manual
 * journal entries a `PENDING_APPROVAL` state that has to exist in the same
 * table these reports already summed unconditionally. Before that
 * migration this filter was unnecessary (every row was always `POSTED`
 * the instant it existed); without it now, an entry someone merely
 * proposed — not yet approved, possibly never approved — would already
 * be counted in Trial Balance/P&L/Balance Sheet, which is wrong in a way
 * a reader of these reports would have no way to detect.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // Not private — PeriodCloseService (../period-close/period-close.service.ts)
  // reuses this exact computation rather than re-deriving it; period-close
  // needs to know CURRENT revenue/expense balances the same way these
  // reports do, since it's the operation that zeroes them into equity.
  async accountBalances(tenantId: string): Promise<AccountBalance[]> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const accounts = await tx.chartOfAccount.findMany({ where: { tenantId, isActive: true } });
      const sums = await tx.journalLine.groupBy({
        by: ['accountCode'],
        where: { tenantId, journalEntry: { status: 'POSTED' } },
        _sum: { debitAmount: true, creditAmount: true },
      });
      const sumsByCode = new Map(sums.map((s) => [s.accountCode, s]));

      return accounts.map((a) => {
        const s = sumsByCode.get(a.accountCode);
        return {
          accountCode: a.accountCode,
          accountName: a.accountName,
          accountType: a.accountType,
          totalDebit: Number(s?._sum.debitAmount ?? 0),
          totalCredit: Number(s?._sum.creditAmount ?? 0),
        };
      });
    });
  }

  async trialBalance(tenantId: string) {
    const balances = await this.accountBalances(tenantId);
    const rows = balances
      .filter((b) => b.totalDebit !== 0 || b.totalCredit !== 0)
      .map((b) => ({
        accountCode: b.accountCode,
        accountName: b.accountName,
        debit: b.totalDebit,
        credit: b.totalCredit,
      }));
    return {
      rows,
      totalDebit: rows.reduce((sum, r) => sum + r.debit, 0),
      totalCredit: rows.reduce((sum, r) => sum + r.credit, 0),
    };
  }

  async profitAndLoss(tenantId: string) {
    const balances = await this.accountBalances(tenantId);

    const revenue = balances
      .filter((b) => b.accountType === 'REVENUE')
      .map((b) => ({ accountCode: b.accountCode, accountName: b.accountName, amount: b.totalCredit - b.totalDebit }));
    const expense = balances
      .filter((b) => b.accountType === 'EXPENSE')
      .map((b) => ({ accountCode: b.accountCode, accountName: b.accountName, amount: b.totalDebit - b.totalCredit }));

    const totalRevenue = revenue.reduce((sum, r) => sum + r.amount, 0);
    const totalExpense = expense.reduce((sum, r) => sum + r.amount, 0);

    return { revenue, expense, totalRevenue, totalExpense, netIncome: totalRevenue - totalExpense };
  }

  async balanceSheet(tenantId: string) {
    const balances = await this.accountBalances(tenantId);

    const assets = balances
      .filter((b) => b.accountType === 'ASSET')
      .map((b) => ({ accountCode: b.accountCode, accountName: b.accountName, amount: b.totalDebit - b.totalCredit }));
    const liabilities = balances
      .filter((b) => b.accountType === 'LIABILITY')
      .map((b) => ({ accountCode: b.accountCode, accountName: b.accountName, amount: b.totalCredit - b.totalDebit }));
    const equity = balances
      .filter((b) => b.accountType === 'EQUITY')
      .map((b) => ({ accountCode: b.accountCode, accountName: b.accountName, amount: b.totalCredit - b.totalDebit }));

    const totalAssets = assets.reduce((sum, r) => sum + r.amount, 0);
    const totalLiabilities = liabilities.reduce((sum, r) => sum + r.amount, 0);
    const totalEquity = equity.reduce((sum, r) => sum + r.amount, 0);

    return {
      assets,
      liabilities,
      equity,
      totalAssets,
      totalLiabilities,
      totalEquity,
      // See class doc comment — this omits net income not yet closed to
      // equity, so it will differ from totalAssets by exactly that amount
      // whenever there's unclosed P&L activity. Expected, not a defect.
    };
  }
}
