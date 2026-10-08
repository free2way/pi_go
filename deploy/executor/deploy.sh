#!/usr/bin/env bash
# Upload and install the release executor with SSH public-key authentication.
# Secrets are read from an optional local env file and are never printed.
set -euo pipefail

TARGET="${PIGO_DEPLOY_TARGET:-}"
REMOTE_DIR="${PIGO_EXECUTOR_REMOTE_DIR:-/app/pi-agent/services/pigo-release-executor}"
ENV_FILE="${PIGO_EXECUTOR_ENV_FILE:-}"
REPLACE_ENV="${PIGO_EXECUTOR_REPLACE_ENV:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$TARGET" || ! "$TARGET" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]]; then
  echo "Set PIGO_DEPLOY_TARGET to an explicit user@host SSH target." >&2
  exit 2
fi
if [[ ! "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ || "$REMOTE_DIR" == "/" ]]; then
  echo "PIGO_EXECUTOR_REMOTE_DIR must be a safe absolute directory." >&2
  exit 2
fi
if [[ "$REPLACE_ENV" != "0" && "$REPLACE_ENV" != "1" ]]; then
  echo "PIGO_EXECUTOR_REPLACE_ENV must be 0 or 1." >&2
  exit 2
fi
if [[ -n "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  echo "PIGO_EXECUTOR_ENV_FILE does not name a regular file." >&2
  exit 2
fi

for tool in ssh scp tar gzip; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

DEPLOY_ID="$(date +%Y%m%d%H%M%S)-$$"
TARBALL="$(mktemp -t pigo-executor-src).tar.gz"
trap 'rm -f "$TARBALL"' EXIT

tar -czf "$TARBALL" -C "$ROOT" \
  Dockerfile compose.yaml server.mjs executor.env.example remote-install.sh || exit 3
gzip -t "$TARBALL"

SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
REMOTE_TARBALL="/tmp/pigo-executor-${DEPLOY_ID}.tar.gz"
REMOTE_INSTALLER="/tmp/pigo-executor-${DEPLOY_ID}.install.sh"
REMOTE_ENV="-"

scp "${SSH_OPTIONS[@]}" "$TARBALL" "$TARGET:$REMOTE_TARBALL"
scp "${SSH_OPTIONS[@]}" "$ROOT/remote-install.sh" "$TARGET:$REMOTE_INSTALLER"
if [[ -n "$ENV_FILE" ]]; then
  REMOTE_ENV="/tmp/pigo-executor-${DEPLOY_ID}.env"
  scp "${SSH_OPTIONS[@]}" "$ENV_FILE" "$TARGET:$REMOTE_ENV"
  ssh "${SSH_OPTIONS[@]}" "$TARGET" "chmod 600 '$REMOTE_ENV'"
fi

ssh "${SSH_OPTIONS[@]}" "$TARGET" \
  "bash '$REMOTE_INSTALLER' '$REMOTE_DIR' '$REMOTE_TARBALL' '$REMOTE_ENV' '$REPLACE_ENV'"
