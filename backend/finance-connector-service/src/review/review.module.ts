import { Module } from '@nestjs/common';
import { M2MTokenClient, PostingAuthorityClient } from '@metrock/backend-common';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({
  controllers: [ReviewController],
  providers: [
    ReviewService,
    // This service never called governance-service before this pass —
    // its own new Keycloak client (infra/keycloak/realm-export.json),
    // same pattern as every other service's M2M setup (docs/RUNBOOK.md's
    // "Machine-to-machine auth" section).
    {
      provide: PostingAuthorityClient,
      useFactory: () =>
        new PostingAuthorityClient(
          process.env.GOVERNANCE_BASE_URL ?? 'http://localhost:3008',
          new M2MTokenClient({
            issuer: process.env.KEYCLOAK_ISSUER!,
            clientId: process.env.M2M_CLIENT_ID ?? 'finance-connector-service',
            clientSecret: process.env.M2M_CLIENT_SECRET!,
          }),
        ),
    },
  ],
})
export class ReviewModule {}
