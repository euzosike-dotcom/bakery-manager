import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

@Module({
  controllers: [ProductionController],
  providers: [ProductionService, PrismaService, KafkaProducerService],
  exports: [ProductionService, PrismaService],
})
export class ProductionModule {}
