import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

type TxClient = Prisma.TransactionClient;

/**
 * Wraps PrismaClient with a tenant-scoped transaction helper.
 *
 * Every domain query MUST go through `forTenant`, never through the bare
 * PrismaClient — that's what pins the Postgres session variable
 * `app.tenant_id` that the RLS policies (infra/postgres/migrations/006_rls.sql)
 * check on every row. `SET LOCAL`-equivalent scoping via `set_config(..., true)`
 * is transaction-scoped, so the tenant context can never leak across requests
 * even under connection pooling.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async forTenant<T>(tenantId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) {
      throw new Error(`Invalid tenantId: ${tenantId}`);
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
