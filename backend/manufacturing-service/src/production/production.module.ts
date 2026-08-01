import { Module } from '@nestjs/common';
import { KafkaProducerService } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

@Module({
  controllers: [ProductionController],
  providers: [
    ProductionService,
    PrismaService,
    { provide: KafkaProducerService, useFactory: () => new KafkaProducerService('manufacturing-service') },
  ],
  exports: [ProductionService, PrismaService],
})
export class ProductionModule {}
