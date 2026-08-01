import { Module } from '@nestjs/common';
import { KafkaProducerService } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';

@Module({
  controllers: [ProcurementController],
  providers: [
    ProcurementService,
    PrismaService,
    // KafkaProducerService now takes a clientId constructor arg (shared
    // across services in @metrock/backend-common), so it needs a factory
    // provider instead of Nest's default zero-arg instantiation.
    { provide: KafkaProducerService, useFactory: () => new KafkaProducerService('procurement-service') },
  ],
  exports: [ProcurementService, PrismaService],
})
export class ProcurementModule {}
