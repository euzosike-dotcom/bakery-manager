import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';

export const ERP_EVENTS_TOPIC = 'erp.events';

/**
 * Thin wrapper around the platform's single event topic — identical in
 * shape to procurement-service's KafkaProducerService (only `clientId`
 * differs). This duplication (and the common/ files copied verbatim from
 * procurement-service) is a known, deliberate tradeoff for now: see
 * README.md "Known gaps" — extracting a shared backend-common package is
 * the right call once a third module needs the same tenant-context/Prisma/
 * Kafka glue, not before.
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly kafka: Kafka;
  private producer: Producer;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
    this.kafka = new Kafka({ clientId: 'manufacturing-service', brokers });
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
