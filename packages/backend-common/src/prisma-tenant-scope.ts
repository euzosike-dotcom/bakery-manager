/**
 * The tenant-scoping logic behind every service's `PrismaService.forTenant`
 * — pinning the Postgres session variable `app.tenant_id` that RLS policies
 * check on every row (infra/postgres/migrations/006_rls.sql,
 * 009_manufacturing_rls_and_role.sql, 011_sales_rls_and_role.sql).
 *
 * This can't be a single shared `PrismaService` class the way the other
 * files in this package are shared verbatim: each domain service has its
 * own generated `@prisma/client` (different schema.prisma -> different
 * `Prisma.TransactionClient` type), so there's no one concrete type this
 * package could import. Instead, each service's own `PrismaService` stays
 * a thin subclass of ITS OWN generated `PrismaClient`, and calls this
 * function to do the actual work — the logic is shared, the generated
 * types are not.
 *
 * `SET LOCAL`-equivalent scoping via `set_config(..., true)` is
 * transaction-scoped, so the tenant context can never leak across requests
 * even under connection pooling.
 */

interface TenantScopedTxClient {
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}

interface TenantScopedClient<TxClient> {
  $transaction: <T>(fn: (tx: TxClient) => Promise<T>) => Promise<T>;
}

export async function forTenant<TxClient extends TenantScopedTxClient, T>(
  client: TenantScopedClient<TxClient>,
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId)) {
    throw new Error(`Invalid tenantId: ${tenantId}`);
  }
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
