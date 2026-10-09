#!/usr/bin/env bash
# Runs on the Docker host. Arguments contain paths/flags only, never secrets.
set -euo pipefail

REMOTE_DIR="${1:-}"
BUNDLE="${2:-}"
INCOMING_ENV="${3:--}"
REPLACE_ENV="${4:-0}"
IMAGE="local/pigo-release-executor:0.2.5"
CONTAINER="pigo-release-executor"

if [[ ! "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ || "$REMOTE_DIR" == "/" ]]; then
  echo "unsafe install directory" >&2
  exit 2
fi
if [[ ! "$BUNDLE" =~ ^/tmp/pigo-executor-[A-Za-z0-9._-]+\.tar\.gz$ ]]; then
  echo "unsafe bundle path" >&2
  exit 2
fi
if [[ "$INCOMING_ENV" != "-" && ! "$INCOMING_ENV" =~ ^/tmp/pigo-executor-[A-Za-z0-9._-]+\.env$ ]]; then
  echo "unsafe environment path" >&2
  exit 2
fi
if [[ "$REPLACE_ENV" != "0" && "$REPLACE_ENV" != "1" ]]; then
  echo "invalid replace flag" >&2
  exit 2
fi

cleanup() {
  rm -f "$BUNDLE"
  [[ "$INCOMING_ENV" == "-" ]] || rm -f "$INCOMING_ENV"
  rm -f "$0"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
docker compose version >/dev/null
gzip -t "$BUNDLE"

mkdir -p "$REMOTE_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ROLLBACK_IMAGE=""
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  ROLLBACK_IMAGE="local/pigo-release-executor:rollback-$TIMESTAMP"
  docker tag "$IMAGE" "$ROLLBACK_IMAGE"
fi
if [[ -f "$REMOTE_DIR/server.mjs" ]]; then
  tar -czf "$REMOTE_DIR/source-backup-$TIMESTAMP.tar.gz" -C "$REMOTE_DIR" \
    Dockerfile compose.yaml server.mjs executor.env.example remote-install.sh 2>/dev/null || true
fi

tar -xzf "$BUNDLE" -C "$REMOTE_DIR"
if [[ "$INCOMING_ENV" != "-" && (! -f "$REMOTE_DIR/.env" || "$REPLACE_ENV" == "1") ]]; then
  install -m 600 "$INCOMING_ENV" "$REMOTE_DIR/.env"
fi
if [[ ! -f "$REMOTE_DIR/.env" ]]; then
  echo "executor .env is missing; pass PIGO_EXECUTOR_ENV_FILE on the first install" >&2
  exit 5
fi
chmod 600 "$REMOTE_DIR/.env"

# Docker group ids vary by host. Keep this mechanical value current without
# reading or printing any other entry in the protected environment file.
DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
if grep -q '^DOCKER_GID=' "$REMOTE_DIR/.env"; then
  sed -i "s/^DOCKER_GID=.*/DOCKER_GID=$DOCKER_GID/" "$REMOTE_DIR/.env"
else
  printf '\nDOCKER_GID=%s\n' "$DOCKER_GID" >> "$REMOTE_DIR/.env"
fi

cd "$REMOTE_DIR"
docker compose --env-file .env config --quiet
docker compose --env-file .env build executor
docker compose --env-file .env up -d --force-recreate executor

HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS http://127.0.0.1:3300/healthz 2>/dev/null || true)"
  grep -q '"status":"ok"' <<<"$HEALTH" && break
  sleep 2
done
if ! grep -q '"status":"ok"' <<<"$HEALTH"; then
  docker logs --tail 80 "$CONTAINER" >&2 || true
  if [[ -n "$ROLLBACK_IMAGE" ]]; then
    docker compose --env-file .env stop executor || true
    docker tag "$ROLLBACK_IMAGE" "$IMAGE"
    docker compose --env-file .env up -d --force-recreate executor || true
    echo "health verification failed; previous image restored" >&2
  fi
  exit 7
fi

UNAUTH="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  http://127.0.0.1:3300/hooks/pigo-release \
  -H 'Content-Type: application/json' -d '{}')"
if [[ "$UNAUTH" != "401" ]]; then
  echo "unauthenticated webhook was not rejected" >&2
  exit 8
fi

docker ps --filter "name=^/${CONTAINER}$" --format 'executor: {{.Names}} {{.Image}} {{.Status}}'
echo "health: ok"
echo "authentication rejection: ok"
echo "PIGO_EXECUTOR_DEPLOY_VERIFIED"
