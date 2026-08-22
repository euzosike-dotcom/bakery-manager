import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  // PeriodCloseModule imports this to reuse accountBalances rather than
  // re-deriving the same revenue/expense computation.
  exports: [ReportsService],
})
export class ReportsModule {}
