import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { ERP_EVENTS_TOPIC } from '@metrock/backend-common';
import { BillsService } from '../bills/bills.service';
import { InvoicesService } from '../invoices/invoices.service';

/**
 * A second, independent Kafka consumer group on the platform's single
 * erp.events topic — ledger-service (Go) already consumes this same topic
 * in its own group to post journal entries; this one exists purely to
 * auto-generate Vendor Bills / Customer Invoices from the same events, and
 * knows nothing about ledger-service's group or offsets (kafkajs docs: two
 * distinct group ids each get their own full copy of every message).
 *
 * Runs as a background loop inside this same Nest process — `consumer.run`
 * registers an `eachMessage` callback and returns immediately; it does not
 * block Nest's HTTP bootstrap.
 */
@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;

  constructor(
    private readonly bills: BillsService,
    private readonly invoices: InvoicesService,
  ) {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
    const groupId = process.env.KAFKA_CONSUMER_GROUP ?? 'accounting-service';
    this.kafka = new Kafka({ clientId: 'accounting-service', brokers });
    this.consumer = this.kafka.consumer({ groupId });
  }

  async onModuleInit() {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: ERP_EVENTS_TOPIC, fromBeginning: true });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        try {
          await this.handle(JSON.parse(message.value.toString()));
        } catch (err) {
          // Log and move on rather than blocking the partition — mirrors
          // ledger-service's failure handling for the same topic.
          this.logger.error(`failed to handle event: ${(err as Error).message}`);
        }
      },
    });
  }

  async onModuleDestroy() {
    await this.consumer.disconnect();
  }

  private async handle(event: Record<string, unknown>): Promise<void> {
    switch (event.event_type) {
      case 'grn.posted.v1':
        await this.bills.handleGrnPosted({
          eventId: event.event_id as string,
          tenantId: event.tenant_id as string,
          grnId: event.grn_id as string,
          poLineId: event.po_line_id as string,
          plantId: event.plant_id as string,
          acceptedValue: event.accepted_value as number,
          postedAt: event.posted_at as string,
        });
        break;
      case 'sales.order_fulfilled.v1':
      case 'sales.order_fulfilled_direct.v1':
        // Both event types reach the same handler — it already branches
        // on the order's own customerId (see its doc comment), and every
        // _direct order has one by construction (docs/RUNBOOK.md's "NCR /
        // invoice-payment reconciliation" section), so no behavior change
        // is needed here beyond also listening for the new type.
        await this.invoices.handleSalesOrderFulfilled({
          eventId: event.event_id as string,
          tenantId: event.tenant_id as string,
          salesOrderId: event.sales_order_id as string,
          orderValue: event.order_value as number,
          postedAt: event.posted_at as string,
        });
        break;
      default:
        // Every other event type on this topic (batch.*, ncr.verified.v1,
        // this module's own accounting.*.v1) is irrelevant here — silently
        // skipped, same as ledger-service's `sourceModuleFor` default case.
        break;
    }
  }
}
