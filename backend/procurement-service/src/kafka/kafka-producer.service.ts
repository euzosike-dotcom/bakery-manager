import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';

export const ERP_EVENTS_TOPIC = 'erp.events';

/**
 * Thin wrapper around the platform's single event topic. All domain events
 * (grn.posted.v1, batch.output_recorded.v1, sales.order_fulfilled.v1, ...)
 * flow through this one topic, partitioned by tenantId so that a given
 * tenant's events are strictly ordered on one partition (SDD §1.1/§2.2).
 * Downstream consumers (Go ledger-service, Audit service) filter by
 * `event_type` in the payload.
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly kafka: Kafka;
  private producer: Producer;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
    this.kafka = new Kafka({ clientId: 'procurement-service', brokers });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
  }

  async onModuleInit() {
    await this.producer.connect();
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
  }

  async publish(tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    const message = { event_type: eventType, ...payload };
    await this.producer.send({
      topic: ERP_EVENTS_TOPIC,
      messages: [{ key: tenantId, value: JSON.stringify(message) }],
    });
    this.logger.log(`published ${eventType} for tenant=${tenantId}`);
  }
}
