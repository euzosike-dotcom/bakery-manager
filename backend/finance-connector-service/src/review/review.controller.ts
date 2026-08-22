import { Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { ReviewService } from './review.service';

@Controller('failed-postings')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.review.findAll(tenant.tenantId);
  }

  @Post(':reviewId/retry')
  retry(@CurrentTenant() tenant: TenantContext, @Param('reviewId') reviewId: string) {
    return this.review.retry(tenant.tenantId, reviewId, tenant.userId);
  }

  @Post(':reviewId/dismiss')
  dismiss(@CurrentTenant() tenant: TenantContext, @Param('reviewId') reviewId: string) {
    return this.review.dismiss(tenant.tenantId, reviewId, tenant.userId);
  }
}
