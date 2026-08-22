import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { CreateSalesOrderDto, SyncPushResultDto } from './dto/sales-order.dto';

export interface CreateSalesOrderOptions {
  createdOffline: boolean;
}

/**
 * The centerpiece rule from the original PRD/Zoho proposal (docs/SDD.md
 * §3.D): "If Order Volume > Available Capital -> Block Transaction".
 *
 * Available capital is recomputed from `trading_capital_ledger` INSIDE the
 * same transaction as the order write — never read outside it and never
 * trusted from any cache, client or otherwise (SDD §2.3 scenario #7: a
 * client's local check is advisory only; this is the hard gate). Doing the
 * read and the `trading_capital_ledger` insert in one transaction is what
 * closes the race where two rapid orders from the same agent could each
 * see stale "before" exposure and both pass.
 *
 * A customer-invoiced ("direct") order — one with `dto.customerId` set —
 * bypasses this gate ENTIRELY (docs/RUNBOOK.md's "NCR / invoice-payment
 * reconciliation" section): its credit risk belongs to the company's
 * direct relationship with a known, CRM-tracked customer
 * (accounting-service's `customer_invoices`, its own due date), not to
 * the agent's trading capital. It never writes `trading_capital_ledger`
 * and publishes a different event type (`sales.order_fulfilled_direct.v1`,
 * routed by `029_ncr_invoice_reconciliation.sql`'s posting rule to a
 * dedicated receivable, `1220`) so NCR (agent-level, credits `1210`) and
 * invoice payment (order-level, now credits `1220`) never resolve the
 * same GL account again.
 */
@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async createSalesOrder(
    tenantId: string,
    dto: CreateSalesOrderDto,
    options: CreateSalesOrderOptions,
  ): Promise<SyncPushResultDto> {
    const clientEventId = dto.clientEventId ?? randomUUID();

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.salesOrder.findUnique({ where: { tenantId_clientEventId: { tenantId, clientEventId } } }),
    );
    if (existing) {
      this.logger.log(`Order clientEventId=${clientEventId} already applied — idempotent no-op`);
      return {
        clientEventId,
        status: existing.creditEligibilityStatus === 'BLOCKED' ? 'NEEDS_REVIEW' : 'ACKED',
        serverEntityId: existing.salesOrderId,
        message: 'Already applied (idempotent replay)',
      };
    }

    const totalOrderValue = dto.lines.reduce((sum, l) => sum + l.orderedQty * l.unitPrice, 0);
    const isDirect = Boolean(dto.customerId);

    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const agent = await tx.agentMaster.findUnique({ where: { tenantId_agentId: { tenantId, agentId: dto.agentId } } });
      if (!agent) throw new NotFoundException(`Agent ${dto.agentId} not found`);

      if (dto.customerId) {
        const customer = await tx.customer.findUnique({
          where: { tenantId_customerId: { tenantId, customerId: dto.customerId } },
        });
        if (!customer) throw new NotFoundException(`Customer ${dto.customerId} not found`);
      }

      // Live computation, inside this transaction — see class doc comment.
      const aggregate = await tx.tradingCapitalLedger.aggregate({
        where: { tenantId, agentId: dto.agentId },
        _sum: { debitValue: true, creditValue: true },
      });
      const outstandingExposure = Number(aggregate._sum.debitValue ?? 0) - Number(aggregate._sum.creditValue ?? 0);
      const availableCapital = Number(agent.approvedTradingCapital) - outstandingExposure;
      // A direct (customer-invoiced) order never consumes agent capital —
      // see class doc comment — so it's always within "capital" by
      // definition, regardless of the agent's actual exposure.
      const withinCapital = isDirect ? true : totalOrderValue <= availableCapital;

      const salesOrderId = dto.salesOrderId ?? randomUUID();
      const orderStatus = withinCapital ? 'CONFIRMED' : 'NEEDS_REVIEW';
      const creditEligibilityStatus = withinCapital ? 'APPROVED' : 'BLOCKED';

      await tx.$executeRaw`
        INSERT INTO sales_orders (
          tenant_id, sales_order_id, order_number, agent_id, plant_id, customer_id, order_date,
          total_order_value, order_status, credit_eligibility_status,
          client_event_id, device_id, created_offline
        ) VALUES (
          ${tenantId}::uuid, ${salesOrderId}::uuid, ${dto.orderNumber}, ${dto.agentId}::uuid, ${dto.plantId}::uuid,
          ${dto.customerId ?? null}::uuid,
          ${dto.orderDate ? new Date(dto.orderDate) : new Date()}, ${totalOrderValue}, ${orderStatus},
          ${creditEligibilityStatus}, ${clientEventId}::uuid, ${dto.deviceId ?? null}::uuid, ${options.createdOffline}
        )
      `;

      for (const line of dto.lines) {
        await tx.$executeRaw`
          INSERT INTO order_lines (tenant_id, order_line_id, sales_order_id, sku_id, ordered_qty, unit_price)
          VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${salesOrderId}::uuid, ${line.skuId}::uuid, ${line.orderedQty}, ${line.unitPrice})
        `;
      }

      if (withinCapital && !isDirect) {
        // Synchronous, same-transaction write to the operational sub-ledger
        // that gates future orders — this is NOT the GL journal entry
        // (that's posted asynchronously by ledger-service, see below).
        // Skipped for direct orders — see class doc comment.
        await tx.$executeRaw`
          INSERT INTO trading_capital_ledger (tenant_id, tcl_entry_id, agent_id, entry_type, reference_no, debit_value, credit_value)
          VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${dto.agentId}::uuid, 'DEBIT_EXPOSURE', ${dto.orderNumber}, ${totalOrderValue}, 0)
        `;
      }

      return {
        salesOrderId,
        orderStatus,
        creditEligibilityStatus,
        // A direct order never touched exposure, so the agent's available
        // capital is simply whatever it already was.
        availableCapital: isDirect ? availableCapital : availableCapital - (withinCapital ? totalOrderValue : 0),
      };
    });

    if (result.creditEligibilityStatus === 'APPROVED') {
      await this.kafka.publish(tenantId, isDirect ? 'sales.order_fulfilled_direct.v1' : 'sales.order_fulfilled.v1', {
        event_id: randomUUID(),
        tenant_id: tenantId,
        sales_order_id: result.salesOrderId,
        agent_id: dto.agentId,
        order_value: totalOrderValue,
        posted_at: new Date().toISOString(),
      });
    }

    return {
      clientEventId,
      status: result.creditEligibilityStatus === 'BLOCKED' ? 'NEEDS_REVIEW' : 'ACKED',
      serverEntityId: result.salesOrderId,
      availableCapital: result.availableCapital,
      reasonCode: result.creditEligibilityStatus === 'BLOCKED' ? 'ORDER_EXCEEDS_AVAILABLE_CAPITAL' : undefined,
      message:
        result.creditEligibilityStatus === 'BLOCKED'
          ? 'Order value exceeds available trading capital — order recorded but not confirmed; routed for supervisor review.'
          : 'Order confirmed and posted to the ledger.',
    };
  }
}
