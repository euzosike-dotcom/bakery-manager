import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

const EXTERNAL_SYSTEM = 'CUSTOM_MODULE';
const MAX_RETRIES = 3;
const BATCH_SIZE = 20;

interface QueueRow {
  queueId: string;
  sourceModule: string;
  sourceRecordId: string;
  transactionType: string;
  retryCount: number;
}

/**
 * The consumer side of integration_queue (005_finance.sql) — what a real
 * Zoho Books/QuickBooks connector would otherwise be, relaying postings to
 * Metrock's own custom finance module (external_ledger_postings,
 * 025_finance_connector.sql) instead of an external SaaS API.
 *
 * This is the first cross-tenant background job in this platform's NestJS
 * services — every other service is request-scoped by an incoming
 * x-tenant-id header, so there is no request to inherit a tenant from.
 * Instead, each poll tick enumerates tenant_registry itself for tenants
 * configured with financeConnectorType='CUSTOM_MODULE', then runs a
 * separate PrismaService.forTenant-scoped pass per tenant — the same RLS
 * session-variable mechanism every request-scoped service already uses,
 * just driven by a timer instead of a controller.
 *
 * A plain setInterval, not @nestjs/schedule — this is the only scheduled
 * job anywhere in this codebase, so a new dependency for one timer would
 * be exactly the kind of premature abstraction this codebase avoids
 * elsewhere.
 */
@Injectable()
export class FinanceConnectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FinanceConnectorService.name);
  private timer?: NodeJS.Timeout;
  private readonly pollIntervalMs = process.env.POLL_INTERVAL_MS
    ? Number(process.env.POLL_INTERVAL_MS)
    : 5000;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.pollAllTenants().catch((err) =>
        this.logger.error(`poll cycle failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, this.pollIntervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async pollAllTenants(): Promise<void> {
    const tenants = await this.prisma.tenantRegistry.findMany({
      where: { financeConnectorType: EXTERNAL_SYSTEM },
      select: { tenantId: true },
    });
    for (const { tenantId } of tenants) {
      await this.pollTenant(tenantId);
    }
  }

  async pollTenant(tenantId: string): Promise<void> {
    const pending = await this.prisma.forTenant(tenantId, (tx) =>
      tx.integrationQueue.findMany({
        where: { queueStatus: 'PENDING', externalSystem: EXTERNAL_SYSTEM },
        orderBy: { queuedTime: 'asc' },
        take: BATCH_SIZE,
        select: { queueId: true, sourceModule: true, sourceRecordId: true, transactionType: true, retryCount: true },
      }),
    );
    for (const row of pending) {
      await this.processQueueRow(tenantId, row);
    }
  }

  /**
   * One queue row's worth of work in its own transaction, so a bad row
   * never blocks the rest of the batch. Uses upsert (not create) against
   * ExternalLedgerPosting's unique(tenantId, queueId) constraint so a
   * crash between the insert and the queue-status update is self-healing
   * on retry, rather than either double-posting or throwing a P2002 that
   * would abort the surrounding transaction (Prisma interactive
   * transactions don't savepoint each statement, so a caught exception
   * inside one still leaves it unusable for further queries).
   */
  private async processQueueRow(tenantId: string, row: QueueRow): Promise<void> {
    try {
      await this.prisma.forTenant(tenantId, async (tx) => {
        const entry = await tx.journalEntry.findUnique({
          where: { tenantId_journalEntryId: { tenantId, journalEntryId: row.sourceRecordId } },
          include: { lines: true },
        });
        if (!entry) {
          throw new Error(
            `journal_entries row not found for queue_id=${row.queueId} (source_record_id=${row.sourceRecordId})`,
          );
        }

        const linesJson = entry.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.debitAmount.toString(),
          creditAmount: line.creditAmount.toString(),
          costCenterPlantId: line.costCenterPlantId,
        })) as unknown as Prisma.InputJsonValue;

        const posting = await tx.externalLedgerPosting.upsert({
          where: { tenantId_queueId: { tenantId, queueId: row.queueId } },
          update: {},
          create: {
            tenantId,
            externalPostingId: randomUUID(),
            queueId: row.queueId,
            sourceModule: row.sourceModule,
            transactionType: row.transactionType,
            journalEntryId: row.sourceRecordId,
            linesJson,
            postedExternalId: `CUSTOM-${randomUUID()}`,
            receivedAt: new Date(),
          },
        });

        await tx.integrationQueue.update({
          where: { tenantId_queueId: { tenantId, queueId: row.queueId } },
          data: { queueStatus: 'POSTED', postedExternalId: posting.postedExternalId },
        });
      });
    } catch (err) {
      await this.recordFailure(tenantId, row, err);
    }
  }

  private async recordFailure(tenantId: string, row: QueueRow, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const nextRetryCount = row.retryCount + 1;
    this.logger.warn(
      `sync failed for queue_id=${row.queueId} (attempt ${nextRetryCount}/${MAX_RETRIES}): ${message}`,
    );

    await this.prisma.forTenant(tenantId, async (tx) => {
      if (nextRetryCount >= MAX_RETRIES) {
        await tx.integrationQueue.update({
          where: { tenantId_queueId: { tenantId, queueId: row.queueId } },
          data: { queueStatus: 'FAILED', retryCount: nextRetryCount, lastErrorMessage: message },
        });
        await tx.failedPostingReview.create({
          data: {
            tenantId,
            reviewId: randomUUID(),
            queueId: row.queueId,
            sourceRecordId: row.sourceRecordId,
            errorMessage: message,
            reviewStatus: 'OPEN',
          },
        });
      } else {
        await tx.integrationQueue.update({
          where: { tenantId_queueId: { tenantId, queueId: row.queueId } },
          data: { retryCount: nextRetryCount, lastErrorMessage: message },
        });
      }
    });
  }
}
