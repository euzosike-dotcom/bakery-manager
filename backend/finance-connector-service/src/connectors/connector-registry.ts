import { Injectable } from '@nestjs/common';
import { CustomModuleConnector } from './custom-module.connector';
import { NotImplementedConnector } from './not-implemented.connector';
import { ConnectorStrategy } from './connector-strategy';

// Every value tenant_registry.finance_connector_type's CHECK constraint
// allows besides 'NONE' (a tenant with no connector never enters the
// poller's tenant list at all — see FinanceConnectorService.pollAllTenants).
const UNIMPLEMENTED_EXTERNAL_SYSTEMS = ['ZOHO_BOOKS', 'QUICKBOOKS', 'XERO', 'SAP'] as const;

/**
 * Looks up the ConnectorStrategy for a given external_system value.
 * Adding a real provider later means writing a class implementing
 * ConnectorStrategy (see custom-module.connector.ts for the shape) and
 * registering it here in place of its NotImplementedConnector entry —
 * FinanceConnectorService itself needs no changes.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly strategies: Map<string, ConnectorStrategy>;

  constructor(customModuleConnector: CustomModuleConnector) {
    this.strategies = new Map<string, ConnectorStrategy>([
      [customModuleConnector.externalSystem, customModuleConnector],
      ...UNIMPLEMENTED_EXTERNAL_SYSTEMS.map(
        (externalSystem) => [externalSystem, new NotImplementedConnector(externalSystem)] as const,
      ),
    ]);
  }

  get(externalSystem: string): ConnectorStrategy {
    const strategy = this.strategies.get(externalSystem);
    if (!strategy) {
      throw new Error(`Unknown finance connector type: ${externalSystem}`);
    }
    return strategy;
  }
}
