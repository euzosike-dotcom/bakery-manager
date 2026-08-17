import { Global, Module } from '@nestjs/common';
import { M2MTokenClient, PostingAuthorityClient } from '@metrock/backend-common';

/**
 * Same @Global()-singleton reasoning as KafkaModule in this directory —
 * one shared client, not one per feature module. Points at
 * governance-service's POST /authorization-check (docs/SDD.md §4.2) —
 * see PostingAuthorityClient's own doc comment for why this is the
 * platform's first synchronous service-to-service call.
 *
 * M2MTokenClient mints this service's own real machine-to-machine bearer
 * token (docs/RUNBOOK.md's "Machine-to-machine auth" section) — the
 * client id/secret are accounting-service's own registered Keycloak
 * client (infra/keycloak/realm-export.json), not shared with any other
 * service.
 */
@Global()
@Module({
  providers: [
    {
      provide: PostingAuthorityClient,
      useFactory: () =>
        new PostingAuthorityClient(
          process.env.GOVERNANCE_BASE_URL ?? 'http://localhost:3008',
          new M2MTokenClient({
            issuer: process.env.KEYCLOAK_ISSUER!,
            clientId: process.env.M2M_CLIENT_ID ?? 'accounting-service',
            clientSecret: process.env.M2M_CLIENT_SECRET!,
          }),
        ),
    },
  ],
  exports: [PostingAuthorityClient],
})
export class GovernanceModule {}
