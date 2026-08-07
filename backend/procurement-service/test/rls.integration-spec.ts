import { randomUUID } from 'crypto';
import { PrismaService } from '../src/common/prisma.service';

/**
 * Real Postgres, real `procurement_svc` least-privilege role (NOT the
 * `metrock` superuser bootstrap role, which bypasses RLS unconditionally
 * and would prove nothing — see docs/RUNBOOK.md's "Least-privilege app
 * role + RLS verification"). This is the exact 3-scenario proof that
 * section has documented as a MANUAL psql check since the very first
 * vertical slice; automating it here is Phase 3 of the CI + test suite
 * plan closing that gap, not a new claim.
 *
 * Requires DATABASE_URL pointing at a real database with
 * infra/postgres/migrations + infra/postgres/seed/dev_seed.sql already
 * applied, using procurement_svc credentials — set explicitly by CI's
 * Postgres service-container job, or by sourcing backend/procurement-
 * service/.env locally. Not run as part of `npm test` (see jest-e2e.json)
 * — these hit a real database and must not run in the same pass as the
 * fully-mocked Phase 1/2 unit suite.
 */
const SEEDED_TENANT_ID = 'b17d9226-2a43-43eb-8c5e-a923637b23c5'; // METROCK, dev_seed.sql

describe('Row-Level Security — purchase_orders (real Postgres, real procurement_svc role)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the seeded rows when scoped to the correct tenant', async () => {
    const rows = await prisma.forTenant(SEEDED_TENANT_ID, (tx) => tx.purchaseOrder.findMany());

    // dev_seed.sql + procurement_approval_seed.sql together guarantee at
    // least PO-2026-00001 exists for this tenant — real seeded data, not a
    // fixture invented for this test.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === SEEDED_TENANT_ID)).toBe(true);
  });

  it('returns zero rows when scoped to a different (but syntactically valid) tenant — cross-tenant isolation', async () => {
    // A random UUID needs no corresponding tenant_registry row to prove
    // this: the RLS policy is a plain `tenant_id = current_tenant_id()`
    // comparison on purchase_orders itself, it never joins out to
    // tenant_registry to validate the tenant exists.
    const foreignTenantId = randomUUID();

    const rows = await prisma.forTenant(foreignTenantId, (tx) => tx.purchaseOrder.findMany());

    expect(rows).toEqual([]);
  });

  it('returns zero rows when no tenant context is set at all — fails closed, not open', async () => {
    // Deliberately NOT using forTenant here — this proves the fail-closed
    // default itself: current_tenant_id() reads current_setting('app.tenant_id',
    // true), which is NULL when unset, and `tenant_id = NULL` is never
    // true under SQL's three-valued logic, so FORCE ROW LEVEL SECURITY
    // denies every row rather than erroring or (worse) allowing everything.
    const rows = await prisma.purchaseOrder.findMany();

    expect(rows).toEqual([]);
  });
});
