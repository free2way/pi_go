/**
 * AT-JEV-056 (docs/27 §7.6): retention knobs for the decision-plane audit table
 * (`decision_evaluations`, migration 15).
 *
 * Why the parsing lives in `src/shared`: two processes must agree on the same
 * answer without drift. The worker decides whether a sweep should be triggered
 * at all (it has no database connection), and the web — the only process with a
 * database connection — owns the policy and performs the delete. Both read the
 * exact same `PI_DECISION_AUDIT_RETENTION_*` names, so a shared parser is the
 * only way to guarantee "off on one side" means "off on both".
 *
 * Safe by default: `PI_DECISION_AUDIT_RETENTION_DAYS=0` (the default, and what
 * an unset / blank / mistyped value also resolves to) means "never delete". A
 * retention window is a product/compliance decision, so an upgrade must never
 * silently start dropping audit rows; deleting requires an explicit positive
 * integer.
 */

/** Days a `decision_evaluations` row is kept; `0` = keep forever (default). */
export const DECISION_AUDIT_RETENTION_DAYS_ENV = "PI_DECISION_AUDIT_RETENTION_DAYS";
/** Optional per-sweep delete cap; `0` = no operator limit (default). */
export const DECISION_AUDIT_RETENTION_MAX_ROWS_ENV = "PI_DECISION_AUDIT_RETENTION_MAX_ROWS";

export const DEFAULT_DECISION_AUDIT_RETENTION_DAYS = 0;
export const DEFAULT_DECISION_AUDIT_RETENTION_MAX_ROWS = 0;

/**
 * Hard ceiling on the effective per-sweep delete cap. A mistyped/absurd
 * `PI_DECISION_AUDIT_RETENTION_MAX_ROWS` cannot turn one sweep into an
 * unbounded in-memory id list, and PostgreSQL's 65535-parameter ceiling on the
 * `id IN (…)` delete can never be reached. The effective (clamped) value is
 * always reported in the sweep result / log, so it is observable, not silent.
 */
export const DECISION_AUDIT_RETENTION_MAX_ROWS_CEILING = 10_000;

export interface DecisionAuditRetentionPolicy {
  /** Days of history to keep; `0` disables deletion entirely. */
  retentionDays: number;
  /** Operator per-sweep delete cap; `0` = no operator limit. */
  maxRows: number;
}

/**
 * Strict non-negative integer parse of an env value. Anything that is not a
 * plain `digits` string (empty, `"7d"`, `"-1"`, `"0.5"`, `"yes"`) falls back to
 * the safe default instead of throwing: this knob is read by a maintenance loop
 * where a throw would be worse than a conservative fallback. Trimming matches
 * the other strict `PI_*` parsers in the repo.
 */
function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseDecisionAuditRetentionDays(value: unknown): number {
  return parseNonNegativeInt(value, DEFAULT_DECISION_AUDIT_RETENTION_DAYS);
}

export function parseDecisionAuditRetentionMaxRows(value: unknown): number {
  return parseNonNegativeInt(value, DEFAULT_DECISION_AUDIT_RETENTION_MAX_ROWS);
}

/** Resolves both knobs from an environment bag (defaults `process.env`). */
export function decisionAuditRetentionPolicy(
  env: Record<string, string | undefined> = process.env,
): DecisionAuditRetentionPolicy {
  return {
    retentionDays: parseDecisionAuditRetentionDays(env[DECISION_AUDIT_RETENTION_DAYS_ENV]),
    maxRows: parseDecisionAuditRetentionMaxRows(env[DECISION_AUDIT_RETENTION_MAX_ROWS_ENV]),
  };
}

/**
 * The single on/off switch: true only for an explicit positive day count. When
 * false the sweeper performs no query and no delete, and the worker sends no
 * request at all.
 */
export function decisionAuditRetentionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return decisionAuditRetentionPolicy(env).retentionDays > 0;
}
