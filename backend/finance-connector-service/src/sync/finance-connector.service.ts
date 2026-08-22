import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ConnectorRegistry } from '../connectors/connector-registry';

const MAX_RETRIES = 3;
const BATCH_SIZE = 20;

interface QueueRow {
  queueId: string;
  sourceModule: string;
  sourceRecordId: string;
  transactionType: string;
  externalSystem: string;
  retryCount: number;
}

/**
 * The consumer side of integration_queue (005_finance.sql) — pluggable
 * per tenant_registry.finance_connector_type via ConnectorRegistry (see
 * connectors/connector-strategy.ts): today that's only ever
 * 'CUSTOM_MODULE' in practice (Metrock's own custom finance module),
 * since Zoho Books/QuickBooks/Xero/SAP have no real implementation yet —
 * this service itself doesn't know or care which; it just looks up
 * whatever strategy a row's own external_system names.
 *
 * This is the first cross-tenant background job in this platform's NestJS
 * services — every other service is request-scoped by an incoming
 * x-tenant-id header, so there is no request to inherit a tenant from.
 * Instead, each poll tick enumerates tenant_registry itself for tenants
 * with ANY connector configured (financeConnectorType != 'NONE'), then
 * runs a separate PrismaService.forTenant-scoped pass per tenant — the
 * same RLS session-variable mechanism every request-scoped service
 * already uses, just driven by a timer instead of a controller.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorRegistry,
  ) {}

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
      where: { financeConnectorType: { not: 'NONE' } },
      select: { tenantId: true },
    });
    for (const { tenantId } of tenants) {
      await this.pollTenant(tenantId);
    }
  }

  async pollTenant(tenantId: string): Promise<void> {
    const pending = await this.prisma.forTenant(tenantId, (tx) =>
      tx.integrationQueue.findMany({
        where: { queueStatus: 'PENDING', externalSystem: { not: 'NONE' } },
        orderBy: { queuedTime: 'asc' },
        take: BATCH_SIZE,
        select: {
          queueId: true,
          sourceModule: true,
          sourceRecordId: true,
          transactionType: true,
          externalSystem: true,
          retryCount: true,
        },
      }),
    );
    for (const row of pending) {
      await this.processQueueRow(tenantId, row);
    }
  }

  /**
   * One queue row's worth of work, so a bad row never blocks the rest of
   * the batch. The connector's own `post()` runs OUTSIDE any open
   * transaction (see ConnectorStrategy's doc comment — a real
   * implementation may make a slow network call), so this method reads
   * the journal entry in one short transaction, calls the connector, and
   * records the result in a second short transaction — never one long
   * transaction spanning the external call.
   */
  private async processQueueRow(tenantId: string, row: QueueRow): Promise<void> {
    try {
      const entry = await this.prisma.forTenant(tenantId, (tx) =>
        tx.journalEntry.findUnique({
          where: { tenantId_journalEntryId: { tenantId, journalEntryId: row.sourceRecordId } },
          include: { lines: true },
        }),
      );
      if (!entry) {
        throw new Error(
          `journal_entries row not found for queue_id=${row.queueId} (source_record_id=${row.sourceRecordId})`,
        );
      }

      const strategy = this.connectors.get(row.externalSystem);
      const result = await strategy.post(tenantId, row, {
        journalEntryId: entry.journalEntryId,
        sourceModule: row.sourceModule,
        transactionType: row.transactionType,
        lines: entry.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.debitAmount.toString(),
          creditAmount: line.creditAmount.toString(),
          costCenterPlantId: line.costCenterPlantId,
        })),
      });

      await this.prisma.forTenant(tenantId, (tx) =>
        tx.integrationQueue.update({
          where: { tenantId_queueId: { tenantId, queueId: row.queueId } },
          data: { queueStatus: 'POSTED', postedExternalId: result.postedExternalId },
        }),
      );
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
