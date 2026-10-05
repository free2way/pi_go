/**
 * 拓扑轮次模型 — read-only per-round summaries for `GET /api/runs/:id/rounds`.
 *
 * The client topology derives its rework branches and per-round badges from the
 * events it currently holds, which are hard-capped (SSE/initial fetch window).
 * On a long run that silently drops older `review.changes_requested` rounds. This
 * module moves the round model to the server, where every event is still stored.
 *
 * Everything here is bounded: the route issues a small, fixed set of SQL
 * aggregations (`GROUP BY round` plus one row per return round / per round
 * carrying a check snapshot) and never loads the full event log into memory.
 * `buildRoundSummaries` is a pure function over already-aggregated rows, so it
 * is fully unit-testable without a database.
 */

import type { RoundSummary, RoundVerdict } from "../shared/types.js";
import type { Queryable } from "./db.js";

export const ROUNDS_SCHEMA_VERSION = 1;

/** One `GROUP BY round` row: terminal verdict flags, timestamps and interruption. */
export interface RoundEventAggregateRow {
  round?: number | string | null;
  started_at?: string | null;
  approved_at?: string | null;
  changes_requested_at?: string | null;
  has_approved?: number | string | boolean | null;
  has_changes_requested?: number | string | boolean | null;
  has_interrupt?: number | string | boolean | null;
}

/** One `review.changes_requested` event, ordered by `seq`; the last one wins. */
export interface RoundReasonRow {
  round?: number | string | null;
  seq?: number | string | null;
  message?: string | null;
}

/** One check-bearing event (`checks.*` / `review.*`), ordered by `seq`. */
export interface RoundCheckRow {
  round?: number | string | null;
  seq?: number | string | null;
  type?: string | null;
  meta_json?: string | null;
}

/** One `run_findings` aggregate row attributed to a round. */
export interface RoundFindingRow {
  round?: number | string | null;
  total?: number | string | null;
  resolved?: number | string | null;
}

export interface RoundSummaryInput {
  eventRows?: RoundEventAggregateRow[] | null;
  reasonRows?: RoundReasonRow[] | null;
  checkRows?: RoundCheckRow[] | null;
  findingRows?: RoundFindingRow[] | null;
  /**
   * The run's current round. Added as a `planned` summary when it has no events
   * yet, so a freshly opened round still gets a marker on the pipeline.
   */
  currentRound?: number;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toRound(value: unknown): number | undefined {
  const parsed = toNumber(value, Number.NaN);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function toTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Non-empty string, trimmed of surrounding whitespace; `undefined` otherwise. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function laterOf(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate > current ? candidate : current;
}

/** Check counts from one event's meta, or `undefined` when it carries none. */
function checkCountsFor(meta: Record<string, unknown>, type: string | undefined): { passed: number; failed: number } | undefined {
  if (Array.isArray(meta.checks)) {
    const checks = meta.checks as Array<{ status?: unknown } | null>;
    return {
      passed: checks.filter((item) => item?.status === "passed").length,
      failed: checks.filter((item) => item?.status === "failed").length,
    };
  }
  // Checkpoint-restored runs omit the result array but still record failure.
  if (type === "checks.returned" && meta.checkPassed === false) return { passed: 0, failed: 1 };
  return undefined;
}

function parseMeta(metaJson: unknown): Record<string, unknown> | undefined {
  if (typeof metaJson !== "string" || !metaJson.trim()) return undefined;
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shapes already-aggregated rows into ascending `RoundSummary[]`.
 *
 * Precedence within a round: `approved` > `changes_requested` > no verdict.
 * `reason` is always the latest `review.changes_requested` message. A round is
 * `interrupted` only when it carries a deadline/recovery event *and* no review
 * verdict. Unknown event types contribute nothing and are simply ignored; every
 * malformed row degrades to a default instead of throwing.
 */
export function buildRoundSummaries(input: RoundSummaryInput): RoundSummary[] {
  const summaries = new Map<number, RoundSummary>();

  const ensure = (round: number): RoundSummary => {
    const existing = summaries.get(round);
    if (existing) return existing;
    const created: RoundSummary = {
      round,
      verdict: "none",
      checks: { passed: 0, failed: 0 },
      findings: { total: 0, resolved: 0 },
      interrupted: false,
    };
    summaries.set(round, created);
    return created;
  };

  for (const row of input.eventRows ?? []) {
    const round = toRound(row?.round);
    if (round === undefined) continue;
    const summary = ensure(round);
    const startedAt = toTimestamp(row?.started_at);
    if (startedAt) summary.startedAt = summary.startedAt ? (startedAt < summary.startedAt ? startedAt : summary.startedAt) : startedAt;

    const approvedAt = toTimestamp(row?.approved_at);
    const changesRequestedAt = toTimestamp(row?.changes_requested_at);
    const verdict: RoundVerdict = toFlag(row?.has_approved)
      ? "approved"
      : toFlag(row?.has_changes_requested)
        ? "changes_requested"
        : "none";
    summary.verdict = verdict;
    const finishedAt = verdict === "approved" ? approvedAt : verdict === "changes_requested" ? changesRequestedAt : undefined;
    if (finishedAt) summary.finishedAt = laterOf(summary.finishedAt, finishedAt);
    summary.interrupted = toFlag(row?.has_interrupt) && verdict === "none";
  }

  // Later return events carry the returned reason; the file is ordered by seq.
  for (const row of input.reasonRows ?? []) {
    const round = toRound(row?.round);
    if (round === undefined) continue;
    const message = nonEmptyString(row?.message);
    if (!message) continue;
    ensure(round).reason = message;
  }

  // Check counts: the latest snapshot in the round wins, matching the client's
  // "last event carrying `meta.checks`" rule.
  for (const row of input.checkRows ?? []) {
    const round = toRound(row?.round);
    if (round === undefined) continue;
    const meta = parseMeta(row?.meta_json);
    if (!meta) continue;
    const counts = checkCountsFor(meta, row?.type ?? undefined);
    if (counts) ensure(round).checks = counts;
  }

  for (const row of input.findingRows ?? []) {
    const round = toRound(row?.round);
    if (round === undefined) continue;
    const summary = ensure(round);
    summary.findings = {
      total: Math.max(0, toNumber(row?.total, 0)),
      resolved: Math.max(0, toNumber(row?.resolved, 0)),
    };
  }

  if (input.currentRound !== undefined && input.currentRound > 0) ensure(input.currentRound);

  return [...summaries.values()].sort((a, b) => a.round - b.round);
}

/**
 * Bounded SQL reads for one run, then pure shaping. Every query is scoped to the
 * run and returns one row per round (or per round-specific event), never the
 * full event log.
 */
export async function readRunRounds(db: Queryable, runId: string, currentRound?: number): Promise<RoundSummary[]> {
  const [events, reasons, checks, findings] = await Promise.all([
    db.query(
      `SELECT round,
              MIN(at) AS started_at,
              MAX(CASE WHEN type = 'review.approved' THEN at END) AS approved_at,
              MAX(CASE WHEN type = 'review.changes_requested' THEN at END) AS changes_requested_at,
              MAX(CASE WHEN type = 'review.approved' THEN 1 ELSE 0 END) AS has_approved,
              MAX(CASE WHEN type = 'review.changes_requested' THEN 1 ELSE 0 END) AS has_changes_requested,
              MAX(CASE WHEN type = 'run.deadline_exceeded' OR type LIKE 'run.recovery%' OR type = 'run.resume_failed' THEN 1 ELSE 0 END) AS has_interrupt
         FROM run_events
        WHERE run_id = $1
        GROUP BY round`,
      [runId],
    ),
    db.query(
      "SELECT round, seq, message FROM run_events WHERE run_id = $1 AND type = 'review.changes_requested' ORDER BY seq ASC",
      [runId],
    ),
    db.query(
      `SELECT round, seq, type, meta_json FROM run_events
        WHERE run_id = $1 AND meta_json IS NOT NULL AND (type LIKE 'checks.%' OR type LIKE 'review.%')
        ORDER BY seq ASC`,
      [runId],
    ),
    db.query(
      `SELECT COALESCE(first_seen_round, last_seen_round) AS round,
              COUNT(*) AS total,
              SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) AS resolved
         FROM run_findings
        WHERE run_id = $1 AND COALESCE(first_seen_round, last_seen_round) IS NOT NULL
        GROUP BY COALESCE(first_seen_round, last_seen_round)`,
      [runId],
    ),
  ]);

  return buildRoundSummaries({
    eventRows: events.rows as unknown as RoundEventAggregateRow[],
    reasonRows: reasons.rows as unknown as RoundReasonRow[],
    checkRows: checks.rows as unknown as RoundCheckRow[],
    findingRows: findings.rows as unknown as RoundFindingRow[],
    currentRound,
  });
}
