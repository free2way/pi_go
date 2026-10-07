#!/usr/bin/env bash
# `npm run scan:secrets` — high-signal secret scan of TRACKED files.
#
# Why tracked files: an untracked scratch file is not part of the release. This
# scans exactly what `git ls-files` reports, so a clean scan is evidence about
# the shipped tree (the release gate runs it after `npm run build`).
#
# Detected (high-signal only — this is not a general entropy scanner):
#   - PEM private-key headers ("-----BEGIN ... PRIVATE KEY-----")
#   - OpenAI-style keys              sk-…  (sk-proj-…, sk-ant-…, …)
#   - AWS access key ids             AKIA…/ASIA… + 16 uppercase alnum
#   - GitHub tokens                  ghp_…, github_pat_…
#   - Google API keys                AIza… + 35 chars（2026-10-07 补：曾有一把真实
#     Google key 被当成测试夹具提交进仓库，当时没有这条规则所以漏过）
#   - JWTs / long Bearer literals    eyJ….….…, "Bearer <>=20 chars>"
#   - PostgreSQL URIs with a password user:password@host
#
# Ignored only when the match is obviously fake: lines carrying DUMMY_/dummy,
# example.com, placeholder, redacted, change-me, ${…} interpolation, or a
# well-known local/service host (localhost, postgres, db) or placeholder
# password (pass, password, secret, change-me, …). Every ignored match is silent
# by design; every real-looking match is printed with a redacted prefix only.
#
# Prerequisites: `git` (fail fast, exit 2) and being inside the work tree.
# Exit codes: 0 clean · 1 findings · 2 missing prerequisite / bad usage.
set -euo pipefail

SELF="scripts/secret-scan.sh"

usage() {
  cat <<'EOF'
scan:secrets — scan tracked files for high-signal secrets

Usage:
  npm run scan:secrets          # scan `git ls-files`
  npm run scan:secrets -- --help

Exit codes:
  0  no real-looking secret found
  1  at least one finding (file:line + redacted prefix printed)
  2  prerequisite missing (not a git work tree) or bad usage
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "scan:secrets: unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

if ! command -v git >/dev/null 2>&1; then
  echo "scan:secrets: git is required (the scan reads 'git ls-files')." >&2
  exit 2
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "scan:secrets: not inside a git work tree; nothing to scan." >&2
  exit 2
fi

# ---------------------------------------------------------------- allow rules

# Well-known placeholder passwords / local service hosts are obviously fake.
pg_uri_allowed() {
  local text="$1" pass host
  pass="$(printf '%s' "$text" | sed -nE 's#.*(postgres|postgresql)://[^:/@[:space:]]+:([^@[:space:]]+)@.*#\2#p')"
  host="$(printf '%s' "$text" | sed -nE 's#.*(postgres|postgresql)://[^:/@[:space:]]+:[^@[:space:]]+@([^:/@[:space:]]+).*#\2#p')"
  case "$pass" in
    ""|pass|Pass|password|Password|secret|Secret|change-me|changeme|CHANGE_ME|placeholder|redacted|dummy|DUMMY|test|Test|x|xxx|XXX) return 0 ;;
  esac
  case "$pass" in
    *DUMMY*|*dummy*|*'${'*|*'<'*|*'...'*) return 0 ;;
  esac
  case "$host" in
    ""|localhost|127.0.0.1|0.0.0.0|postgres|db|database|host|example.com|*.example.com|*.local|*.internal) return 0 ;;
  esac
  return 1
}

is_allowed() {
  local id="$1" text="$2"
  # Explicitly fake markers anywhere in the matched line.
  case "$text" in
    *DUMMY*|*dummy*|*example.com*|*EXAMPLE.COM*|*Example.com*|\
    *placeholder*|*Placeholder*|*PLACEHOLDER*|\
    *redacted*|*REDACTED*|*change-me*|*changeme*|*CHANGE_ME*|\
    *your-*|*YOUR_*|*'${'*) return 0 ;;
  esac
  if [ "$id" = "pg-uri" ]; then
    pg_uri_allowed "$text" && return 0
  fi
  return 1
}

redact() {
  local value="$1"
  if [ "${#value}" -le 8 ]; then
    printf '***'
  else
    printf '%s…' "${value:0:6}"
  fi
}

# ---------------------------------------------------------------- patterns

PATTERN_IDS=(
  "private-key"
  "openai-key"
  "aws-access-key"
  "github-token"
  "google-api-key"
  "jwt"
  "bearer-literal"
  "pg-uri"
)
PATTERN_REGEXES=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'sk-[A-Za-z0-9_-]{20,}'
  '(AKIA|ASIA)[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}'
  'AIza[0-9A-Za-z_-]{35}'
  'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
  '[Bb]earer[[:space:]]+[A-Za-z0-9._~+/=-]{20,}'
  '(postgres|postgresql)://[^/[:space:]@]+:[^/[:space:]@]+@[^/[:space:]]+'
)

# ---------------------------------------------------------------- scan

file_count="$(git ls-files | wc -l | tr -d ' ')"
echo "scan:secrets — scanning ${file_count} tracked file(s) for high-signal patterns…"

findings=0
ignored=0
report=""

for index in "${!PATTERN_IDS[@]}"; do
  id="${PATTERN_IDS[$index]}"
  index_pos=$((index))
  regex="${PATTERN_REGEXES[$index_pos]}"
  # grep -I skips binary files; a file with ':' in its name is not expected here.
  matches="$(git ls-files -z | xargs -0 grep -nHI -E -e "$regex" 2>/dev/null || true)"
  [ -n "$matches" ] || continue
  while IFS= read -r match; do
    [ -n "$match" ] || continue
    file="${match%%:*}"
    [ "$file" = "$SELF" ] && continue
    rest="${match#*:}"
    line="${rest%%:*}"
    text="${rest#*:}"
    if is_allowed "$id" "$text"; then
      ignored=$((ignored + 1))
      continue
    fi
    findings=$((findings + 1))
    matched="$(printf '%s' "$text" | grep -oE -e "$regex" | head -n 1 || true)"
    [ -n "$matched" ] || matched="$text"
    report="${report}  ${file}:${line}  [${id}]  $(redact "$matched")"$'\n'
  done <<< "$matches"
done

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "SECRET SCAN FAILED — ${findings} real-looking match(es) in tracked files:"
  printf '%s' "$report"
  echo ""
  echo "Matched material is redacted. Move real secrets to a secret manager, use an env var"
  echo "reference (\${VAR} / \$VAR) or a documented dummy marker (DUMMY_, example.com)."
  echo "If a finding is a false positive, add the specific fake marker rather than disabling the pattern."
  exit 1
fi

if [ "$ignored" -gt 0 ]; then
  echo "scan:secrets OK — no real-looking secrets found (${ignored} obviously-fake match(es) ignored)."
else
  echo "scan:secrets OK — no matches at all."
fi
exit 0
