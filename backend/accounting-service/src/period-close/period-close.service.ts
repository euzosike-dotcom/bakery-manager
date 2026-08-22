import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { ReportsService } from '../reports/reports.service';

const RETAINED_EARNINGS_ACCOUNT_CODE = '3100'; // 028_period_close.sql
const BALANCE_EPSILON = 0.005; // same tolerance JournalsService uses for "does this balance"

interface ZeroingLine {
  accountCode: string;
  debitAmount: number;
  creditAmount: number;
}

/**
 * Closes the books: zeroes every REVENUE and EXPENSE account's CURRENT
 * balance into Retained Earnings (EQUITY) — see reports.service.ts's
 * class doc comment for why Balance Sheet drifts from Trial Balance
 * until this runs.
 *
 * Not tied to a calendar period — there is no period concept anywhere in
 * journal_entries (no period column) for this to filter against, and
 * adding one would be significant scope this pass doesn't need. Instead
 * this closes whatever is CURRENTLY unclosed, and is naturally
 * idempotent-in-effect for that reason: a closing entry's own lines
 * hit the same revenue/expense accounts they zero, so a second close
 * with no new activity in between finds nothing left to close (see the
 * "nothing to close" guard below) rather than double-zeroing anything.
 *
 * Writes journal_entries/journal_lines directly, like JournalsService's
 * manual entries — the accounting_svc role's direct-insert grant exists
 * for exactly this reason (migration 015's comment): the debit/credit
 * shape here (N dynamic revenue lines + N dynamic expense lines + one
 * balancing line) can't be expressed by posting_rules' fixed one-event-
 * type-to-one-debit-account-and-one-credit-account mapping, so this
 * can't go through ledger-service's Kafka-driven posting path at all.
 *
 * Posts immediately (status POSTED) behind a single checkAuthority gate,
 * the same shape as vendor bill payment / customer invoice payment
 * (bills.service.ts/invoices.service.ts) — NOT the two-party
 * PENDING_APPROVAL workflow manual journal entries use. A period close
 * is a deliberate, already-decided finance action performed by one
 * authorized person, not a proposal for someone else to review.
 */
@Injectable()
export class PeriodCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async closeBooks(tenantId: string, userId: string | undefined) {
    const balances = await this.reports.accountBalances(tenantId);

    // netDebit, not "the type's normal-balance amount" — an EXPENSE
    // account can carry a net CREDIT balance in this platform for real
    // (manufacturing's favorable-variance postings credit an expense
    // account more than they debit it, e.g. 5310 "Manufacturing Variance
    // Expense"), and the reverse is possible for REVENUE too in
    // principle. Zeroing an account only needs to know its signed
    // netDebit, never its type's textbook "normal side" — a positive
    // netDebit is zeroed by crediting it, a negative one by debiting it,
    // regardless of whether the account is REVENUE or EXPENSE.
    const closingLines: ZeroingLine[] = balances
      .filter((b) => b.accountType === 'REVENUE' || b.accountType === 'EXPENSE')
      .map((b) => ({ accountCode: b.accountCode, netDebit: b.totalDebit - b.totalCredit }))
      .filter((b) => Math.abs(b.netDebit) > BALANCE_EPSILON)
      .map((b) => ({
        accountCode: b.accountCode,
        debitAmount: b.netDebit < 0 ? -b.netDebit : 0,
        creditAmount: b.netDebit > 0 ? b.netDebit : 0,
      }));

    if (closingLines.length === 0) {
      throw new BadRequestException('Nothing to close — every revenue and expense account is already at zero.');
    }

    // Retained Earnings must absorb whatever the closing lines don't
    // balance on their own. Each line's (creditAmount - debitAmount) is
    // exactly that account's netDebit by construction, so summing across
    // every closing line gives sum(netDebit) — and netIncome is the
    // NEGATION of that: -netDebit(revenue) is totalRevenue, -netDebit
    // (expense) is totalExpense, so netIncome = totalRevenue -
    // totalExpense = -sum(netDebit) = sum(debitAmount) - sum(creditAmount)
    // across the closing lines. A net excess of debits there (as an
    // ordinary profitable period produces: debiting revenue down,
    // crediting expense down, with more revenue than expense) is a
    // profit, credited to Retained Earnings below.
    const netIncome =
      closingLines.reduce((sum, l) => sum + l.debitAmount, 0) - closingLines.reduce((sum, l) => sum + l.creditAmount, 0);

    const journalEntryId = randomUUID();

    await this.postingAuthority.checkAuthority({
      tenantId,
      userId,
      requiredPermission: 'can_post',
      moduleName: 'ACCOUNTING',
      recordIdRef: journalEntryId,
    });

    return this.prisma.forTenant(tenantId, async (tx) => {
      await tx.journalEntry.create({
        data: {
          tenantId,
          journalEntryId,
          sourceEventId: randomUUID(), // no domain event backs this — a deliberate finance action, same as a manual entry
          sourceModule: 'accounting_period_close',
          postingDate: new Date(),
          status: 'POSTED',
          memo: 'Period close: revenue and expense accounts closed to Retained Earnings',
        },
      });

      for (const line of closingLines) {
        await tx.journalLine.create({
          data: {
            tenantId,
            journalLineId: randomUUID(),
            journalEntryId,
            accountCode: line.accountCode,
            debitAmount: line.debitAmount,
            creditAmount: line.creditAmount,
          },
        });
      }

      // Omitted entirely when net income is exactly zero — a zero-amount
      // line would violate journal_lines' one_sided_line CHECK, and the
      // closing lines above already balance each other in that case.
      if (Math.abs(netIncome) > BALANCE_EPSILON) {
        await tx.journalLine.create({
          data: {
            tenantId,
            journalLineId: randomUUID(),
            journalEntryId,
            accountCode: RETAINED_EARNINGS_ACCOUNT_CODE,
            debitAmount: netIncome < 0 ? -netIncome : 0,
            creditAmount: netIncome > 0 ? netIncome : 0,
          },
        });
      }

      return tx.journalEntry.findUnique({
        where: { tenantId_journalEntryId: { tenantId, journalEntryId } },
        include: { lines: true },
      });
    });
  }
}
