import { Module } from '@nestjs/common';
import { KafkaProducerService, M2MTokenClient, PostingAuthorityClient } from '@metrock/backend-common';
import { PrismaService } from '../common/prisma.service';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

@Module({
  controllers: [ProductionController],
  providers: [
    ProductionService,
    PrismaService,
    { provide: KafkaProducerService, useFactory: () => new KafkaProducerService('manufacturing-service') },
    // M2MTokenClient mints this service's own real machine-to-machine
    // bearer token (docs/RUNBOOK.md's "Machine-to-machine auth" section)
    // — client id/secret are manufacturing-service's own registered
    // Keycloak client (infra/keycloak/realm-export.json), added as part
    // of the approval_matrix expansion pass since this service never
    // called governance-service before it.
    {
      provide: PostingAuthorityClient,
      useFactory: () =>
        new PostingAuthorityClient(
          process.env.GOVERNANCE_BASE_URL ?? 'http://localhost:3008',
          new M2MTokenClient({
            issuer: process.env.KEYCLOAK_ISSUER!,
            clientId: process.env.M2M_CLIENT_ID ?? 'manufacturing-service',
            clientSecret: process.env.M2M_CLIENT_SECRET!,
          }),
        ),
    },
  ],
  exports: [ProductionService, PrismaService],
})
export class ProductionModule {}
