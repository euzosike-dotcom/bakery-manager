import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Single shared PrismaService instance across the whole app — this service
 * has five feature modules (Bills, Invoices, Journals, Reports, and the
 * Kafka consumer) that all need it. Same reasoning as sales-service's copy
 * of this file.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
