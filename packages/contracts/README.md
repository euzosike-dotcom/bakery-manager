# Shared Contracts

Event and API contracts shared conceptually across `procurement-service`,
`manufacturing-service`, `sales-service` (all TypeScript), `ledger-service`
(Go), and `apps/mobile` (Dart). Today these are **documentation-as-JSON-
Schema**, hand-kept in sync across the languages — there is no codegen
pipeline wired up yet. Now that three domain services exist (a real shared
package, `packages/backend-common`, was already extracted for the common
NestJS plumbing at this same threshold — see root README.md "Known gaps"),
generating typed clients from these schemas is the next investment worth
making here specifically, not before.

## events/

- `grn.posted.v1.schema.json` — Procurement & Stores (SDD §3.B).
- `batch.consumption_recorded.v1.schema.json`,
  `batch.output_recorded.v1.schema.json`,
  `batch.yield_variance.v1.schema.json` — Manufacturing & Yield
  Intelligence (SDD §3.C). The variance schema documents two event types
  (`_unfavorable`/`_favorable`) in one file since they're two directions of
  the same concept, not two unrelated events.
- `sales.order_fulfilled.v1.schema.json`, `ncr.verified.v1.schema.json` —
  Sales & Agent Capital Governance (SDD §3.D). Note that
  `trading_capital_ledger` (the real-time capital-eligibility gate) is
  updated synchronously inside sales-service itself, in the same
  transaction as the order/NCR write — these two Kafka events are only the
  downstream GL journal posting, not the gate mechanism.
