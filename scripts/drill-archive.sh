#!/usr/bin/env bash
# `npm run drill:archive` — archive a reliability drill on the deployment host.
#
# What it does (on the target host, in the project dir):
#   1. runs the existing deploy/docker/backup.sh into
#      <project>/backups/drills/<timestamp>/
#   2. runs the existing deploy/docker/restore-verify.sh against that backup
#   3. records the backup manifest sha256 + a summary under the same directory
#   4. optionally copies a local provider-drill output directory into
#      <timestamp>/drills/
#
# Safety:
#   - DRY-RUN BY DEFAULT: without --apply it prints the exact script it would run
#     and executes nothing (no backup, no restore, no ssh).
#   - --apply runs it; in a non-interactive shell --apply additionally requires
#     --yes (interactive shells get a confirmation prompt).
#   - The target host is optional (`--target user@host` or PI_DRILL_HOST); with
#     no target the commands run on the current host.
#
# Usage:
#   npm run drill:archive -- --target free2way@192.168.2.235 --drill-dir backups/drills/local
#   npm run drill:archive -- --apply --yes --target free2way@192.168.2.235
set -euo pipefail

APPLY=0
YES=0
TARGET="${PI_DRILL_HOST:-}"
PROJECT_DIR="${PI_PIGO_DIR:-/app/pi-agent}"
DRILL_DIR=""

usage() {
  cat <<'EOF'
drill:archive — run backup + restore-verify and archive the evidence

Usage:
  npm run drill:archive -- [options]

Options:
  --apply                actually run (default: dry-run, print the plan only)
  --yes                  skip the interactive confirmation (required with --apply in CI)
  --target user@host     run on this host over ssh (default: PI_DRILL_HOST or localhost)
  --project-dir <dir>    project dir on the host (default: PI_PIGO_DIR or /app/pi-agent)
  --drill-dir <dir>      local provider-drill output dir to copy into the archive
  --help

Environment:
  PI_DRILL_HOST   default --target
  PI_PIGO_DIR     default --project-dir
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --yes) YES=1; shift ;;
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:?--project-dir needs a value}"; shift 2 ;;
    --drill-dir) DRILL_DIR="${2:?--drill-dir needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "drill:archive: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$APPLY" -eq 1 ]; then
  if [ "$YES" -ne 1 ]; then
    if [ -t 0 ]; then
      printf 'drill:archive: run backup + restore-verify against %s? [y/N] ' "${TARGET:-this host}"
      read -r answer
      case "$answer" in y|Y|yes|YES) ;; *) echo "drill:archive: aborted." >&2; exit 2 ;; esac
    else
      echo "drill:archive: refusing --apply in a non-interactive shell without --yes." >&2
      exit 2
    fi
  fi
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${PROJECT_DIR%/}/backups/drills/${TS}"

# Template stays single-quoted so nothing expands here; placeholders are
# substituted below and the whole script runs on the target host.
TEMPLATE='set -euo pipefail
DEST="__DEST__"
cd "__PROJECT_DIR__"
mkdir -p "$DEST"
echo "== PiGO drill archive $DEST =="
bash deploy/docker/backup.sh "$DEST" 2>&1 | tee "$DEST/backup.log"
BACKUP_TS_DIR="$(find "$DEST" -maxdepth 1 -mindepth 1 -type d -name "20*" | sort | tail -1)"
if [ -z "$BACKUP_TS_DIR" ]; then echo "drill:archive: backup produced no timestamped dir under $DEST" >&2; exit 1; fi
bash deploy/docker/restore-verify.sh "$BACKUP_TS_DIR" 2>&1 | tee "$DEST/restore-verify.log"
sha256sum "$BACKUP_TS_DIR/manifest.json" | awk "{print \$1}" > "$DEST/manifest.sha256"
MANIFEST_SHA="$(cat "$DEST/manifest.sha256")"
{
  echo "drill-archive $DEST"
  echo "createdAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "backupDir=$BACKUP_TS_DIR"
  echo "manifestSha256=$MANIFEST_SHA"
  echo "restoreVerify=RESTORE_VERIFIED"
} > "$DEST/archive-summary.txt"
cat "$DEST/archive-summary.txt"'

REMOTE_SCRIPT="${TEMPLATE//__DEST__/$DEST}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__PROJECT_DIR__/$PROJECT_DIR}"

run_remote() {
  if [ -n "$TARGET" ]; then
    printf '%s\n' "$REMOTE_SCRIPT" | ssh -o BatchMode=yes "$TARGET" 'bash -s'
  else
    printf '%s\n' "$REMOTE_SCRIPT" | bash -s
  fi
}

copy_drill_dir() {
  if [ -z "$DRILL_DIR" ]; then return 0; fi
  if [ ! -d "$DRILL_DIR" ]; then
    echo "drill:archive: --drill-dir $DRILL_DIR is not a directory" >&2
    exit 2
  fi
  if [ -n "$TARGET" ]; then
    ssh -o BatchMode=yes "$TARGET" "mkdir -p '$DEST/drills'" && scp -q -r "$DRILL_DIR/." "$TARGET:$DEST/drills/"
  else
    mkdir -p "$DEST/drills" && cp -R "$DRILL_DIR/." "$DEST/drills/"
  fi
}

if [ "$APPLY" -ne 1 ]; then
  echo "[drill:archive] DRY-RUN — nothing is executed. Archive directory would be: $DEST"
  if [ -n "$TARGET" ]; then
    echo "[drill:archive] would run over ssh on: $TARGET"
  else
    echo "[drill:archive] would run on this host"
  fi
  echo "[drill:archive] --- BEGIN script that would run on the host ---"
  printf '%s\n' "$REMOTE_SCRIPT"
  echo "[drill:archive] --- END script ---"
  if [ -n "$DRILL_DIR" ]; then
    if [ -n "$TARGET" ]; then
      echo "[drill:archive] would copy $DRILL_DIR/ -> $TARGET:$DEST/drills/ (scp -r)"
    else
      echo "[drill:archive] would copy $DRILL_DIR/ -> $DEST/drills/ (cp -R)"
    fi
  fi
  echo "[drill:archive] re-run with --apply --yes to execute."
  exit 0
fi

echo "[drill:archive] running on ${TARGET:-this host} -> $DEST"
run_remote
copy_drill_dir
if [ -n "$TARGET" ]; then
  echo "[drill:archive] archived on $TARGET:$DEST"
else
  echo "[drill:archive] archived in $DEST"
fi
