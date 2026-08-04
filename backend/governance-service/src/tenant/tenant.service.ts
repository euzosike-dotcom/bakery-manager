import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  async findCurrent(tenantId: string) {
    // No forTenant/RLS needed here — tenant_registry has no tenant_id
    // column to scope BY, it IS the tenant table (tenant_id is its own
    // primary key), so this is a direct lookup by that key.
    const tenant = await this.prisma.tenantRegistry.findUnique({ where: { tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);
    return tenant;
  }
}
