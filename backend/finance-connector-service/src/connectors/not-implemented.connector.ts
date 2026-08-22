import { ConnectorPostResult, ConnectorStrategy, JournalEntryForPosting, QueueRowForPosting } from './connector-strategy';

/**
 * Stands in for Zoho Books, QuickBooks, Xero, and SAP — see
 * connector-strategy.ts's doc comment for why none of them has a real
 * implementation. Throws a specific, greppable error rather than
 * silently doing nothing or crashing with a generic one, so a tenant
 * accidentally (or experimentally) configured with one of these fails
 * loudly and clearly through the existing retry/dead-letter path
 * (FinanceConnectorService.recordFailure) instead of behaving like a
 * connector that's just having a bad day.
 */
export class NotImplementedConnector implements ConnectorStrategy {
  constructor(readonly externalSystem: string) {}

  async post(_tenantId: string, _row: QueueRowForPosting, _entry: JournalEntryForPosting): Promise<ConnectorPostResult> {
    throw new Error(
      `No connector implementation exists for external_system=${this.externalSystem} yet. ` +
        `This is a real, unbuilt integration (needs a registered OAuth app and real sandbox ` +
        `credentials with that provider), not a transient failure — retrying will not help until ` +
        `a real ${this.externalSystem} connector is implemented and registered in connector-registry.ts.`,
    );
  }
}
