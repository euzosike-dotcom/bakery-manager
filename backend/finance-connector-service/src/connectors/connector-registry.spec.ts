import { ConnectorRegistry } from './connector-registry';
import { CustomModuleConnector } from './custom-module.connector';
import { NotImplementedConnector } from './not-implemented.connector';

describe('ConnectorRegistry', () => {
  it('resolves CUSTOM_MODULE to the real connector', () => {
    const customModule = { externalSystem: 'CUSTOM_MODULE' } as unknown as CustomModuleConnector;
    const registry = new ConnectorRegistry(customModule);

    expect(registry.get('CUSTOM_MODULE')).toBe(customModule);
  });

  it.each(['ZOHO_BOOKS', 'QUICKBOOKS', 'XERO', 'SAP'])(
    'resolves %s to a NotImplementedConnector carrying its own external_system',
    (externalSystem) => {
      const customModule = { externalSystem: 'CUSTOM_MODULE' } as unknown as CustomModuleConnector;
      const registry = new ConnectorRegistry(customModule);

      const strategy = registry.get(externalSystem);

      expect(strategy).toBeInstanceOf(NotImplementedConnector);
      expect(strategy.externalSystem).toBe(externalSystem);
    },
  );

  it('throws for a value outside tenant_registry.finance_connector_type\'s own CHECK constraint', () => {
    const customModule = { externalSystem: 'CUSTOM_MODULE' } as unknown as CustomModuleConnector;
    const registry = new ConnectorRegistry(customModule);

    expect(() => registry.get('SOMETHING_MADE_UP')).toThrow('Unknown finance connector type');
  });
});

describe('NotImplementedConnector.post', () => {
  it('rejects with a clear, specific error naming the connector type, not a generic failure', async () => {
    const connector = new NotImplementedConnector('XERO');

    await expect(
      connector.post('tenant-1', { queueId: 'q-1', sourceModule: 'SALES', sourceRecordId: 'r-1', transactionType: 't' }, {
        journalEntryId: 'r-1',
        sourceModule: 'SALES',
        transactionType: 't',
        lines: [],
      }),
    ).rejects.toThrow('No connector implementation exists for external_system=XERO');
  });
});
