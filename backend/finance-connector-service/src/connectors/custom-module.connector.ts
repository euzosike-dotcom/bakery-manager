import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ConnectorPostResult, ConnectorStrategy, JournalEntryForPosting, QueueRowForPosting } from './connector-strategy';

/**
 * The one real connector implementation — relays to Metrock's own custom
 * finance module (`external_ledger_postings`, `025_finance_connector
 * .sql`) instead of an external SaaS API. See `connector-strategy.ts`
 * for why this is the only one.
 */
@Injectable()
export class CustomModuleConnector implements ConnectorStrategy {
  readonly externalSystem = 'CUSTOM_MODULE';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Uses upsert (not create) against ExternalLedgerPosting's
   * unique(tenantId, queueId) constraint so a crash between the insert
   * and the caller's integration_queue update is self-healing on retry,
   * rather than either double-posting or throwing a P2002 that would
   * abort the surrounding transaction (Prisma interactive transactions
   * don't savepoint each statement, so a caught exception inside one
   * still leaves it unusable for further queries).
   */
  async post(tenantId: string, row: QueueRowForPosting, entry: JournalEntryForPosting): Promise<ConnectorPostResult> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const posting = await tx.externalLedgerPosting.upsert({
        where: { tenantId_queueId: { tenantId, queueId: row.queueId } },
        update: {},
        create: {
          tenantId,
          externalPostingId: randomUUID(),
          queueId: row.queueId,
          sourceModule: row.sourceModule,
          transactionType: row.transactionType,
          journalEntryId: entry.journalEntryId,
          linesJson: entry.lines as unknown as Prisma.InputJsonValue,
          postedExternalId: `CUSTOM-${randomUUID()}`,
          receivedAt: new Date(),
        },
      });
      return { postedExternalId: posting.postedExternalId };
    });
  }
}
