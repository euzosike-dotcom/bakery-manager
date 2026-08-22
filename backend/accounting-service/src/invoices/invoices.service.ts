import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { RecordInvoicePaymentDto } from './dto/invoice-payment.dto';

export interface SalesOrderFulfilledEvent {
  eventId: string;
  tenantId: string;
  salesOrderId: string;
  orderValue: number;
  postedAt: string;
}

const INVOICE_NET_DAYS = 30;

/**
 * Auto-generates a Customer Invoice from a sales order fulfillment event —
 * `sales.order_fulfilled.v1` (agent-capital orders) or
 * `sales.order_fulfilled_direct.v1` (customer-invoiced orders) — but ONLY
 * actually raises an invoice when the order carries a CRM customer_id
 * (migration 012); an order with no customer_id has no AR paperwork to
 * raise here. In practice every `_direct` order has one by construction
 * (sales.service.ts only publishes that event type when `dto.customerId`
 * is set), so this branch is effectively always taken for that event type
 * and effectively never taken for the original one.
 *
 * `recordPayment` below now credits a dedicated receivable (`1220`, see
 * `029_ncr_invoice_reconciliation.sql`), NOT the Agent Wallet (`1210`)
 * NCR verification credits — the reconciliation migration 014's header
 * comment originally flagged as unresolved. See docs/RUNBOOK.md's "NCR /
 * invoice-payment reconciliation" section for the full resolution and its
 * reasoning.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async handleSalesOrderFulfilled(event: SalesOrderFulfilledEvent): Promise<void> {
    await this.prisma.forTenant(event.tenantId, async (tx) => {
      const existing = await tx.customerInvoice.findUnique({
        where: { tenantId_sourceEventId: { tenantId: event.tenantId, sourceEventId: event.eventId } },
      });
      if (existing) {
        this.logger.log(`sales.order_fulfilled.v1 eventId=${event.eventId} already applied — idempotent no-op`);
        return;
      }

      const order = await tx.salesOrder.findUnique({
        where: { tenantId_salesOrderId: { tenantId: event.tenantId, salesOrderId: event.salesOrderId } },
      });
      if (!order) throw new NotFoundException(`Sales order ${event.salesOrderId} not found`);

      if (!order.customerId) {
        this.logger.log(`salesOrderId=${event.salesOrderId} has no customer_id — no invoice to raise`);
        return;
      }

      const invoiceDate = new Date();
      const dueDate = new Date(invoiceDate);
      dueDate.setDate(dueDate.getDate() + INVOICE_NET_DAYS);

      await tx.customerInvoice.create({
        data: {
          tenantId: event.tenantId,
          invoiceId: randomUUID(),
          invoiceNumber: `INV-${event.salesOrderId}`,
          customerId: order.customerId,
          salesOrderId: event.salesOrderId,
          plantId: order.plantId,
          invoiceDate,
          dueDate,
          totalAmount: event.orderValue,
          amountPaid: 0,
          invoiceStatus: 'OPEN',
          sourceEventId: event.eventId,
          createdAt: new Date(),
        },
      });
    });
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.customerInvoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async findOne(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.forTenant(tenantId, (tx) =>
      tx.customerInvoice.findUnique({
        where: { tenantId_invoiceId: { tenantId, invoiceId } },
        include: { payments: true },
      }),
    );
    if (!invoice) throw new NotFoundException(`Customer invoice ${invoiceId} not found`);
    return invoice;
  }

  async recordPayment(tenantId: string, invoiceId: string, dto: RecordInvoicePaymentDto, userId: string | undefined) {
    await this.postingAuthority.checkAuthority({
      tenantId,
      userId,
      requiredPermission: 'can_post',
      moduleName: 'ACCOUNTING',
      recordIdRef: invoiceId,
    });

    const paymentId = randomUUID();

    const invoice = await this.prisma.forTenant(tenantId, async (tx) => {
      const current = await tx.customerInvoice.findUnique({ where: { tenantId_invoiceId: { tenantId, invoiceId } } });
      if (!current) throw new NotFoundException(`Customer invoice ${invoiceId} not found`);

      const newAmountPaid = Number(current.amountPaid) + dto.amount;
      if (newAmountPaid > Number(current.totalAmount)) {
        throw new BadRequestException(
          `Payment of ${dto.amount} would exceed the invoice's outstanding balance (${Number(current.totalAmount) - Number(current.amountPaid)})`,
        );
      }

      await tx.customerInvoicePayment.create({
        data: {
          tenantId,
          paymentId,
          invoiceId,
          paymentDate: new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod ?? 'BANK_TRANSFER',
          referenceNo: dto.referenceNo,
          createdAt: new Date(),
        },
      });

      return tx.customerInvoice.update({
        where: { tenantId_invoiceId: { tenantId, invoiceId } },
        data: {
          amountPaid: newAmountPaid,
          invoiceStatus: newAmountPaid >= Number(current.totalAmount) ? 'PAID' : 'PARTIALLY_PAID',
        },
      });
    });

    await this.kafka.publish(tenantId, 'accounting.invoice_payment_received.v1', {
      event_id: paymentId,
      tenant_id: tenantId,
      invoice_id: invoiceId,
      payment_amount: dto.amount,
      posted_at: new Date().toISOString(),
    });

    return invoice;
  }
}
