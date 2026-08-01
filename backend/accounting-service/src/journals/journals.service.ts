import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
 */
@Injectable()
export class JournalsService {
  constructor(private readonly prisma: PrismaService) {}

  async createManualJournalEntry(tenantId: string, dto: CreateJournalEntryDto) {
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
          status: 'POSTED',
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
}
