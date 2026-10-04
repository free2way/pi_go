#!/usr/bin/env bash
# `npm run drill:rollback` — rollback drill / runbook executor.
#
# Performs the documented rollback: retag the previous web and worker images to
# the tags compose expects, recreate only those two services, then health-check
# the deployment.
#
# SAFETY (hard requirement): the script NEVER runs anything without BOTH
# --apply AND --yes. Without --apply it is a dry-run that prints the exact
# commands. With --apply but without --yes it refuses and exits 2.
#
# Usage:
#   # dry-run (default): print the rollback steps
#   npm run drill:rollback -- --web local/pigo-web:prev1 --worker local/pigo-worker:prev1
#
#   # execute
#   npm run drill:rollback -- --web local/pigo-web:prev1 --worker local/pigo-worker:prev1 --apply --yes
#
# Options:
#   --web <ref>            previous web image ref (required), e.g. local/pigo-web:prev1
#   --worker <ref>         previous worker image ref (required)
#   --web-target <ref>     compose web image tag to overwrite (default local/pigo-web:0.1.0)
#   --worker-target <ref>  compose worker image tag to overwrite (default local/pigo-worker:0.1.0)
#   --compose-file <path>  compose file, relative to the project dir (default deploy/docker/compose.yaml)
#   --health-url <url>     health endpoint (default PI_HEALTH_URL or http://127.0.0.1:3100/api/health)
#   --target user@host     run on this host over ssh (default: PI_DRILL_HOST or localhost)
#   --project-dir <dir>    project dir on the host (default: PI_PIGO_DIR or /app/pi-agent)
#   --apply                execute the steps
#   --yes                  required together with --apply
#   --help
set -euo pipefail

APPLY=0
YES=0
WEB_PREV=""
WORKER_PREV=""
WEB_TARGET="local/pigo-web:0.1.0"
WORKER_TARGET="local/pigo-worker:0.1.0"
COMPOSE_FILE="deploy/docker/compose.yaml"
HEALTH_URL="${PI_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
TARGET="${PI_DRILL_HOST:-}"
PROJECT_DIR="${PI_PIGO_DIR:-/app/pi-agent}"
HEALTH_RETRIES="${PI_ROLLBACK_HEALTH_RETRIES:-20}"
HEALTH_SLEEP_SECONDS="${PI_ROLLBACK_HEALTH_SLEEP_SECONDS:-3}"

usage() {
  sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --web) WEB_PREV="${2:?--web needs a value}"; shift 2 ;;
    --worker) WORKER_PREV="${2:?--worker needs a value}"; shift 2 ;;
    --web-target) WEB_TARGET="${2:?--web-target needs a value}"; shift 2 ;;
    --worker-target) WORKER_TARGET="${2:?--worker-target needs a value}"; shift 2 ;;
    --compose-file) COMPOSE_FILE="${2:?--compose-file needs a value}"; shift 2 ;;
    --health-url) HEALTH_URL="${2:?--health-url needs a value}"; shift 2 ;;
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:?--project-dir needs a value}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "drill:rollback: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$WEB_PREV" ] || [ -z "$WORKER_PREV" ]; then
  echo "drill:rollback: --web and --worker (previous image refs) are required." >&2
  usage >&2
  exit 2
fi

# Reject anything that could break out of the quoted shell commands.
IMAGE_REF_RE='^[A-Za-z0-9][A-Za-z0-9._:/@-]*$'
for ref in "$WEB_PREV" "$WORKER_PREV" "$WEB_TARGET" "$WORKER_TARGET"; do
  if ! printf '%s' "$ref" | grep -Eq "$IMAGE_REF_RE"; then
    echo "drill:rollback: illegal image ref: $ref" >&2
    exit 2
  fi
done
case "$COMPOSE_FILE" in
  *..*|*[\;\&\|\`\$]*) echo "drill:rollback: illegal --compose-file: $COMPOSE_FILE" >&2; exit 2 ;;
esac

# Never execute without both flags.
if [ "$APPLY" -eq 1 ] && [ "$YES" -ne 1 ]; then
  echo "drill:rollback: refusing to execute: --apply also requires --yes." >&2
  echo "  Re-run with: npm run drill:rollback -- --web $WEB_PREV --worker $WORKER_PREV --apply --yes" >&2
  exit 2
fi

TEMPLATE='set -euo pipefail
cd "__PROJECT_DIR__"

echo "== rollback drill =="
echo "retag previous web    : __WEB_PREV__ -> __WEB_TARGET__"
docker tag "__WEB_PREV__" "__WEB_TARGET__"
echo "retag previous worker : __WORKER_PREV__ -> __WORKER_TARGET__"
docker tag "__WORKER_PREV__" "__WORKER_TARGET__"

echo "recreate web + worker"
docker compose -f "__COMPOSE_FILE__" up -d web worker

echo "health check: __HEALTH_URL__"
ok=0
attempt=1
while [ "$attempt" -le __HEALTH_RETRIES__ ]; do
  if curl -fsS "__HEALTH_URL__" >/dev/null 2>&1; then ok=1; break; fi
  echo "  attempt $attempt/__HEALTH_RETRIES__ not healthy yet"
  attempt=$((attempt + 1))
  sleep __HEALTH_SLEEP__
done
if [ "$ok" -ne 1 ]; then
  echo "ROLLBACK HEALTH CHECK FAILED" >&2
  exit 1
fi
echo "ROLLBACK OK — web + worker healthy"'


REMOTE_SCRIPT="${TEMPLATE//__PROJECT_DIR__/$PROJECT_DIR}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__WEB_PREV__/$WEB_PREV}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__WEB_TARGET__/$WEB_TARGET}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__WORKER_PREV__/$WORKER_PREV}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__WORKER_TARGET__/$WORKER_TARGET}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__COMPOSE_FILE__/$COMPOSE_FILE}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__HEALTH_URL__/$HEALTH_URL}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__HEALTH_RETRIES__/$HEALTH_RETRIES}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__HEALTH_SLEEP__/$HEALTH_SLEEP_SECONDS}"

if [ "$APPLY" -ne 1 ]; then
  echo "[drill:rollback] DRY-RUN — nothing is executed (need --apply --yes to run)."
  if [ -n "$TARGET" ]; then echo "[drill:rollback] target: ssh $TARGET"; else echo "[drill:rollback] target: this host"; fi
  echo "[drill:rollback] --- steps that would run ---"
  printf '%s\n' "$REMOTE_SCRIPT"
  echo "[drill:rollback] --- end steps ---"
  exit 0
fi

echo "[drill:rollback] EXECUTING on ${TARGET:-this host}"
if [ -n "$TARGET" ]; then
  printf '%s\n' "$REMOTE_SCRIPT" | ssh -o BatchMode=yes "$TARGET" 'bash -s'
else
  printf '%s\n' "$REMOTE_SCRIPT" | bash -s
fi
