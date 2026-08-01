import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * A single shared PrismaService instance (one DB connection pool) across
 * the whole app. Needed here specifically because this service has THREE
 * feature modules (Agents, Sales, Ncr) that all need it, plus SyncModule
 * needing both SalesService and NcrService together — if each feature
 * module declared its own `PrismaService` provider (as procurement-service
 * and manufacturing-service's single-feature-module structure did, without
 * issue, since only one module ever used it there), Nest would construct a
 * separate instance — and separate connection pool — per module, and
 * SyncService would hit an ambiguous-provider situation resolving which one
 * to inject. `@Global()` + a dedicated module is the standard fix.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
