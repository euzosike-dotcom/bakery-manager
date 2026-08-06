import { Module } from '@nestjs/common';
import { KafkaProducerService, PostingAuthorityClient } from '@metrock/backend-common';
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
    // Same reasoning — PostingAuthorityClient takes a governanceBaseUrl
    // constructor arg. This service has no common/governance.module.ts
    // wrapper (unlike accounting/sales/fleet/hr), so it's provided inline
    // here to match this service's own existing factory-provider pattern.
    {
      provide: PostingAuthorityClient,
      useFactory: () => new PostingAuthorityClient(process.env.GOVERNANCE_BASE_URL ?? 'http://localhost:3008'),
    },
  ],
  exports: [ProcurementService, PrismaService],
})
export class ProcurementModule {}
