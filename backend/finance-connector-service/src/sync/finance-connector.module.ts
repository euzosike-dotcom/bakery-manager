import { Module } from '@nestjs/common';
import { FinanceConnectorService } from './finance-connector.service';
import { CustomModuleConnector } from '../connectors/custom-module.connector';
import { ConnectorRegistry } from '../connectors/connector-registry';

@Module({
  providers: [FinanceConnectorService, CustomModuleConnector, ConnectorRegistry],
})
export class FinanceConnectorModule {}
