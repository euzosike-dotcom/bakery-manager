import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';

const EXTERNAL_SYSTEM = 'CUSTOM_MODULE';

/**
 * The dead-letter path's missing other half: `failed_posting_review`
 * rows (FinanceConnectorService's own escalation after 3 exhausted
 * retries, see sync/finance-connector.service.ts) were queryable via SQL
 * but nothing could act on one from the API — README "Known gaps"
 * before this pass.
 *
 * Gated by `can_override`, not `can_post` — the first real use of that
 * permission field anywhere in this platform (every other online-only
 * finance action uses `can_post`; `can_override` has existed on `roles`
 * since governance-service shipped but nothing ever required it). Acting
 * on a dead-lettered item is semantically an override of the connector's
 * own give-up decision, not a routine "record this transaction" action —
 * `can_override` is the permission this platform already modeled for
 * exactly that distinction, just never exercised until now.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.failedPostingReview.findMany({ where: { reviewStatus: 'OPEN' }, orderBy: { reviewId: 'asc' } }),
    );
  }

  async retry(tenantId: string, reviewId: string, userId: string | undefined) {
    await this.postingAuthority.checkAuthority({
      tenantId,
      userId,
      requiredPermission: 'can_override',
      moduleName: 'FINANCE_CONNECTOR',
      recordIdRef: reviewId,
    });

    return this.prisma.forTenant(tenantId, async (tx) => {
      const review = await tx.failedPostingReview.findUnique({ where: { tenantId_reviewId: { tenantId, reviewId } } });
      if (!review) throw new NotFoundException(`failed_posting_review ${reviewId} not found`);
      if (review.reviewStatus !== 'OPEN') {
        throw new BadRequestException(`failed_posting_review ${reviewId} is already ${review.reviewStatus}`);
      }

      const queueRow = await tx.integrationQueue.findUnique({
        where: { tenantId_queueId: { tenantId, queueId: review.queueId } },
      });
      if (!queueRow) throw new NotFoundException(`integration_queue row ${review.queueId} not found`);

      // A review can, in principle, point at a queue row this connector
      // never owned — e.g. ledger-service's own "no posting rule
      // configured" failure class also writes to this same table
      // (posting_engine.go's recordFailure), but with external_system
      // NONE, not CUSTOM_MODULE. Retrying THAT row by resetting it to
      // PENDING would be a silent no-op: nothing ever re-reads it —
      // ledger-service doesn't poll integration_queue the way this
      // service's own poller does — so it would look like success while
      // doing nothing. Reject explicitly rather than let that happen
      // quietly.
      if (queueRow.externalSystem !== EXTERNAL_SYSTEM) {
        throw new BadRequestException(
          `integration_queue row ${review.queueId} belongs to external_system=${queueRow.externalSystem}, not ${EXTERNAL_SYSTEM} — this connector did not cause this failure and cannot retry it`,
        );
      }
      if (queueRow.queueStatus !== 'FAILED') {
        throw new BadRequestException(
          `integration_queue row ${review.queueId} is ${queueRow.queueStatus}, not FAILED — nothing to retry`,
        );
      }

      await tx.integrationQueue.update({
        where: { tenantId_queueId: { tenantId, queueId: review.queueId } },
        data: { queueStatus: 'PENDING', retryCount: 0, lastErrorMessage: null },
      });
      await tx.failedPostingReview.update({
        where: { tenantId_reviewId: { tenantId, reviewId } },
        data: { reviewStatus: 'RESOLVED', reviewedBy: userId ?? null, reviewedTime: new Date() },
      });

      return { reviewId, action: 'RETRIED' as const, queueId: review.queueId };
    });
  }

  async dismiss(tenantId: string, reviewId: string, userId: string | undefined) {
    await this.postingAuthority.checkAuthority({
      tenantId,
      userId,
      requiredPermission: 'can_override',
      moduleName: 'FINANCE_CONNECTOR',
      recordIdRef: reviewId,
    });

    return this.prisma.forTenant(tenantId, async (tx) => {
      const review = await tx.failedPostingReview.findUnique({ where: { tenantId_reviewId: { tenantId, reviewId } } });
      if (!review) throw new NotFoundException(`failed_posting_review ${reviewId} not found`);
      if (review.reviewStatus !== 'OPEN') {
        throw new BadRequestException(`failed_posting_review ${reviewId} is already ${review.reviewStatus}`);
      }

      await tx.failedPostingReview.update({
        where: { tenantId_reviewId: { tenantId, reviewId } },
        data: { reviewStatus: 'RESOLVED', reviewedBy: userId ?? null, reviewedTime: new Date() },
      });

      return { reviewId, action: 'DISMISSED' as const };
    });
  }
}
