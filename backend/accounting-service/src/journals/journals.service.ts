import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CreateJournalEntryDto } from './dto/journal-entry.dto';

/**
 * Manual journal entries are the ONE financial posting in this platform not
 * mediated by ledger-service's Kafka consumer — there's no source domain
 * event to react to; it's operator-initiated (adjustments, corrections via
 * a new reversing entry, opening balances). See migration 015's role
 * comment for why accounting_svc alone has direct INSERT on
 * journal_entries/journal_lines.
 *
 * Validated exactly like every other posting in this ledger:
 * sum(debit) === sum(credit), and each line is one-sided (the DB's
 * `one_sided_line` CHECK from migration 005 is the backstop; this is the
 * same rule enforced earlier so the caller gets a clear 400 instead of a
 * raw constraint-violation error).
 *
 * Amount-routed approval (docs/RUNBOOK.md's "approval_matrix expansion"
 * section, migration 022) — creating an entry only proposes it
 * (`PENDING_APPROVAL`, no GL effect: reports.service.ts only sums
 * `POSTED` entries); `approve`/`reject` are what actually decide it,
 * mirroring procurement-service's PO approve/reject exactly, including
 * that creation itself calls no authority check at all — only
 * approve/reject do, via `checkApprovalAuthority`.
 */
@Injectable()
export class JournalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async createManualJournalEntry(tenantId: string, dto: CreateJournalEntryDto, _userId: string | undefined) {
    for (const line of dto.lines) {
      const isDebit = line.debitAmount > 0 && line.creditAmount === 0;
      const isCredit = line.creditAmount > 0 && line.debitAmount === 0;
      if (!isDebit && !isCredit) {
        throw new BadRequestException(
          `Line for account ${line.accountCode} must have exactly one of debitAmount/creditAmount > 0`,
        );
      }
    }

    const totalDebit = dto.lines.reduce((sum, l) => sum + l.debitAmount, 0);
    const totalCredit = dto.lines.reduce((sum, l) => sum + l.creditAmount, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new BadRequestException(
        `Journal entry does not balance: total debits ${totalDebit} != total credits ${totalCredit}`,
      );
    }

    const journalEntryId = randomUUID();

    return this.prisma.forTenant(tenantId, async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          tenantId,
          journalEntryId,
          sourceEventId: randomUUID(), // no domain event backs a manual entry — a fresh id per entry
          sourceModule: 'accounting_manual',
          postingDate: new Date(),
          status: 'PENDING_APPROVAL',
          memo: dto.memo,
        },
      });

      for (const line of dto.lines) {
        await tx.journalLine.create({
          data: {
            tenantId,
            journalLineId: randomUUID(),
            journalEntryId: entry.journalEntryId,
            accountCode: line.accountCode,
            debitAmount: line.debitAmount,
            creditAmount: line.creditAmount,
          },
        });
      }

      return tx.journalEntry.findUnique({
        where: { tenantId_journalEntryId: { tenantId, journalEntryId: entry.journalEntryId } },
        include: { lines: true },
      });
    });
  }

  private async totalAmount(tenantId: string, journalEntryId: string): Promise<number> {
    const lines = await this.prisma.forTenant(tenantId, (tx) =>
      tx.journalLine.findMany({ where: { tenantId, journalEntryId } }),
    );
    // Balanced by construction (createManualJournalEntry rejects anything
    // that doesn't balance) — sum(debit) and sum(credit) are the same
    // number, either works as "the amount" approval_matrix routes on.
    return lines.reduce((sum, l) => sum + Number(l.debitAmount), 0);
  }

  async approveJournalEntry(tenantId: string, journalEntryId: string, userId: string | undefined) {
    const entry = await this.prisma.forTenant(tenantId, (tx) =>
      tx.journalEntry.findUnique({ where: { tenantId_journalEntryId: { tenantId, journalEntryId } } }),
    );
    if (!entry) throw new NotFoundException(`Journal entry ${journalEntryId} not found`);
    if (entry.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(`Journal entry ${journalEntryId} is not pending approval (status=${entry.status})`);
    }

    const amount = await this.totalAmount(tenantId, journalEntryId);

    const result = await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'ACCOUNTING',
      transactionType: 'MANUAL_JOURNAL_ENTRY',
      recordIdRef: journalEntryId,
      amount,
      stage: entry.currentApprovalStage,
    });

    const nextStage = entry.currentApprovalStage + 1;
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.journalEntry.update({
        where: { tenantId_journalEntryId: { tenantId, journalEntryId } },
        data: result.hasNextStage ? { currentApprovalStage: nextStage } : { status: 'POSTED', pendingApproverRoleId: null },
        include: { lines: true },
      }),
    );
  }

  async rejectJournalEntry(tenantId: string, journalEntryId: string, userId: string | undefined) {
    const entry = await this.prisma.forTenant(tenantId, (tx) =>
      tx.journalEntry.findUnique({ where: { tenantId_journalEntryId: { tenantId, journalEntryId } } }),
    );
    if (!entry) throw new NotFoundException(`Journal entry ${journalEntryId} not found`);
    if (entry.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(`Journal entry ${journalEntryId} is not pending approval (status=${entry.status})`);
    }

    const amount = await this.totalAmount(tenantId, journalEntryId);

    // Rejecting requires the SAME approval-tier gate as approving — see
    // procurement-service's rejectPurchaseOrder for the identical
    // reasoning: a lower-tier approver can reject what they could have
    // approved, not reject something above their own tier.
    await this.postingAuthority.checkApprovalAuthority({
      tenantId,
      userId,
      moduleName: 'ACCOUNTING',
      transactionType: 'MANUAL_JOURNAL_ENTRY',
      recordIdRef: journalEntryId,
      amount,
      stage: entry.currentApprovalStage,
    });

    return this.prisma.forTenant(tenantId, (tx) =>
      tx.journalEntry.update({
        where: { tenantId_journalEntryId: { tenantId, journalEntryId } },
        data: { status: 'REJECTED', pendingApproverRoleId: null },
        include: { lines: true },
      }),
    );
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.journalEntry.findMany({ where: { tenantId }, include: { lines: true }, orderBy: { postingDate: 'desc' } }),
    );
  }
}
