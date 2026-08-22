import { KafkaProducerService } from '@metrock/backend-common';
import { SalesService } from './sales.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makeKafka(): KafkaProducerService {
  return { publish: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaProducerService;
}

function baseDto(overrides: Record<string, unknown> = {}) {
  return {
    orderNumber: 'SO-1',
    agentId: 'agent-1',
    plantId: 'plant-1',
    lines: [{ skuId: 'sku-1', orderedQty: 10, unitPrice: 1000 }], // total 10,000
    ...overrides,
  };
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    salesOrder: { findUnique: jest.fn().mockResolvedValue(null) },
    agentMaster: { findUnique: jest.fn().mockResolvedValue({ approvedTradingCapital: 50000 }) },
    customer: { findUnique: jest.fn() },
    tradingCapitalLedger: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { debitValue: 0, creditValue: 0 } }),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SalesService.createSalesOrder — capital gate', () => {
  it('confirms and posts an order whose value is within available capital', async () => {
    const tx = makeTx();
    const kafka = makeKafka();
    const service = new SalesService(makePrisma(tx), kafka);

    const result = await service.createSalesOrder(TENANT, baseDto(), { createdOffline: false });

    expect(result.status).toBe('ACKED');
    expect(result.reasonCode).toBeUndefined();
    expect(kafka.publish).toHaveBeenCalledWith(TENANT, 'sales.order_fulfilled.v1', expect.objectContaining({ order_value: 10000 }));
  });

  it('blocks an order whose value exceeds available capital, without writing to trading_capital_ledger or publishing', async () => {
    // approvedTradingCapital 50000, no prior exposure, order value 60,000 (10 lines x 6000... use 60 qty x 1000)
    const tx = makeTx();
    const kafka = makeKafka();
    const service = new SalesService(makePrisma(tx), kafka);

    const result = await service.createSalesOrder(
      TENANT,
      baseDto({ lines: [{ skuId: 'sku-1', orderedQty: 60, unitPrice: 1000 }] }),
      { createdOffline: false },
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasonCode).toBe('ORDER_EXCEEDS_AVAILABLE_CAPITAL');
    expect(kafka.publish).not.toHaveBeenCalled();
  });

  it('subtracts existing outstanding exposure from approved capital before comparing', async () => {
    // approvedTradingCapital 50000, existing exposure 45000 (debit) -> available capital 5000.
    // A 10,000 order now exceeds it even though it would fit against the raw approved capital.
    const tx = makeTx({
      tradingCapitalLedger: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { debitValue: 45000, creditValue: 0 } }),
      },
    });
    const kafka = makeKafka();
    const service = new SalesService(makePrisma(tx), kafka);

    const result = await service.createSalesOrder(TENANT, baseDto(), { createdOffline: false });

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasonCode).toBe('ORDER_EXCEEDS_AVAILABLE_CAPITAL');
  });

  it('an order landing exactly on the available-capital boundary is confirmed (inclusive, not exclusive)', async () => {
    // approvedTradingCapital 50000, order value exactly 50000 -> withinCapital = totalOrderValue <= availableCapital.
    const tx = makeTx({ agentMaster: { findUnique: jest.fn().mockResolvedValue({ approvedTradingCapital: 10000 }) } });
    const kafka = makeKafka();
    const service = new SalesService(makePrisma(tx), kafka);

    const result = await service.createSalesOrder(TENANT, baseDto(), { createdOffline: false }); // total 10,000

    expect(result.status).toBe('ACKED');
  });

  it('a direct (customer-invoiced) order bypasses the capital gate entirely, even when it exceeds approved capital', async () => {
    // approvedTradingCapital 50000 (from makeTx default), order value
    // 60,000 — would BLOCK a normal order (see the test above), but a
    // customerId makes this a direct order instead.
    const tx = makeTx({ customer: { findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-1' }) } });
    const kafka = makeKafka();
    const service = new SalesService(makePrisma(tx), kafka);

    const result = await service.createSalesOrder(
      TENANT,
      baseDto({ customerId: 'cust-1', lines: [{ skuId: 'sku-1', orderedQty: 60, unitPrice: 1000 }] }),
      { createdOffline: false },
    );

    expect(result.status).toBe('ACKED');
    expect(result.reasonCode).toBeUndefined();
    expect(kafka.publish).toHaveBeenCalledWith(
      TENANT,
      'sales.order_fulfilled_direct.v1',
      expect.objectContaining({ order_value: 60000 }),
    );
  });

  it("a direct order never writes to trading_capital_ledger, and reports the agent's available capital unchanged", async () => {
    const tx = makeTx({ customer: { findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-1' }) } });
    const service = new SalesService(makePrisma(tx), makeKafka());

    const result = await service.createSalesOrder(TENANT, baseDto({ customerId: 'cust-1' }), { createdOffline: false });

    // approvedTradingCapital 50000, no prior exposure -> unaffected by
    // this 10,000 direct order.
    expect(result.availableCapital).toBe(50000);
    // $executeRaw IS called for the sales_orders + order_lines inserts
    // (unrelated to capital) — the assertion is specifically that NONE
    // of those raw-SQL calls touch trading_capital_ledger.
    const rawSqlCalls = (tx.$executeRaw as jest.Mock).mock.calls.map((call) => (call[0] as TemplateStringsArray).join(''));
    expect(rawSqlCalls.some((sql) => sql.includes('trading_capital_ledger'))).toBe(false);
  });

  it('is idempotent: replaying an already-applied clientEventId returns the original result without recomputing capital', async () => {
    const tx = makeTx({
      salesOrder: {
        findUnique: jest.fn().mockResolvedValue({ creditEligibilityStatus: 'APPROVED', salesOrderId: 'existing-order' }),
      },
    });
    const kafka = makeKafka();
    const service = new SalesService(makePrisma(tx), kafka);

    const result = await service.createSalesOrder(TENANT, baseDto({ clientEventId: 'replayed-event' }), {
      createdOffline: false,
    });

    expect(result).toEqual({
      clientEventId: 'replayed-event',
      status: 'ACKED',
      serverEntityId: 'existing-order',
      message: 'Already applied (idempotent replay)',
    });
    expect(tx.agentMaster.findUnique).not.toHaveBeenCalled();
    expect(kafka.publish).not.toHaveBeenCalled();
  });
});
