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

RAW="$(docker exec "$RUNTIME_CONTAINER" cat /home/node/.pi/agent/models.json 2>/dev/null || echo '{"providers":{}}')"

python3 - "$OUTPUT" <<PY
import json
import re
import sys

raw = json.loads('''$RAW''')
secret_like = re.compile(r"^(?!\\$[A-Z_][A-Z0-9_]*$)[A-Za-z0-9_\\-]{16,}$")


def sanitize(value):
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str) and secret_like.match(value):
        # Drop literal keys: the worker injects the current provider key through
        # its environment, so definitions must reference \$ENV, never embed it.
        return ""
    return value


with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(sanitize(raw), handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"wrote {sys.argv[1]}")
PY

chmod 644 "$OUTPUT"
echo "--- sanitized definitions ---"
cat "$OUTPUT"
