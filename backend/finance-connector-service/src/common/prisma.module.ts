import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Single shared PrismaService instance across the whole app — the sync
 * poller and the read-only postings list endpoint both need it.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
