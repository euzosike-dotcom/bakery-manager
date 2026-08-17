#!/usr/bin/env bash
# Restores a backup.sh dump into an already-migrated, empty database —
# not a merge onto live data (see docs/RUNBOOK.md's "Backup & restore"
# section for the realistic recovery scenario this covers vs. the
# harder "restore alongside existing rows" one it deliberately doesn't
# try to solve generically). Run infra/postgres/migrations/*.sql (and
# infra/postgres/seed/dev_seed.sql if this is a from-scratch rebuild,
# NOT if the dump itself already has real data you want instead of the
# dev seed) against the target database FIRST — this script only
# restores data, it creates no schema, tables, or roles of its own.
#
# --disable-triggers: skips FK constraint checks during the restore
# itself (pg_restore's data-only dependency ordering is table-by-table,
# not fully constraint-aware within a table's own row order) — safe
# here because the schema's FK constraints were already validated once,
# at the original backup's source, and this restore doesn't change any
# of that data.
#
# Container/database default to the docker-compose-managed dev stack;
# both are overridable — the exact mechanism this repo's own restore
# TEST (docs/RUNBOOK.md) uses to target a disposable throwaway
# container instead of the real dev database.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <dump-file> [container-name] [database-name]" >&2
  exit 1
fi

DUMP_FILE="$1"
if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump file not found: $DUMP_FILE" >&2
  exit 1
fi

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${2:-$(cd "$INFRA_DIR" && docker compose ps -q postgres)}"
if [ -z "$CONTAINER" ]; then
  echo "postgres container is not running — 'docker compose up -d postgres' first (from infra/), or pass a container name/id explicitly." >&2
  exit 1
fi

POSTGRES_USER="${POSTGRES_USER:-metrock}"
POSTGRES_DB="${3:-metrock_erp}"

docker exec -i "$CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only --disable-triggers < "$DUMP_FILE"

echo "Restored $DUMP_FILE into $POSTGRES_DB on container $CONTAINER."
