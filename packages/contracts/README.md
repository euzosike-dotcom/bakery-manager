# Shared Contracts

Event and API contracts shared conceptually across `procurement-service`,
`manufacturing-service` (both TypeScript), `ledger-service` (Go), and
`apps/mobile` (Dart). Today these are **documentation-as-JSON-Schema**,
hand-kept in sync across the languages — there is no codegen pipeline wired
up yet. Now that two domain services exist, this is close to the point
where that stops being a reasonable tradeoff — see README.md "Known gaps".

As more modules come online (Sales & Agent Capital, Logistics/Fleet, ...),
the next real investment here is generating typed clients from these
schemas (e.g. `quicktype` or `json-schema-to-typescript` /
`json-schema.dart`) so the services can't silently drift out of sync on
field names — see `docs/SDD.md` for the full list of event types implied by
each module's Financial Trigger table.

## events/

- `grn.posted.v1.schema.json` — Procurement & Stores (SDD §3.B).
- `batch.consumption_recorded.v1.schema.json`,
  `batch.output_recorded.v1.schema.json`,
  `batch.yield_variance.v1.schema.json` — Manufacturing & Yield
  Intelligence (SDD §3.C). The variance schema documents two event types
  (`_unfavorable`/`_favorable`) in one file since they're two directions of
  the same concept, not two unrelated events.
