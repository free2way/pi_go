/**
 * SYS-01 — pure aggregation for the read-only system status dashboard
 * (`GET /api/system/status`).
 *
 * Everything in this module is deterministic and side-effect free: the route
 * performs bounded SQL reads and probes, then hands the raw rows to
 * `buildSystemStatus`, which shapes them into a versioned response. Every
 * section that cannot be determined is reported explicitly as `unavailable`
 * (or a `null` value) instead of a fabricated zero, and nothing here throws on
 * missing tables, malformed `document_json` or absent fields.
 *
 * Privacy: the payload never contains credentials, environment values or file
 * paths outside safe roots. Failure event messages are summarised and stripped
 * of absolute paths / URLs before they leave the process.
 */

import type { RunState } from "../shared/types.js";
import type { DeploymentStatus } from "./deployments.js";

/**
 * Deployment data reused from `/api/deployments`, minus `log.path`: the system
 * status payload never exposes server paths. Version, rollback tags, records and
 * availability are preserved.
 */
export type DeploymentInfo = Omit<DeploymentStatus, "log"> & { log: Omit<DeploymentStatus["log"], "path"> };

export const SYSTEM_STATUS_SCHEMA_VERSION = 1;
export const FAILURE_WINDOW_HOURS = 24;
/** Upper bound on failure rows considered per request (counts are a lower bound past this). */
export const FAILURE_SCAN_LIMIT = 500;
/** Upper bound on today's run documents scanned for usage. */
export const USAGE_RUN_SCAN_LIMIT = 500;
/** How many recent failure events are surfaced with time + summary. */
export const FAILURE_RECENT_LIMIT = 5;

export const RUN_STATES: RunState[] = [
  "queued",
  "preparing",
  "developing",
  "checking",
  "reviewing",
  "completed",
  "needs_human",
  "failed",
  "cancelled",
];

export const JOB_STATES = ["queued", "claimed", "done", "failed", "cancelled"] as const;

/** `ok` means the source answered; `unavailable` means it could not be read. */
export type SectionStatus = "ok" | "unavailable";

export type FailureCategory = "storage" | "budget" | "provider" | "failure_artifact" | "other";

/** One `GROUP BY state` row: job/run counts, with the oldest row's timestamp when known. */
export interface StateCountRow {
  state: string;
  count: number | string;
  oldestAt?: string | null;
}

/** One failure-shaped `run_events` row (already bounded by the route query). */
export interface FailureEventRow {
  at?: string | null;
  type?: string | null;
  message?: string | null;
}

/** A run document updated today; `documentJson` is parsed defensively here. */
export interface TodayRunRow {
  documentJson?: string | null;
}

export interface SystemStatusInput {
  /** ISO timestamp; defaults to now. Injected so tests are deterministic. */
  now?: string;
  versions: {
    web: string | null;
    worker: string | null;
  };
  infrastructure: {
    database: { status: "ok" | "unavailable"; error?: string };
    worker: { status: "ok" | "unreachable" | "unknown"; activeJobs?: number; storage?: "ok" | "low" | "critical" };
  };
  /** `null` when the queue could not be queried (non-PostgreSQL store / SQL error). */
  jobStates: StateCountRow[] | null;
  /** `null` when run counts could not be queried. */
  runStates: StateCountRow[] | null;
  /** `null` when today's usage could not be queried. */
  todayRuns: Array<TodayRunRow | null> | null;
  /** `null` when recent failure events could not be queried. */
  failures: FailureEventRow[] | null;
  deployments: DeploymentInfo | null;
}

export interface QueueSummary {
  status: SectionStatus;
  byState: Record<string, number>;
  total: number;
  active: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMs: number | null;
}

export interface RunsSummary {
  status: SectionStatus;
  byState: Record<string, number>;
  total: number;
  active: {
    queued: number;
    preparing: number;
    developing: number;
    checking: number;
    reviewing: number;
    total: number;
  };
  oldestQueuedAt: string | null;
  oldestQueuedAgeMs: number | null;
}

export interface UsageSummary {
  status: SectionStatus;
  /** UTC calendar day the usage was aggregated for (`YYYY-MM-DD`). */
  date: string;
  /**
   * Best-effort "today": the store keeps cumulative per-run usage only, so this
   * sums the usage of runs updated today. `modelCalls` is `null` when no run
   * exposed a call count.
   */
  basis: "runs-updated-today";
  scannedRuns: number;
  truncated: boolean;
  modelCalls: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface FailureSummary {
  status: SectionStatus;
  windowHours: number;
  byCategory: Record<FailureCategory, number>;
  total: number;
  scanned: number;
  truncated: boolean;
  recent: Array<{
    at: string | null;
    type: string;
    category: FailureCategory;
    summary: string;
  }>;
}

export interface SystemStatusResponse {
  schemaVersion: typeof SYSTEM_STATUS_SCHEMA_VERSION;
  at: string;
  versions: SystemStatusInput["versions"];
  infrastructure: SystemStatusInput["infrastructure"];
  queue: QueueSummary;
  runs: RunsSummary;
  usage: UsageSummary;
  failures: FailureSummary;
  deployments: DeploymentInfo | null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Parses a timestamp, returning epoch milliseconds or `null` when unreadable. */
export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Age in milliseconds, clamped at zero; `null` when the timestamp is unreadable. */
export function ageMs(at: unknown, nowMs: number): number | null {
  const ms = parseIsoMs(at);
  if (ms === null) return null;
  return Math.max(0, nowMs - ms);
}

/** UTC calendar day (`YYYY-MM-DD`) for an ISO timestamp; falls back to today. */
export function utcDay(nowIso: string): string {
  const ms = parseIsoMs(nowIso);
  const date = ms === null ? new Date() : new Date(ms);
  return date.toISOString().slice(0, 10);
}

/** Start of the UTC day as an ISO timestamp, used as the SQL lower bound. */
export function utcDayStart(nowIso: string): string {
  const day = utcDay(nowIso);
  return `${day}T00:00:00.000Z`;
}

/** Matches `run.storage_error`, `*.failure_artifact`, `review.provider_error`, etc. */
export function failureCategory(type: unknown): FailureCategory {
  const value = typeof type === "string" ? type.toLowerCase() : "";
  if (value.includes("storage_error")) return "storage";
  if (value.includes("budget_exhausted")) return "budget";
  if (value.includes("failure_artifact")) return "failure_artifact";
  if (value.includes("provider_error")) return "provider";
  return "other";
}

/**
 * Collapses whitespace, removes URLs and absolute paths, and truncates. This is
 * what reaches the client, so no workspace/deploy paths or provider endpoints leak.
 */
export function sanitizeFailureSummary(message: unknown, max = 160): string {
  const raw = typeof message === "string" ? message : "";
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, "[url]");
  // Absolute POSIX paths (2+ segments) only; relative workspace paths are safe.
  text = text.replace(/(^|[\s"'`([])\/(?:[\w.@%+-]+\/)+[\w.@%+-]+/g, "$1[path]");
  // Absolute Windows paths.
  text = text.replace(/[A-Za-z]:\\[^\s"']+/g, "[path]");
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}…`;
  return text || "无摘要";
}

function summarizeStates(states: readonly string[], rows: StateCountRow[] | null) {
  const byState: Record<string, number> = {};
  for (const state of states) byState[state] = 0;
  const oldestAt: Record<string, string | null> = {};
  if (!rows) return { byState, oldestAt, total: 0, available: false };
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row.state !== "string") continue;
    const count = toNumber(row.count) ?? 0;
    byState[row.state] = (byState[row.state] ?? 0) + count;
    total += count;
    const at = typeof row.oldestAt === "string" && row.oldestAt.trim() ? row.oldestAt : null;
    if (at) {
      const current = oldestAt[row.state];
      const currentMs = parseIsoMs(current);
      const nextMs = parseIsoMs(at);
      if (nextMs !== null && (currentMs === null || nextMs < currentMs)) oldestAt[row.state] = at;
    }
  }
  return { byState, oldestAt, total, available: true };
}

function buildQueue(jobStates: StateCountRow[] | null, nowMs: number): QueueSummary {
  if (!jobStates) {
    return { status: "unavailable", byState: Object.fromEntries(JOB_STATES.map((state) => [state, 0])), total: 0, active: 0, oldestQueuedAt: null, oldestQueuedAgeMs: null };
  }
  const { byState, oldestAt, total } = summarizeStates(JOB_STATES, jobStates);
  const oldestQueuedAt = oldestAt.queued ?? null;
  return {
    status: "ok",
    byState,
    total,
    active: (byState.queued ?? 0) + (byState.claimed ?? 0),
    oldestQueuedAt,
    oldestQueuedAgeMs: ageMs(oldestQueuedAt, nowMs),
  };
}

function buildRuns(runStates: StateCountRow[] | null, nowMs: number): RunsSummary {
  const emptyActive = { queued: 0, preparing: 0, developing: 0, checking: 0, reviewing: 0, total: 0 };
  if (!runStates) {
    return { status: "unavailable", byState: Object.fromEntries(RUN_STATES.map((state) => [state, 0])), total: 0, active: emptyActive, oldestQueuedAt: null, oldestQueuedAgeMs: null };
  }
  const { byState, oldestAt, total } = summarizeStates(RUN_STATES, runStates);
  const oldestQueuedAt = oldestAt.queued ?? null;
  const active = {
    queued: byState.queued ?? 0,
    preparing: byState.preparing ?? 0,
    developing: byState.developing ?? 0,
    checking: byState.checking ?? 0,
    reviewing: byState.reviewing ?? 0,
    total: 0,
  };
  active.total = active.queued + active.preparing + active.developing + active.checking + active.reviewing;
  return { status: "ok", byState, total, active, oldestQueuedAt, oldestQueuedAgeMs: ageMs(oldestQueuedAt, nowMs) };
}

function parseRunDocument(entry: TodayRunRow | null | undefined): Record<string, unknown> | null {
  if (!entry || typeof entry.documentJson !== "string" || !entry.documentJson.trim()) return null;
  try {
    const parsed = JSON.parse(entry.documentJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildUsage(todayRuns: Array<TodayRunRow | null> | null, date: string): UsageSummary {
  if (!todayRuns) {
    return { status: "unavailable", date, basis: "runs-updated-today", scannedRuns: 0, truncated: false, modelCalls: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let callsKnown = 0;
  let callsUnknown = 0;
  let scannedRuns = 0;
  for (const entry of todayRuns) {
    const run = parseRunDocument(entry);
    if (!run) continue;
    scannedRuns += 1;
    const usage = run.usage && typeof run.usage === "object" ? (run.usage as Record<string, unknown>) : undefined;
    const input = toNumber(usage?.inputTokens) ?? 0;
    const output = toNumber(usage?.outputTokens) ?? 0;
    inputTokens += input;
    outputTokens += output;
    totalTokens += toNumber(usage?.totalTokens) ?? input + output;
    estimatedCost += toNumber(usage?.estimatedCost) ?? 0;
    const calls = toNumber(run.modelCalls);
    if (calls !== null) {
      callsKnown += calls;
    } else if (Array.isArray(run.usageRoles)) {
      let roleCalls = 0;
      let roleCallsReadable = false;
      for (const role of run.usageRoles) {
        const value = toNumber((role as Record<string, unknown> | null)?.calls);
        if (value !== null) {
          roleCalls += value;
          roleCallsReadable = true;
        }
      }
      if (roleCallsReadable) callsKnown += roleCalls;
      else callsUnknown += 1;
    } else {
      callsUnknown += 1;
    }
  }
  return {
    status: "ok",
    date,
    basis: "runs-updated-today",
    scannedRuns,
    truncated: todayRuns.length >= USAGE_RUN_SCAN_LIMIT,
    // Unknown only when no run in the window exposed a call count.
    modelCalls: callsKnown > 0 || callsUnknown === 0 ? callsKnown : null,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost,
  };
}

function buildFailures(rows: FailureEventRow[] | null): FailureSummary {
  const byCategory: Record<FailureCategory, number> = { storage: 0, budget: 0, provider: 0, failure_artifact: 0, other: 0 };
  if (!rows) {
    return { status: "unavailable", windowHours: FAILURE_WINDOW_HOURS, byCategory, total: 0, scanned: 0, truncated: false, recent: [] };
  }
  const parsed = rows
    .map((row, index) => {
      const type = typeof row?.type === "string" && row.type.trim() ? row.type.trim() : "unknown";
      const category = failureCategory(type);
      const atMs = parseIsoMs(row?.at);
      return { at: atMs === null ? null : new Date(atMs).toISOString(), atMs: atMs ?? -1, type, category, summary: sanitizeFailureSummary(row?.message), index };
    })
    .sort((a, b) => b.atMs - a.atMs || a.index - b.index);
  for (const item of parsed) byCategory[item.category] += 1;
  return {
    status: "ok",
    windowHours: FAILURE_WINDOW_HOURS,
    byCategory,
    total: parsed.length,
    scanned: rows.length,
    truncated: rows.length >= FAILURE_SCAN_LIMIT,
    recent: parsed.slice(0, FAILURE_RECENT_LIMIT).map(({ at, type, category, summary }) => ({ at, type, category, summary })),
  };
}

/** Shapes bounded raw rows into the versioned dashboard payload. Never throws. */
export function buildSystemStatus(input: SystemStatusInput): SystemStatusResponse {
  const now = typeof input.now === "string" && parseIsoMs(input.now) !== null ? input.now : new Date().toISOString();
  const nowMs = parseIsoMs(now) as number;
  return {
    schemaVersion: SYSTEM_STATUS_SCHEMA_VERSION,
    at: now,
    versions: { web: input.versions?.web ?? null, worker: input.versions?.worker ?? null },
    infrastructure: input.infrastructure,
    queue: buildQueue(input.jobStates, nowMs),
    runs: buildRuns(input.runStates, nowMs),
    usage: buildUsage(input.todayRuns, utcDay(now)),
    failures: buildFailures(input.failures),
    deployments: input.deployments ?? null,
  };
}
