#!/usr/bin/env bash
# REL-007 / AT-REL-009: restore the newest backup into a scratch database and
# verify users, runs, events, checkpoints, jobs and the credential ciphertext
# match the manifest recorded at backup time. The production database is never
# touched: everything is restored into pigo_restore_verify and dropped afterwards.
#
# Usage (on the deployment host):  bash restore-verify.sh [backup-dir]
set -euo pipefail

PROJECT_DIR="${PI_PIGO_DIR:-/app/pi-agent}"
PG_CONTAINER="${PI_PG_CONTAINER:-pi-agent-postgres-1}"
PG_USER="${PI_PG_USER:-pigo}"
SCRATCH_DB="${PI_RESTORE_DB:-pigo_restore_verify}"
BACKUP_ROOT="${PI_BACKUP_ROOT:-$PROJECT_DIR/backups}"

if [ -n "${1:-}" ]; then
  TARGET="$1"
else
  TARGET="$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -name '20*' | sort | tail -1)"
fi
if [ -z "$TARGET" ] || [ ! -f "$TARGET/database.dump" ]; then
  echo "no backup found in $BACKUP_ROOT" >&2
  exit 1
fi
echo "== verifying restore of $TARGET =="

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" > /dev/null
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc "CREATE DATABASE $SCRATCH_DB OWNER $PG_USER" > /dev/null
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH_DB" --no-owner --exit-on-error < "$TARGET/database.dump"
echo "restored into $SCRATCH_DB"

RESTORED="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "select json_build_object('users', (select count(*) from users), 'identities', (select count(*) from user_identities),
    'workspaces', (select count(*) from workspaces), 'runs', (select count(*) from runs),
    'events', (select count(*) from run_events), 'agents', (select count(*) from run_agents),
    'checks', (select count(*) from run_checks), 'findings', (select count(*) from run_findings),
    'artifacts', (select count(*) from run_artifacts), 'checkpoints', (select count(*) from run_checkpoints),
    'jobs', (select count(*) from jobs), 'digest', (select md5(string_agg(id || ':' || last_seq || ':' || md5(document_json), ',' order by id)) from runs))")"

EXPECTED="$(python3 -c "import json,sys; print(json.dumps(json.load(open('$TARGET/manifest.json'))['database'], sort_keys=True))")"
ACTUAL="$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.stdin.read()), sort_keys=True))" <<< "$RESTORED")"

echo "expected: $EXPECTED"
echo "actual:   $ACTUAL"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "RESTORE VERIFICATION FAILED: database statistics differ" >&2
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" > /dev/null
  exit 1
fi

if [ -f "$TARGET/credentials.vault.json" ]; then
  CREDENTIAL_SHA="$(sha256sum "$TARGET/credentials.vault.json" | cut -d' ' -f1)"
  EXPECTED_SHA="$(python3 -c "import json; print(json.load(open('$TARGET/manifest.json'))['credentialsSha256'])")"
  if [ "$CREDENTIAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "RESTORE VERIFICATION FAILED: credential ciphertext hash differs" >&2
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" > /dev/null
    exit 1
  fi
  python3 - "$TARGET/credentials.vault.json" <<'PY'
import json, sys
vault = json.load(open(sys.argv[1]))
users = vault.get("users", vault)
providers = sorted({
    key
    for record in users.values()
    if isinstance(record, dict)
    for key in (record.get("providers") if isinstance(record.get("providers"), dict) else {})
})
print(f"credential ciphertext verified: {len(users)} owner(s), providers={providers}")
PY
fi

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" > /dev/null
echo "RESTORE VERIFIED OK (scratch database dropped)"
