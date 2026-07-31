# Shared Contracts

Event and API contracts shared conceptually across `procurement-service`
(TypeScript), `ledger-service` (Go), and `apps/mobile` (Dart). Today these
are **documentation-as-JSON-Schema**, hand-kept in sync across the three
languages — there is no codegen pipeline wired up yet.

As more modules come online (Manufacturing, Sales & Agent Capital, ...),
the next real investment here is generating typed clients from these
schemas (e.g. `quicktype` or `json-schema-to-typescript` /
`json-schema.dart`) so the three services can't silently drift out of sync
on field names — see `docs/SDD.md` for the full list of event types
implied by each module's Financial Trigger table.

## events/

- `grn.posted.v1.schema.json` — the only event contract implemented so far.
