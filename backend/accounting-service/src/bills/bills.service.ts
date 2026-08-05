import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { RecordBillPaymentDto } from './dto/bill-payment.dto';

export interface GrnPostedEvent {
  eventId: string;
  tenantId: string;
  grnId: string;
  poLineId: string;
  plantId: string;
  acceptedValue: number;
  postedAt: string;
}

/** NET_30 / NET_45 / NET_60 -> integer days. Falls back to 30 for anything
 * else (COD, null, an unrecognized format) — a bill still needs SOME due
 * date and 30 is this platform's existing default elsewhere. */
function paymentTermsToDays(paymentTerms: string | null | undefined): number {
  const match = /^NET_(\d+)$/.exec(paymentTerms ?? '');
  return match ? Number(match[1]) : 30;
}

/**
 * Auto-generates Vendor Bills from the same grn.posted.v1 event
 * ledger-service already consumes (a second, independent Kafka consumer
 * group on erp.events — see src/kafka/kafka-consumer.service.ts). One bill
 * per GRN, aggregating across that GRN's lines, since the event fires once
 * per goods-receipt LINE but a real vendor bill is per delivery.
 */
@Injectable()
export class BillsService {
  private readonly logger = new Logger(BillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly postingAuthority: PostingAuthorityClient,
  ) {}

  async handleGrnPosted(event: GrnPostedEvent): Promise<void> {
    await this.prisma.forTenant(event.tenantId, async (tx) => {
      // Idempotency: a re-delivered grn.posted.v1 (consumer crash/retry)
      // must not double-add this line's value to the bill total. Checking
      // for the line first, before touching the bill at all, makes the
      // whole handler a no-op on replay.
      const existingLine = await tx.vendorBillLine.findUnique({
        where: { tenantId_sourceEventId: { tenantId: event.tenantId, sourceEventId: event.eventId } },
      });
      if (existingLine) {
        this.logger.log(`grn.posted.v1 eventId=${event.eventId} already applied — idempotent no-op`);
        return;
      }

      const poLine = await tx.purchaseOrderLine.findUnique({
        where: { tenantId_poLineId: { tenantId: event.tenantId, poLineId: event.poLineId } },
      });
      if (!poLine) throw new NotFoundException(`PO line ${event.poLineId} not found`);

      const po = await tx.purchaseOrder.findUnique({
        where: { tenantId_poId: { tenantId: event.tenantId, poId: poLine.poId } },
      });
      if (!po) throw new NotFoundException(`Purchase order ${poLine.poId} not found`);

      let bill = await tx.vendorBill.findUnique({
        where: { tenantId_grnId: { tenantId: event.tenantId, grnId: event.grnId } },
      });

      if (!bill) {
        const billDate = new Date();
        const dueDate = new Date(billDate);
        dueDate.setDate(dueDate.getDate() + paymentTermsToDays(po.paymentTerms));

        bill = await tx.vendorBill.create({
          data: {
            tenantId: event.tenantId,
            billId: randomUUID(),
            billNumber: `BILL-${event.grnId}`,
            supplierId: po.supplierId,
            plantId: event.plantId,
            grnId: event.grnId,
            billDate,
            dueDate,
            totalAmount: 0,
            amountPaid: 0,
            billStatus: 'OPEN',
            createdAt: new Date(),
          },
        });
      }

      await tx.vendorBillLine.create({
        data: {
          tenantId: event.tenantId,
          billLineId: randomUUID(),
          billId: bill.billId,
          sourceEventId: event.eventId,
          lineValue: event.acceptedValue,
        },
      });

      await tx.vendorBill.update({
        where: { tenantId_billId: { tenantId: event.tenantId, billId: bill.billId } },
        data: { totalAmount: { increment: event.acceptedValue } },
      });
    });

    this.logger.log(`vendor bill upserted for grnId=${event.grnId} (line eventId=${event.eventId})`);
  }

  findAll(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.vendorBill.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async findOne(tenantId: string, billId: string) {
    const bill = await this.prisma.forTenant(tenantId, (tx) =>
      tx.vendorBill.findUnique({
        where: { tenantId_billId: { tenantId, billId } },
        include: { lines: true, payments: true },
      }),
    );
    if (!bill) throw new NotFoundException(`Vendor bill ${billId} not found`);
    return bill;
  }

  async recordPayment(tenantId: string, billId: string, dto: RecordBillPaymentDto, userId: string | undefined) {
    await this.postingAuthority.checkAuthority({
      tenantId,
      userId,
      requiredPermission: 'can_post',
      moduleName: 'ACCOUNTING',
      recordIdRef: billId,
    });

    const paymentId = randomUUID();

    const bill = await this.prisma.forTenant(tenantId, async (tx) => {
      const current = await tx.vendorBill.findUnique({ where: { tenantId_billId: { tenantId, billId } } });
      if (!current) throw new NotFoundException(`Vendor bill ${billId} not found`);

      const newAmountPaid = Number(current.amountPaid) + dto.amount;
      if (newAmountPaid > Number(current.totalAmount)) {
        throw new BadRequestException(
          `Payment of ${dto.amount} would exceed the bill's outstanding balance (${Number(current.totalAmount) - Number(current.amountPaid)})`,
        );
      }

      await tx.vendorBillPayment.create({
        data: {
          tenantId,
          paymentId,
          billId,
          paymentDate: new Date(),
          amount: dto.amount,
          paymentMethod: dto.paymentMethod ?? 'BANK_TRANSFER',
          referenceNo: dto.referenceNo,
          createdAt: new Date(),
        },
      });

      return tx.vendorBill.update({
        where: { tenantId_billId: { tenantId, billId } },
        data: {
          amountPaid: newAmountPaid,
          billStatus: newAmountPaid >= Number(current.totalAmount) ? 'PAID' : 'PARTIALLY_PAID',
        },
      });
    });

    await this.kafka.publish(tenantId, 'accounting.bill_paid.v1', {
      event_id: paymentId,
      tenant_id: tenantId,
      bill_id: billId,
      payment_amount: dto.amount,
      posted_at: new Date().toISOString(),
    });

    return bill;
  }
}
