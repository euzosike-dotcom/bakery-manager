import { Controller, Get } from '@nestjs/common';
import { CurrentTenant, TenantContext } from '@metrock/backend-common';
import { PostingsService } from './postings.service';

/**
 * Read-only verification surface for what the custom finance module has
 * received so far — mirrors every other module's list-endpoint
 * convention. There is no create/update route here on purpose: postings
 * only ever arrive via FinanceConnectorService's poller, never a direct
 * user or API action.
 */
@Controller('external-postings')
export class PostingsController {
  constructor(private readonly postings: PostingsService) {}

  @Get()
  findAll(@CurrentTenant() tenant: TenantContext) {
    return this.postings.findAll(tenant.tenantId);
  }
}
