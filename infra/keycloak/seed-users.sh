#!/usr/bin/env bash
# Creates one Keycloak user per existing Postgres `users` row (dev/seed data
# only — see infra/postgres/seed/dev_seed.sql and friends) and writes the
# resulting Keycloak subject id back into users.keycloak_subject_id, the
# column the schema has carried unused since migration 003_governance.sql.
#
# Idempotent: safe to re-run after adding new seed users. Existing Keycloak
# users are matched by email and left untouched (password included — never
# re-set on an existing user, so a hand-changed dev password survives
# re-runs).
#
# Requires: curl, jq, and the metrock-erp-postgres-1 container running
# (docker exec is used to run psql inside it, same pattern as every prior
# vertical slice's verification steps in docs/RUNBOOK.md).
#
# Depends on realm-export.json's unmanagedAttributePolicy: ENABLED fix —
# without it, Keycloak 24+'s declarative User Profile silently DROPS any
# user attribute not in its fixed schema (username/email/firstName/
# lastName), including the tenant_id attribute this script sets on
# creation. No error, no warning — the user is created (201) but the
# attribute just never persists. Found by minting a real token and
# noticing tenant_id was missing from it even though the create call
# looked like it succeeded.
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="metrock"
ADMIN_USER="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}"
DEV_USER_PASSWORD="${DEV_USER_PASSWORD:-DevPassw0rd!}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-metrock-erp-postgres-1}"

echo "Waiting for Keycloak at $KEYCLOAK_URL ..."
until curl -sf "$KEYCLOAK_URL/realms/master" > /dev/null; do sleep 2; done

ADMIN_TOKEN=$(curl -sf \
  -d "client_id=admin-cli" -d "username=$ADMIN_USER" -d "password=$ADMIN_PASS" -d "grant_type=password" \
  "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" | jq -r '.access_token')

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" = "null" ]; then
  echo "Failed to obtain admin token — check KC_BOOTSTRAP_ADMIN_USERNAME/PASSWORD" >&2
  exit 1
fi

# tenant_id|user_id|email|full_name, one row per line. Run as the metrock
# superuser (bypasses RLS) — same convention as every *_seed.sql header
# comment in infra/postgres/seed/.
rows=$(docker exec "$POSTGRES_CONTAINER" psql -U metrock -d metrock_erp -t -A -F'|' -c \
  "SELECT tenant_id, user_id, email, full_name FROM users ORDER BY email;")

if [ -z "$rows" ]; then
  echo "No rows in users table — nothing to seed."
  exit 0
fi

while IFS='|' read -r tenant_id user_id email full_name; do
  [ -z "$email" ] && continue

  existing_id=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM/users?email=$(printf '%s' "$email" | jq -sRr @uri)&exact=true" \
    | jq -r '.[0].id // empty')

  if [ -z "$existing_id" ]; then
    first_name="${full_name%% *}"
    last_name="${full_name#* }"
    [ "$last_name" = "$full_name" ] && last_name=""

    payload=$(jq -n \
      --arg email "$email" --arg first "$first_name" --arg last "$last_name" \
      --arg tenant "$tenant_id" --arg pass "$DEV_USER_PASSWORD" '{
        username: $email, email: $email, firstName: $first, lastName: $last,
        enabled: true, emailVerified: true,
        attributes: {tenant_id: [$tenant]},
        credentials: [{type: "password", value: $pass, temporary: false}]
      }')

    curl -sf -o /dev/null -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
      "$KEYCLOAK_URL/admin/realms/$REALM/users" -d "$payload"

    existing_id=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
      "$KEYCLOAK_URL/admin/realms/$REALM/users?email=$(printf '%s' "$email" | jq -sRr @uri)&exact=true" \
      | jq -r '.[0].id')
    echo "Created Keycloak user $email -> $existing_id (tenant $tenant_id, dev password: $DEV_USER_PASSWORD)"
  else
    echo "Keycloak user $email already exists -> $existing_id"
  fi

  docker exec "$POSTGRES_CONTAINER" psql -U metrock -d metrock_erp -q -c \
    "UPDATE users SET keycloak_subject_id = '$existing_id' WHERE tenant_id = '$tenant_id' AND user_id = '$user_id';"
done <<< "$rows"

echo "Done."
