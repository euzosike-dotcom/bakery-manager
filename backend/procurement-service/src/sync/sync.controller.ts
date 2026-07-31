import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentTenant } from '../common/current-tenant.decorator';
import { TenantContext } from '../common/tenant-context.middleware';
import { SyncPushRequestDto } from '../procurement/dto/goods-receipt.dto';
import { PullableEntity, SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  push(@CurrentTenant() tenant: TenantContext, @Body() body: SyncPushRequestDto) {
    return this.sync.push(tenant.tenantId, body.events).then((results) => ({ results }));
  }

  @Get('pull')
  pull(
    @CurrentTenant() tenant: TenantContext,
    @Query('entity') entity: PullableEntity,
    @Query('since') since = '0',
    @Query('limit') limit = '200',
  ) {
    return this.sync.pull(tenant.tenantId, entity, BigInt(since), Math.min(Number(limit) || 200, 500));
  }
}
