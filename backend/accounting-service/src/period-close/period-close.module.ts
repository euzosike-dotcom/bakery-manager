import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { PeriodCloseController } from './period-close.controller';
import { PeriodCloseService } from './period-close.service';

@Module({
  imports: [ReportsModule],
  controllers: [PeriodCloseController],
  providers: [PeriodCloseService],
})
export class PeriodCloseModule {}
