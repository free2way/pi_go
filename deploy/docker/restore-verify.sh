#!/usr/bin/env bash
# REL-007 / AT-REL-009: restore the newest backup into a scratch database and
# verify users, runs, events, checkpoints, jobs and the credential ciphertext
# match the manifest recorded at backup time. The production database is never
# touched: restore only into a NEW pigo_restore_verify[_suffix] database. An
# existing database is never dropped or reused, even when it has a scratch name.
#
# Usage (on the deployment host):  bash restore-verify.sh [backup-dir]
set -euo pipefail

PROJECT_DIR="${PI_PIGO_DIR:-/app/pi-agent}"
PG_CONTAINER="${PI_PG_CONTAINER:-pi-agent-postgres-1}"
PG_USER="${PI_PG_USER:-pigo}"
SCRATCH_DB="${PI_RESTORE_DB:-pigo_restore_verify_$(date -u +%Y%m%d%H%M%S)_$$}"
BACKUP_ROOT="${PI_BACKUP_ROOT:-$PROJECT_DIR/backups}"

if [[ ! "$SCRATCH_DB" =~ ^pigo_restore_verify(_[a-z0-9_]+)?$ ]] || [ "${#SCRATCH_DB}" -gt 63 ]; then
  echo "restore refused: PI_RESTORE_DB must be a dedicated pigo_restore_verify[_suffix] name (max 63 bytes)" >&2
  exit 2
fi
if [[ ! "$PG_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || [ "${#PG_USER}" -gt 63 ]; then
  echo "restore refused: PI_PG_USER must be a simple PostgreSQL role identifier" >&2
  exit 2
fi
if [ "$SCRATCH_DB" = "${PI_PG_DB:-pigo}" ]; then
  echo "restore refused: scratch database matches the configured source database" >&2
  exit 2
fi

if [ -n "${1:-}" ]; then
  TARGET="$1"
else
  TARGET="$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -name '20*' | sort | tail -1)"
fi
if [ -z "$TARGET" ] || [ ! -s "$TARGET/database.dump" ] || [ ! -f "$TARGET/manifest.json" ]; then
  echo "no backup found in $BACKUP_ROOT" >&2
  exit 1
fi
echo "== verifying restore of $TARGET =="

# Validate backup integrity before any database operation. Use argv, never
# interpolate filesystem paths into Python source (paths may contain quotes).
EXPECTED="$(python3 - "$TARGET" <<'PY'
import hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()
try:
    manifest = json.loads((root / 'manifest.json').read_text())
    database = manifest['database']
    required = {'users', 'identities', 'workspaces', 'runs', 'events', 'agents',
                'checks', 'findings', 'artifacts', 'checkpoints', 'jobs', 'digest'}
    if not isinstance(database, dict) or set(database) != required:
        raise ValueError('database evidence is incomplete')
    for key in required - {'digest'}:
        if type(database[key]) is not int or database[key] < 0:
            raise ValueError('database counts are invalid')
    if database['digest'] is not None and not re.fullmatch(r'[0-9a-f]{32}', str(database['digest'])):
        raise ValueError('database digest is invalid')
    if digest(root / 'database.dump') != manifest['databaseDumpSha256']:
        raise ValueError('database dump hash differs')
    vault = root / 'credentials.vault.json'
    expected = manifest['credentialsSha256']
    if expected == 'none':
        if vault.exists():
            raise ValueError('unexpected credential backup')
    elif not vault.is_file() or digest(vault) != expected:
        raise ValueError('credential backup missing or hash differs')
    elif not isinstance(json.loads(vault.read_text()), dict):
        raise ValueError('credential backup is invalid')
    print(json.dumps(database, sort_keys=True))
except Exception:
    print('RESTORE REFUSED: backup manifest or file integrity is invalid', file=sys.stderr)
    sys.exit(1)
PY
)"

created=0
cleanup() {
  local result=$?
  trap - EXIT
  # Only delete a database this invocation successfully created. CREATE is
  # atomic: another invocation/pre-existing database makes it fail, not replace.
  if [ "$created" -eq 1 ]; then
    if ! docker exec "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres -tAc "DROP DATABASE \"$SCRATCH_DB\"" > /dev/null; then
      echo "scratch cleanup failed: $SCRATCH_DB retained for operator inspection" >&2
      result=1
    elif [ "$result" -eq 0 ]; then
      echo "RESTORE VERIFIED OK (owned scratch database dropped)"
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker exec "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres -tAc "CREATE DATABASE \"$SCRATCH_DB\" OWNER \"$PG_USER\"" > /dev/null
created=1
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH_DB" --no-owner --exit-on-error < "$TARGET/database.dump"
echo "restored into $SCRATCH_DB"

RESTORED="$(docker exec "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "select json_build_object('users', (select count(*) from users), 'identities', (select count(*) from user_identities),
    'workspaces', (select count(*) from workspaces), 'runs', (select count(*) from runs),
    'events', (select count(*) from run_events), 'agents', (select count(*) from run_agents),
    'checks', (select count(*) from run_checks), 'findings', (select count(*) from run_findings),
    'artifacts', (select count(*) from run_artifacts), 'checkpoints', (select count(*) from run_checkpoints),
    'jobs', (select count(*) from jobs), 'digest', (select md5(string_agg(id || ':' || last_seq || ':' || md5(document_json), ',' order by id)) from runs))")"

ACTUAL="$(python3 -c "import json,sys; print(json.dumps(json.loads(sys.stdin.read()), sort_keys=True))" <<< "$RESTORED")"

echo "expected: $EXPECTED"
echo "actual:   $ACTUAL"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "RESTORE VERIFICATION FAILED: database statistics differ" >&2
  exit 1
fi

if [ -f "$TARGET/credentials.vault.json" ]; then
  echo "credential ciphertext integrity verified (no decryption performed)"
fi
