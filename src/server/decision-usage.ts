/**
 * Decision-plane usage aggregation (docs/27 §AT-JEV-061/062).
 *
 * The decision plane (docs/26) persists one `decision_evaluations` row per
 * evaluation, including its provider-reported token usage. Those calls are real
 * model calls, but they are deliberately NOT folded into the worker's run
 * document: the worker writes `usage`/`usageRoles` under its own revision and a
 * web-side write-back would race it (revision conflicts). So, exactly like
 * `decision-brief.ts`, the totals are aggregated AT READ TIME from the durable
 * rows — no new persistence, no model call, no migration.
 *
 * Two acceptance points are served here:
 *   - AT-JEV-061: the usage is reported under its own `role: "decision"` entry,
 *     so developer/reviewer token totals are untouched and a budget page can
 *     aggregate the decision role on its own.
 *   - AT-JEV-062: the decision plane has no price table yet, so `estimatedCost`
 *     stays 0 while `unpricedCalls === calls`; a reader must render "unknown"
 *     instead of `$0.00`.
 */

import type { Run, RunRoleUsage } from "../shared/types.js";
import type { Queryable } from "./db.js";

/** Role discriminator for every decision-plane call (AT-JEV-061). */
export const DECISION_USAGE_ROLE = "decision";
/** The decision plane's provider as persisted in `decision_evaluations.provider`. */
export const DECISION_USAGE_PROVIDER = "typesafe";

/** Tokens may arrive as a numeric string from a differently-configured driver. */
function intOrZero(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/** Model id that a row is grouped under: `resolved_model`, falling back to `requested_model`. */
function modelOf(row: Record<string, unknown>): string | undefined {
  const resolved = typeof row.resolved_model === "string" ? row.resolved_model.trim() : "";
  if (resolved) return resolved;
  const requested = typeof row.requested_model === "string" ? row.requested_model.trim() : "";
  return requested || undefined;
}

/**
 * Groups completed `decision_evaluations` rows by model and sums their usage.
 *
 * Every group is unpriced (`estimatedCost: 0`, `unpricedCalls === calls`): the
 * decision plane has no price table yet, so a cost would be an invented `$0.00`
 * (AT-JEV-062). Rows without a usable model name are skipped rather than
 * crashing the run-detail route.
 */
export function summarizeDecisionUsage(rows: Array<Record<string, unknown>>): RunRoleUsage[] {
  const groups = new Map<string, RunRoleUsage>();
  for (const row of rows) {
    const model = modelOf(row);
    if (!model) continue;
    const current = groups.get(model);
    const inputTokens = intOrZero(row.input_tokens);
    const outputTokens = intOrZero(row.output_tokens);
    if (current) {
      current.inputTokens += inputTokens;
      current.outputTokens += outputTokens;
      current.calls += 1;
      current.unpricedCalls = (current.unpricedCalls ?? 0) + 1;
    } else {
      groups.set(model, {
        role: DECISION_USAGE_ROLE,
        provider: DECISION_USAGE_PROVIDER,
        model,
        inputTokens,
        outputTokens,
        estimatedCost: 0,
        calls: 1,
        unpricedCalls: 1,
      });
    }
  }
  return [...groups.values()];
}

/**
 * Returns a NEW run whose `usageRoles` carry the decision entries merged in by
 * `role + model` (tokens / calls / unpricedCalls add up across a merge).
 *
 * Only `usageRoles` is touched: `usage.estimatedCost`, `usage.inputTokens` and
 * `usageUnknownCalls` are intentionally left alone, because decision usage is
 * its own bucket and must never be counted as developer/reviewer spend or as
 * an "unknown usage" model call. The input run is never mutated.
 */
export function mergeDecisionUsage(run: Run, entries: RunRoleUsage[]): Run {
  if (entries.length === 0) return run;
  const roles: RunRoleUsage[] = (run.usageRoles ?? []).map((item) => ({ ...item }));
  for (const entry of entries) {
    const index = roles.findIndex((item) => item.role === entry.role && item.model === entry.model);
    if (index === -1) {
      roles.push({ ...entry });
      continue;
    }
    const current = roles[index];
    roles[index] = {
      ...current,
      inputTokens: current.inputTokens + entry.inputTokens,
      outputTokens: current.outputTokens + entry.outputTokens,
      estimatedCost: current.estimatedCost + entry.estimatedCost,
      calls: current.calls + entry.calls,
      unpricedCalls: (current.unpricedCalls ?? 0) + (entry.unpricedCalls ?? 0),
    };
  }
  return { ...run, usageRoles: roles };
}

/**
 * Reads this run's completed decision rows from the durable audit table. Only
 * `status = 'completed'` rows count: a fallback/rejected/disabled evaluation
 * never produced a real provider answer, so counting it would fabricate usage.
 */
export async function collectDecisionUsageRows(db: Queryable, run: Run): Promise<Array<Record<string, unknown>>> {
  const result = await db.query(
    `SELECT resolved_model, requested_model, input_tokens, output_tokens
       FROM decision_evaluations
      WHERE run_id = $1 AND status = 'completed'
      ORDER BY created_at ASC, id ASC`,
    [run.id],
  );
  return result.rows;
}

/**
 * Owner-scoped aggregation entry point used by the run-detail route. Idempotent
 * by construction: it reads the durable rows and returns a fresh run object, so
 * calling it twice for the same run yields the same totals (nothing is written).
 */
export async function readDecisionUsage(db: Queryable, run: Run): Promise<Run> {
  return mergeDecisionUsage(run, summarizeDecisionUsage(await collectDecisionUsageRows(db, run)));
}

/**
 * Fail-safe wrapper for the read path: a missing table, a closed pool or any
 * other storage error degrades to the untouched run (never a 500), and the
 * failure is reported through `onError` for a warn log. The error object itself
 * is passed through unchanged so the caller controls what gets logged.
 */
export async function readDecisionUsageSafe(
  db: Queryable,
  run: Run,
  onError?: (error: unknown) => void,
): Promise<Run> {
  try {
    return await readDecisionUsage(db, run);
  } catch (error) {
    onError?.(error);
    return run;
  }
}
