/**
 * One implementation per `tenant_registry.finance_connector_type` value
 * (`002_tenant_registry.sql`'s CHECK constraint: `NONE`, `CUSTOM_MODULE`,
 * `ZOHO_BOOKS`, `QUICKBOOKS`, `XERO`, `SAP`). `FinanceConnectorService`'s
 * poller looks up the strategy matching each `integration_queue` row's
 * own `external_system` and delegates to it — this file is the seam that
 * makes that pluggable, not a concrete integration.
 *
 * Deliberately only `CustomModuleConnector` (custom-module.connector.ts)
 * has a real implementation. The other four route to
 * `NotImplementedConnector` (not-implemented.connector.ts) — Zoho Books,
 * QuickBooks, Xero, and SAP are real third-party SaaS products; a real
 * connector for any of them needs an actual developer account, a
 * registered OAuth app, and real sandbox credentials with that provider,
 * none of which exist in this environment. Writing HTTP client code
 * against each provider's documented API shape without ever being able
 * to call it for real would be exactly the kind of unverified code this
 * platform's build has consistently avoided elsewhere — every other
 * pass in this session's history was checked against something real and
 * running. This file exists so a real implementation can be dropped in
 * later (implement this interface, register it in
 * `connector-registry.ts`) without touching the poller at all.
 *
 * `post` must be safe to call more than once for the same `queueId` —
 * the poller's own crash-recovery may call it again after a prior
 * attempt actually succeeded upstream but wasn't recorded locally in
 * time. How each implementation achieves that is its own concern: a
 * local-DB connector can use a unique constraint (see
 * `CustomModuleConnector`); a real external API connector would
 * typically check for an existing posting via the provider's own API
 * first, or use a client-generated idempotency key if the provider
 * supports one.
 */

export interface ConnectorPostResult {
  /** Whatever id the external system assigns this posting — stored on
   * integration_queue.posted_external_id for traceability. */
  postedExternalId: string;
}

export interface JournalLineForPosting {
  accountCode: string;
  debitAmount: string;
  creditAmount: string;
  costCenterPlantId: string | null;
}

export interface JournalEntryForPosting {
  journalEntryId: string;
  sourceModule: string;
  transactionType: string;
  lines: JournalLineForPosting[];
}

export interface QueueRowForPosting {
  queueId: string;
  sourceModule: string;
  sourceRecordId: string;
  transactionType: string;
}

export interface ConnectorStrategy {
  /** The tenant_registry.finance_connector_type value this instance handles. */
  readonly externalSystem: string;

  /**
   * Relay one already-posted journal entry to the external system.
   * Runs OUTSIDE any open database transaction — a real connector's
   * implementation will typically make a network call here, and this
   * platform never holds a DB transaction open across one (see
   * FinanceConnectorService's own doc comment). The caller updates
   * integration_queue itself, in a separate, short transaction, once
   * this resolves.
   */
  post(tenantId: string, row: QueueRowForPosting, entry: JournalEntryForPosting): Promise<ConnectorPostResult>;
}
