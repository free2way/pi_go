#!/usr/bin/env bash
# REL-007 / AT-REL-009: daily backup of the PiGO database, credential ciphertext
# and the deployment configuration, with a manifest used by restore-verify.sh.
#
# Usage (on the deployment host):  bash backup.sh [backup-root]
set -euo pipefail

PROJECT_DIR="${PI_PIGO_DIR:-/app/pi-agent}"
BACKUP_ROOT="${1:-$PROJECT_DIR/backups}"
PG_CONTAINER="${PI_PG_CONTAINER:-pi-agent-postgres-1}"
WEB_CONTAINER="${PI_WEB_CONTAINER:-pi-agent-web-1}"
PG_USER="${PI_PG_USER:-pigo}"
PG_DB="${PI_PG_DB:-pigo}"
KEEP_DAYS="${PI_BACKUP_KEEP_DAYS:-14}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_ROOT/$TS"
# AUD-14: backups contain ciphertext and configuration, never shared credentials.
umask 077
mkdir -p "$TARGET"
chmod 700 "$TARGET"

echo "== backup $TS =="

# ---------------------------------------------------------------- database
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$TARGET/database.dump"
echo "database.dump $(wc -c < "$TARGET/database.dump") bytes"

# ---------------------------------------------------------------- credentials
VAULT_PATH="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WEB_CONTAINER" | sed -n 's/^PI_VAULT_FILE=//p')"
if [ -n "$VAULT_PATH" ]; then
  docker cp "$WEB_CONTAINER:$VAULT_PATH" "$TARGET/credentials.vault.json" > /dev/null
  chmod 600 "$TARGET/credentials.vault.json"
  echo "credentials.vault.json captured from $VAULT_PATH"
fi

# ---------------------------------------------------------------- configuration
cp "$PROJECT_DIR/compose.yaml" "$TARGET/compose.yaml"
if [ -f "$PROJECT_DIR/.env" ]; then
  cp "$PROJECT_DIR/.env" "$TARGET/env.backup"
  chmod 600 "$TARGET/env.backup"
fi
# AUD-14: whitelist-based sanitizer. Values are only kept for explicitly
# non-sensitive keys, and URL userinfo is stripped, so no password can leak into
# the "sanitized" diagnostics copy.
SANITIZER="$(cd "$(dirname "$0")" && pwd)/env-sanitize.mjs"
# 宿主机可能没有 node（生产主机即如此）：退化为在 web 容器内执行同一净化器。
# 容器内路径固定为 /tmp/env-sanitize.mjs；容器不可用时明确报错而不是静默跳过。
run_sanitizer() {
  local env_dump="$1" target_file="$2"
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$env_dump" | node "$SANITIZER" > "$target_file"
  else
    # 容器根文件系统只读，不能 docker cp 写入；把脚本经 argv 传给容器内 node，
    # stdin 仍留给环境变量数据流。
    printf '%s' "$env_dump" | docker exec -i "$WEB_CONTAINER" node --input-type=module -e "$(cat "$SANITIZER")" > "$target_file"
  fi
}
run_sanitizer "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WEB_CONTAINER")" "$TARGET/web.env.sanitized"
run_sanitizer "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${PI_WORKER_CONTAINER:-pi-agent-worker-1}")" "$TARGET/worker.env.sanitized"
chmod 600 "$TARGET/web.env.sanitized" "$TARGET/worker.env.sanitized"

# ---------------------------------------------------------------- manifest
counts() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "select json_build_object('users', (select count(*) from users), 'identities', (select count(*) from user_identities),
      'workspaces', (select count(*) from workspaces), 'runs', (select count(*) from runs),
      'events', (select count(*) from run_events), 'agents', (select count(*) from run_agents),
      'checks', (select count(*) from run_checks), 'findings', (select count(*) from run_findings),
      'artifacts', (select count(*) from run_artifacts), 'checkpoints', (select count(*) from run_checkpoints),
      'jobs', (select count(*) from jobs), 'digest', (select md5(string_agg(id || ':' || last_seq || ':' || md5(document_json), ',' order by id)) from runs))"
}

DB_JSON="$(counts)"
CREDENTIAL_SHA="$( [ -f "$TARGET/credentials.vault.json" ] && sha256sum "$TARGET/credentials.vault.json" | cut -d' ' -f1 || echo none)"
DUMP_SHA="$(sha256sum "$TARGET/database.dump" | cut -d' ' -f1)"

cat > "$TARGET/manifest.json" <<EOF
{
  "createdAt": "$TS",
  "database": $DB_JSON,
  "databaseDumpSha256": "$DUMP_SHA",
  "credentialsSha256": "$CREDENTIAL_SHA",
  "piVersion": "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WEB_CONTAINER" | sed -n 's/^PI_VERSION=//p')"
}
EOF
cat "$TARGET/manifest.json"
chmod 600 "$TARGET"/* 2>/dev/null || true
echo "backup complete: $TARGET"

# ---------------------------------------------------------------- retention
if [ -d "$BACKUP_ROOT" ]; then
  find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime "+$KEEP_DAYS" -print -exec rm -rf {} + 2>/dev/null || true
fi
