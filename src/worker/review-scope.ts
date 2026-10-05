import type { Finding, ReviewScope, Run } from "../shared/types.js";
import { blockingSeverities } from "./review-protocol.js";

/**
 * Per-run review scope (see `ReviewScope` in `src/shared/types.ts`).
 *
 * The default scope (`"all"`) keeps every medium/high/critical finding blocking,
 * exactly as before this option existed. `"blocking"` narrows the blocking set
 * to critical/high so medium/low findings are recorded but do not block the
 * verdict or completion — the documented remedy for a large-scope task that
 * loops to the round cap because the reviewer keeps raising advisory findings.
 */

/** Severities that always block, regardless of scope. */
export const severeSeverities: ReadonlyArray<Finding["severity"]> = ["critical", "high"];

/** Defensive resolution for runs written before `reviewScope` existed. */
export function resolveReviewScope(run: Pick<Run, "reviewScope"> | undefined): ReviewScope {
  return run?.reviewScope === "blocking" ? "blocking" : "all";
}

/** Severities that block under a scope: everything (all) vs critical/high (blocking). */
export function blockingSeveritiesForScope(scope: ReviewScope): ReadonlyArray<Finding["severity"]> {
  return scope === "blocking" ? severeSeverities : blockingSeverities;
}

/** Unresolved findings that block the review verdict / completion under a scope. */
export function blockingFindings(findings: ReadonlyArray<Finding>, scope: ReviewScope): Finding[] {
  const severities = blockingSeveritiesForScope(scope);
  return findings.filter((finding) => !finding.resolved && severities.includes(finding.severity));
}

/**
 * Unresolved non-blocking (medium/low) findings under a `"blocking"` scope. They
 * stay on the run and in the acceptance snapshot's "remaining" list; the worker
 * emits `review.nonblocking_deferred` so they remain visible.
 */
export function deferredFindings(findings: ReadonlyArray<Finding>, scope: ReviewScope): Finding[] {
  if (scope !== "blocking") return [];
  return findings.filter((finding) => !finding.resolved && !severeSeverities.includes(finding.severity));
}

/**
 * Whether a review round may be accepted instead of starting another repair
 * round.
 *
 * - `approved` is always acceptable (the completion guard still vets it).
 * - `changes_requested` under scope `"blocking"` with no open critical/high
 *   finding becomes an approval-with-notes: the round is accepted and the
 *   medium/low findings are deferred. Critical/high findings still force repair.
 * - scope `"all"` never converts a `changes_requested` verdict.
 */
export function shouldAcceptRound(input: {
  verdict: "approved" | "changes_requested";
  scope: ReviewScope;
  blocking: ReadonlyArray<Finding>;
}): boolean {
  if (input.verdict === "approved") return true;
  return input.scope === "blocking" && input.blocking.length === 0;
}

/** True when a round accepted under `"blocking"` should surface deferred findings. */
export function isDeferral(scope: ReviewScope, deferred: ReadonlyArray<Finding>): boolean {
  return scope === "blocking" && deferred.length > 0;
}

/** Chinese summary for the `review.nonblocking_deferred` event. */
export function deferredMessage(round: number, deferred: ReadonlyArray<Finding>): string {
  return `按「只修阻断项」范围受理第 ${round} 轮：${deferred.length} 个非阻断问题（medium/low）已记录但不阻断完成`;
}
