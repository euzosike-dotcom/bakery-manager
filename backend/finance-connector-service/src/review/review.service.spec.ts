import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PostingAuthorityClient } from '@metrock/backend-common';
import { ReviewService } from './review.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makePostingAuthority(): PostingAuthorityClient {
  return { checkAuthority: jest.fn().mockResolvedValue(undefined) } as unknown as PostingAuthorityClient;
}

const OPEN_REVIEW = {
  reviewId: 'review-1',
  queueId: 'queue-1',
  reviewStatus: 'OPEN',
};

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    failedPostingReview: {
      findUnique: jest.fn().mockResolvedValue(OPEN_REVIEW),
      update: jest.fn().mockResolvedValue(undefined),
    },
    integrationQueue: {
      findUnique: jest.fn().mockResolvedValue({ queueId: 'queue-1', externalSystem: 'CUSTOM_MODULE', queueStatus: 'FAILED' }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe('ReviewService.retry', () => {
  it('checks can_override authority, resets the queue row to PENDING, and resolves the review', async () => {
    const tx = makeTx();
    const postingAuthority = makePostingAuthority();
    const service = new ReviewService(makePrisma(tx), postingAuthority);

    const result = await service.retry(TENANT, 'review-1', 'user-1');

    expect(postingAuthority.checkAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermission: 'can_override', moduleName: 'FINANCE_CONNECTOR' }),
    );
    expect(tx.integrationQueue.update).toHaveBeenCalledWith({
      where: { tenantId_queueId: { tenantId: TENANT, queueId: 'queue-1' } },
      data: { queueStatus: 'PENDING', retryCount: 0, lastErrorMessage: null },
    });
    expect(tx.failedPostingReview.update).toHaveBeenCalledWith({
      where: { tenantId_reviewId: { tenantId: TENANT, reviewId: 'review-1' } },
      data: { reviewStatus: 'RESOLVED', reviewedBy: 'user-1', reviewedTime: expect.any(Date) },
    });
    expect(result).toEqual({ reviewId: 'review-1', action: 'RETRIED', queueId: 'queue-1' });
  });

  it('rejects retrying a queue row that belongs to a different external_system, without touching the queue', async () => {
    // ledger-service's own "no posting rule configured" failure class
    // writes to the same failed_posting_review table with
    // external_system NONE — retrying that row would silently do
    // nothing (nothing re-reads it), so this must be rejected, not
    // quietly no-op.
    const tx = makeTx({
      integrationQueue: {
        findUnique: jest.fn().mockResolvedValue({ queueId: 'queue-1', externalSystem: 'NONE', queueStatus: 'FAILED' }),
        update: jest.fn(),
      },
    });
    const service = new ReviewService(makePrisma(tx), makePostingAuthority());

    await expect(service.retry(TENANT, 'review-1', 'user-1')).rejects.toThrow(BadRequestException);
    expect((tx.integrationQueue as { update: jest.Mock }).update).not.toHaveBeenCalled();
    expect((tx.failedPostingReview as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it('rejects retrying a review that is not OPEN', async () => {
    const tx = makeTx({
      failedPostingReview: {
        findUnique: jest.fn().mockResolvedValue({ ...OPEN_REVIEW, reviewStatus: 'RESOLVED' }),
        update: jest.fn(),
      },
    });
    const service = new ReviewService(makePrisma(tx), makePostingAuthority());

    await expect(service.retry(TENANT, 'review-1', 'user-1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the review does not exist', async () => {
    const tx = makeTx({ failedPostingReview: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() } });
    const service = new ReviewService(makePrisma(tx), makePostingAuthority());

    await expect(service.retry(TENANT, 'missing-review', 'user-1')).rejects.toThrow(NotFoundException);
  });
});

describe('ReviewService.dismiss', () => {
  it('checks can_override authority and resolves the review without touching the queue', async () => {
    const tx = makeTx();
    const postingAuthority = makePostingAuthority();
    const service = new ReviewService(makePrisma(tx), postingAuthority);

    const result = await service.dismiss(TENANT, 'review-1', 'user-1');

    expect(postingAuthority.checkAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermission: 'can_override', moduleName: 'FINANCE_CONNECTOR' }),
    );
    expect(tx.integrationQueue.update).not.toHaveBeenCalled();
    expect(tx.failedPostingReview.update).toHaveBeenCalledWith({
      where: { tenantId_reviewId: { tenantId: TENANT, reviewId: 'review-1' } },
      data: { reviewStatus: 'RESOLVED', reviewedBy: 'user-1', reviewedTime: expect.any(Date) },
    });
    expect(result).toEqual({ reviewId: 'review-1', action: 'DISMISSED' });
  });

  it('rejects dismissing a review that is not OPEN', async () => {
    const tx = makeTx({
      failedPostingReview: {
        findUnique: jest.fn().mockResolvedValue({ ...OPEN_REVIEW, reviewStatus: 'RESOLVED' }),
        update: jest.fn(),
      },
    });
    const service = new ReviewService(makePrisma(tx), makePostingAuthority());

    await expect(service.dismiss(TENANT, 'review-1', 'user-1')).rejects.toThrow(BadRequestException);
  });
});
