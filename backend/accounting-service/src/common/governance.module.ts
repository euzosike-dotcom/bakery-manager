import { Global, Module } from '@nestjs/common';
import { PostingAuthorityClient } from '@metrock/backend-common';

/**
 * Same @Global()-singleton reasoning as KafkaModule in this directory —
 * one shared client, not one per feature module. Points at
 * governance-service's POST /authorization-check (docs/SDD.md §4.2) —
 * see PostingAuthorityClient's own doc comment for why this is the
 * platform's first synchronous service-to-service call.
 */
@Global()
@Module({
  providers: [
    {
      provide: PostingAuthorityClient,
      useFactory: () => new PostingAuthorityClient(process.env.GOVERNANCE_BASE_URL ?? 'http://localhost:3008'),
    },
  ],
  exports: [PostingAuthorityClient],
})
export class GovernanceModule {}
