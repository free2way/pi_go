#!/usr/bin/env node
/**
 * AUD-14 / AT-SEC-001: renders a *whitelist* view of a container's environment
 * for backups. Only explicitly non-sensitive keys keep their value; every other
 * variable is reduced to its name. URLs are additionally stripped of any
 * userinfo, so a database password can never reach the backup file.
 *
 * Usage: env-sanitize.mjs < raw-env-file > sanitized-env-file
 */
import { readFileSync } from "node:fs";

/** Keys that are safe to keep verbatim (they configure behaviour, not secrets). */
export const whitelist = [
  "PI_VERSION",
  "PI_AUTH_MODE",
  "PI_PUBLIC_ORIGIN",
  "PI_REAL_RUNS_ENABLED",
  "PI_DEMO_MODE",
  "PI_DEVELOPER_PROVIDER",
  "PI_DEVELOPER_MODEL",
  "PI_REVIEWER_PROVIDER",
  "PI_REVIEWER_MODEL",
  "PI_MAX_REVIEW_ROUNDS",
  "PI_MAX_SUBAGENTS",
  "PI_MAX_ACTIVE_JOBS",
  "PI_RUN_TIMEOUT_SECONDS",
  "PI_RUN_MAX_TOKENS",
  "PI_RUN_MAX_COST_USD",
  "PI_RUN_MAX_MODEL_CALLS",
  "PI_RUN_MAX_DURATION_SECONDS",
  "PI_JOB_STALE_SECONDS",
  "PI_SANDBOX_MODE",
  "PI_SANDBOX_IMAGE",
  "PI_SANDBOX_NETWORK",
  "PI_WORKSPACE_ROOT",
  "PI_HOST_WORKSPACE_ROOT",
  "HOST",
  "PORT",
  "NODE_ENV",
  "NODE_VERSION",
  "PATH",
];

const allowed = new Set(whitelist);
const secretish = /(secret|token|password|passwd|api[_-]?key|credential|private)/i;

/** Removes `user:password@` from any URL-shaped value. */
export function stripUrlCredentials(value) {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1");
}

export function sanitizeEnvValue(key, value) {
  if (!allowed.has(key)) return "[redacted]";
  if (secretish.test(key)) return "[redacted]";
  return stripUrlCredentials(value);
}

export function sanitizeEnvText(text) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const index = line.indexOf("=");
      if (index === -1) return line;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1);
      return `${key}=${sanitizeEnvValue(key, value)}`;
    })
    .join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");
  process.stdout.write(`${sanitizeEnvText(input)}\n`);
}
