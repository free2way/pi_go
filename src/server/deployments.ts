/**
 * A3 — read-only deployment reporting. Sources:
 * - the version environment variables (`PI_VERSION`, `PI_WEB_VERSION`,
 *   `PI_WORKER_VERSION`), each of which may be unknown;
 * - optional rollback tags (`PI_ROLLBACK_TAGS`, comma-separated);
 * - an optional deploy log (`PI_DEPLOY_LOG`, default
 *   `/app/pi-agent/backups/deploy.log`) parsed defensively: a missing file is
 *   an empty list, never an error, and one malformed line never drops the rest.
 */

export const DEFAULT_DEPLOY_LOG_PATH = "/app/pi-agent/backups/deploy.log";

export function resolveDeployLogPath(env: Record<string, string | undefined>): string {
  const configured = (env.PI_DEPLOY_LOG ?? "").trim();
  return configured || DEFAULT_DEPLOY_LOG_PATH;
}

export interface DeployRecord {
  at: string | null;
  version: string | null;
  role: string | null;
  commit: string | null;
  status: string | null;
  note: string | null;
  raw: string;
}

function pick(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Parses one deploy-log line as JSON when possible, otherwise as plain text. */
export function parseDeployLogLine(line: string): DeployRecord | undefined {
  const raw = line.trim();
  if (!raw) return undefined;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        at: pick(parsed, ["at", "time", "timestamp", "date"]),
        version: pick(parsed, ["version", "tag", "release"]),
        role: pick(parsed, ["role", "service", "component"]),
        commit: pick(parsed, ["commit", "sha", "revision"]),
        status: pick(parsed, ["status", "result", "outcome"]),
        note: pick(parsed, ["note", "message", "msg"]),
        raw,
      };
    } catch {
      // Fall through to the plain-text parse; a malformed JSON line must not
      // hide the rest of the log.
    }
  }
  // Plain text, e.g. `2026-01-02T03:04:05Z version=0.21.9 role=web status=ok`.
  const at = /^(\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?)/.exec(raw)?.[1] ?? null;
  const fields: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)=("[^"]*"|\S+)/g)) {
    fields[match[1].toLowerCase()] = match[2].replace(/^"|"$/g, "");
  }
  // A line with neither a timestamp nor any key=value field is not a deploy
  // record; skipping it keeps the list meaningful.
  if (!at && Object.keys(fields).length === 0) return undefined;
  return {
    at,
    version: pick(fields, ["version", "tag", "release"]),
    role: pick(fields, ["role", "service", "component"]),
    commit: pick(fields, ["commit", "sha", "revision"]),
    status: pick(fields, ["status", "result", "outcome"]),
    note: pick(fields, ["note", "message", "msg"]),
    raw,
  };
}

/** Parses a deploy log body, newest first, bounded to `limit` records. */
export function parseDeployLog(content: string | null | undefined, limit = 20): DeployRecord[] {
  if (typeof content !== "string" || !content) return [];
  const records: DeployRecord[] = [];
  for (const line of content.split("\n")) {
    const record = parseDeployLogLine(line);
    if (record) records.push(record);
  }
  return records.slice(-limit).reverse();
}

export function parseRollbackTags(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export interface DeploymentStatus {
  web: { version: string | null };
  worker: { version: string | null };
  rollbackTags: string[];
  records: DeployRecord[];
  log: { available: boolean; path: string; error?: string };
  at: string;
}

/** Assembles the read-only status payload; every unknown stays `null`. */
export function buildDeploymentStatus(input: {
  env: Record<string, string | undefined>;
  records: DeployRecord[];
  logPath: string;
  logAvailable: boolean;
  logError?: string;
  at?: string;
}): DeploymentStatus {
  const version = (value: string | undefined) => (value && value.trim() ? value.trim() : null);
  return {
    web: { version: version(input.env.PI_WEB_VERSION) ?? version(input.env.PI_VERSION) },
    worker: { version: version(input.env.PI_WORKER_VERSION) },
    rollbackTags: parseRollbackTags(input.env.PI_ROLLBACK_TAGS),
    records: input.records,
    log: {
      available: input.logAvailable,
      path: input.logPath,
      ...(input.logError ? { error: input.logError.slice(0, 200) } : {}),
    },
    at: input.at ?? new Date().toISOString(),
  };
}
