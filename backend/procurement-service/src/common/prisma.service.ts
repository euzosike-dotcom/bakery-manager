import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { forTenant } from '@metrock/backend-common';

/**
 * Wraps this service's generated PrismaClient with the shared tenant-
 * scoping helper (`@metrock/backend-common`'s `forTenant`). Every domain
 * query MUST go through `forTenant`, never through the bare PrismaClient —
 * see that function's doc comment for why, and why this thin per-service
 * subclass exists instead of one fully-shared PrismaService (each service
 * has its own generated `Prisma.TransactionClient` type).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  forTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return forTenant(this, tenantId, fn);
  }
}
