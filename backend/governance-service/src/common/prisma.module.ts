import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Single shared PrismaService instance across the whole app — this
 * service has seven feature modules that all need it. Same reasoning as
 * sales-service's copy of this file. No KafkaModule here at all — unlike
 * every other domain service, Governance has no financial trigger (SDD
 * §3.A) and publishes no events.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
