/**
 * AT-JEV-056 (docs/27 §7.6): retention/cleanup of the decision-plane audit
 * table, `decision_evaluations` (migration 15).
 *
 * Acceptance criteria this module owns:
 *  - the audit metadata follows the retention policy (delete only what is
 *    older than the window, and only ever from `decision_evaluations`);
 *  - run master data is untouched (the store's SQL names one table — see
 *    `DecisionAuditStore.pruneOlderThan`);
 *  - the cleanup leaves a record: every executed sweep emits ONE structured
 *    warning with the policy values, the cutoff and what was removed, and the
 *    same shape is returned to the caller (the internal worker route echoes it).
 *
 * Safety:
 *  - `PI_DECISION_AUDIT_RETENTION_DAYS=0` (default) means the sweeper returns
 *    without touching the store at all: no query, no delete, one boolean check.
 *  - The sweeper never throws. A database error becomes a single bounded
 *    warning, so the worker's maintenance loop (its caller) can never be
 *    disturbed by retention.
 *  - Sweeps are throttled so a caller ticking more often than the policy wants
 *    cannot turn into a query storm; the throttle timestamp is set BEFORE the
 *    store call, so a failing sweep cannot tight-loop.
 *
 * Durable-audit gap (reported, not papered over): this repo has no generic
 * operations audit table. `user_audit` is account-scoped (actor/target user),
 * `agile_release_audit` is release-scoped, and `PI_DEPLOY_LOG` is a read-only
 * file owned by the deploy scripts. So the record carried here is the
 * structured log line plus the returned result — a durable trail would need a
 * new table/column, which is out of scope for this change.
 */

import {
  decisionAuditRetentionPolicy,
  type DecisionAuditRetentionPolicy,
} from "../../shared/decision-retention.js";
import type { DecisionAuditPruneResult, DecisionAuditPruneStore } from "./audit-store.js";
import { truncateChars } from "./redaction.js";

/**
 * Minimum spacing between sweeps. Deliberately shorter than the worker's hourly
 * trigger (see `src/worker/audit-retention.ts`): the throttled side is the one
 * that owns the database, and a slightly smaller interval makes the effective
 * cadence roughly hourly instead of drifting to every other hour.
 */
export const DECISION_AUDIT_RETENTION_MIN_INTERVAL_MS = 30 * 60_000;

const MS_PER_DAY = 86_400_000;

/** One executed sweep, as logged and as returned to the internal caller. */
export interface DecisionAuditRetentionSweep {
  retentionDays: number;
  maxRows: number;
  cutoff: string;
  deleted: number;
  /** Effective per-sweep cap after clamping; `0` = not row-limited. */
  limit: number;
  oldestDeletedAt?: string;
  newestDeletedAt?: string;
}

export type DecisionAuditRetentionWarn = (message: string, details: Record<string, unknown>) => void;

export interface DecisionAuditRetentionSweeperOptions {
  /** The audit store, probed structurally for `pruneOlderThan`. */
  store: DecisionAuditPruneStore;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Throttle window; defaults to {@link DECISION_AUDIT_RETENTION_MIN_INTERVAL_MS}. */
  intervalMs?: number;
  /** Structured log sink; defaults to `console.warn`. */
  warn?: DecisionAuditRetentionWarn;
}

/**
 * The cutoff used for "older than N days": `now - retentionDays * 24h` as an
 * ISO-8601 UTC string, comparable lexicographically with the stored
 * `created_at` text (see `pruneOlderThan` for the full justification).
 */
export function decisionAuditRetentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY).toISOString();
}

function defaultWarn(message: string, details: Record<string, unknown>): void {
  console.warn(`${message} ${JSON.stringify(details)}`);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return truncateChars(message, 300);
}

/**
 * Builds the sweep function. It resolves `undefined` when nothing was done
 * (retention disabled, or the throttle window has not elapsed) or when the
 * sweep failed, and the sweep record otherwise. It never rejects.
 */
export function createDecisionAuditRetentionSweeper(
  options: DecisionAuditRetentionSweeperOptions,
): (input?: { force?: boolean }) => Promise<DecisionAuditRetentionSweep | undefined> {
  const policy: DecisionAuditRetentionPolicy = decisionAuditRetentionPolicy(options.env ?? process.env);
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? DECISION_AUDIT_RETENTION_MIN_INTERVAL_MS;
  const warn = options.warn ?? defaultWarn;
  let lastSweepMs = 0;

  return async function sweep(input?: { force?: boolean }): Promise<DecisionAuditRetentionSweep | undefined> {
    // Default-off: zero queries, zero deletes, no log line.
    if (policy.retentionDays <= 0) return undefined;
    const at = now();
    if (!input?.force && at.getTime() - lastSweepMs < intervalMs) return undefined;
    // Set before the call: a failing sweep must not be retried on every tick.
    lastSweepMs = at.getTime();

    const cutoff = decisionAuditRetentionCutoff(at, policy.retentionDays);
    try {
      const result: DecisionAuditPruneResult = await options.store.pruneOlderThan(cutoff, policy.maxRows);
      const sweep: DecisionAuditRetentionSweep = {
        retentionDays: policy.retentionDays,
        maxRows: policy.maxRows,
        cutoff: result.cutoff,
        deleted: result.deleted,
        limit: result.limit,
        ...(result.oldestDeletedAt !== undefined ? { oldestDeletedAt: result.oldestDeletedAt } : {}),
        ...(result.newestDeletedAt !== undefined ? { newestDeletedAt: result.newestDeletedAt } : {}),
      };
      // AT-JEV-056: the cleanup record. Policy values and counts only — no
      // environment dump and no credential can ever reach this line.
      warn("[decisions] audit retention sweep", { ...sweep });
      return sweep;
    } catch (error) {
      warn("[decisions] audit retention sweep failed", {
        retentionDays: policy.retentionDays,
        maxRows: policy.maxRows,
        cutoff,
        error: errorText(error),
      });
      return undefined;
    }
  };
}
