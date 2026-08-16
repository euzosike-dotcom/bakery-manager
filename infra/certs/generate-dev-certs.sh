#!/usr/bin/env bash
# Generates a self-signed TLS cert/key for local dev only — covers
# `localhost` and `127.0.0.1`, shared by both the nginx gateway and
# Keycloak (docs/RUNBOOK.md's "TLS termination" section). Deliberately
# NOT mkcert: mkcert's nicer no-browser-warning experience comes from
# installing a local CA into your system's trust store, a real change to
# the machine itself, not just this project — plain openssl self-signed
# keeps this fully contained to infra/certs/, at the cost of clients
# needing to explicitly accept the untrusted cert (curl -k, an explicit
# trust exception, etc.).
#
# Output is gitignored (infra/.gitignore) — regenerable per-machine, and
# committing a private key is bad practice even for a throwaway dev cert.
# Safe to re-run any time; always regenerates rather than skipping if the
# files already exist, since these certs are cheap to make and this
# avoids ever silently running on a stale/expired one.
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$CERT_DIR/dev-key.pem" \
  -out "$CERT_DIR/dev-cert.pem" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERT_DIR/dev-key.pem"

echo "Generated $CERT_DIR/dev-cert.pem and $CERT_DIR/dev-key.pem (valid 825 days, localhost + 127.0.0.1 only)."
