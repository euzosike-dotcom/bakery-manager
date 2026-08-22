import { Module } from '@nestjs/common';
import { FinanceConnectorService } from './finance-connector.service';

@Module({
  providers: [FinanceConnectorService],
})
export class FinanceConnectorModule {}
