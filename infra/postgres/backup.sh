#!/usr/bin/env bash
# Data-only pg_dump of metrock_erp, taken from the running postgres
# container via `docker exec` (no local psql/pg_dump client needed — see
# docs/RUNBOOK.md's "Backup & restore" section for why). Deliberately
# data-only, not schema+data: schema is already version-controlled and
# reproducible via infra/postgres/migrations/*.sql, reviewed and tested
# far more rigorously than anything a point-in-time dump could claim —
# baking a second, potentially-stale copy of the schema into every dump
# would just be a second source of truth to drift out of sync with the
# first. restore.sh's job assumes the target database's schema is
# already current (run the migrations first, same as any fresh
# environment setup), then restores exactly the data.
#
# Custom format (-F custom), not plain SQL — compressed, and lets
# restore.sh use pg_restore's dependency-aware ordering instead of
# replaying a flat script of INSERTs.
#
# Output is gitignored (infra/.gitignore) — a database dump is data, not
# something that belongs in git history, the same reasoning that already
# applies to infra/.pgdata/ itself.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$INFRA_DIR/.backups"
mkdir -p "$BACKUP_DIR"

CONTAINER="$(cd "$INFRA_DIR" && docker compose ps -q postgres)"
if [ -z "$CONTAINER" ]; then
  echo "postgres container is not running — 'docker compose up -d postgres' first (from infra/)." >&2
  exit 1
fi

POSTGRES_USER="${POSTGRES_USER:-metrock}"
POSTGRES_DB="metrock_erp"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$BACKUP_DIR/metrock_erp_${TIMESTAMP}.dump"

docker exec "$CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only -F custom > "$OUT_FILE"

echo "Backup written to $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1 | xargs))"
