import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';

@Module({
  controllers: [ProcurementController],
  providers: [ProcurementService, PrismaService, KafkaProducerService],
  exports: [ProcurementService, PrismaService],
})
export class ProcurementModule {}
