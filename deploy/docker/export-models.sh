#!/usr/bin/env bash
# SEC-004: exports the provider/model definitions the worker needs, with every
# literal credential stripped. Only `$ENV_VAR` references survive, so the file can
# be mounted read-only into the worker without exposing the interactive Pi
# configuration volume (auth, session transcripts, caches).
#
# Usage (on the deployment host):
#   bash export-models.sh [output-path]      # default: <project>/pi-models.json
set -euo pipefail

PROJECT_DIR="${PI_PIGO_DIR:-/app/pi-agent}"
RUNTIME_CONTAINER="${PI_RUNTIME_CONTAINER:-pi-agent-runtime-1}"
OUTPUT="${1:-$PROJECT_DIR/pi-models.json}"
RAW_FILE="$(mktemp)"

if ! docker exec "$RUNTIME_CONTAINER" cat /home/node/.pi/agent/models.json > "$RAW_FILE" 2>/dev/null; then
  echo '{"providers":{}}' > "$RAW_FILE"
fi

python3 - "$RAW_FILE" "$OUTPUT" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    raw = json.load(handle)

env_reference = re.compile(r"^\$[A-Z_][A-Z0-9_]*$")
secret_key = re.compile(r"(api[_-]?key|token|secret|password)", re.IGNORECASE)


def sanitize(value, key=""):
    if isinstance(value, dict):
        return {item: sanitize(child, item) for item, child in value.items()}
    if isinstance(value, list):
        return [sanitize(item, key) for item in value]
    if isinstance(value, str) and secret_key.search(key) and not env_reference.match(value):
        # Literal credentials never leave the configuration volume; the worker
        # injects the current provider key through its environment instead.
        return ""
    return value


with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(sanitize(raw), handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"wrote {sys.argv[2]}")
PY

rm -f "$RAW_FILE"
chmod 644 "$OUTPUT"
echo "--- sanitized definitions ---"
cat "$OUTPUT"
