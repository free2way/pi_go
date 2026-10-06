#!/usr/bin/env bash
#
# PiGO demo / acceptance environment driver.
#
#   scripts/demo-env.sh up | down | status | seed | doctor
#
# This is NOT production. The demo stack shares the host's existing PostgreSQL
# container and Docker socket and reads one credential file that must already
# exist on the host. `up` refuses to start unless every resolved database URL
# ends in /pigo_demo. See docs/25-demo-environment.md.
#
# The command surface lives here; the decision logic and Docker orchestration
# live in scripts/demo-env-lib.mjs so the safety invariant, token/version parity
# and refusal paths can be unit-tested without a Docker daemon
# (`npm run test:scripts`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "demo-env: node is required but was not found on PATH" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/demo-env-lib.mjs" "$@"
