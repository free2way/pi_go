import type { Finding } from "../shared/types.js";

/**
 * Convergence guard (production incident `run_e2eabf51532448b3`).
 *
 * A large-scope task ("在工作流程里增加代码发布的步骤") ran to the maximum review
 * round because every round raised NEW critical/high findings instead of
 * shrinking the blocking set: 31 findings total, 0 ever marked resolved. The
 * repeated-severe guard (AT-REVIEW-010) only catches the *same* finding
 * persisting; it never notices that the reviewer keeps finding fresh severe
 * problems, so the loop kept paying for repair rounds until the cap.
 *
 * This module derives, per review round, how many severe (critical/high)
 * findings were newly raised, and treats two consecutive rounds whose severe
 * count did not decrease as "not converging" — the worker then stops before
 * starting another repair round and escalates to `needs_human`.
 *
 * The counts are derived from the merged findings themselves (`firstSeenRound`
 * is assigned by `mergeFindings` from the stable fingerprint), so nothing extra
 * has to be persisted and a resumed run reconstructs its history from the run
 * document. Sparse data is tolerated: with fewer than three rounds there can be
 * no judgement at all.
 */

export interface RoundConvergence {
  round: number;
  /** Critical/high findings first reported in this round. */
  newBlocking: number;
  /** All findings first reported in this round. */
  newTotal: number;
  /**
   * Findings resolved as of this round (best-effort: the round that last
   * reported them). Rounds that end in `changes_requested` resolve nothing, so
   * this is normally 0 while the loop is not converging.
   */
  resolvedThisRound: number;
}

/** Severities whose *new* occurrence the guard watches. */
export const convergenceSeverities: ReadonlyArray<Finding["severity"]> = ["critical", "high"];

/** Consecutive non-decreasing rounds required before the loop is declared stalled. */
export const requiredStalledRounds = 2;

/**
 * `off` disables the guard; anything else (including unset) enables it. The
 * default is on, matching the operator-facing incident guardrail.
 */
export function convergenceGuardEnabled(value: string | undefined = process.env.PI_REVIEW_CONVERGENCE_GUARD): boolean {
  return String(value ?? "").trim().toLowerCase() !== "off";
}

function roundOf(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * Per-round convergence counts, derived from the merged findings.
 *
 * Only rounds that actually raised a finding are kept, plus the current round
 * (always present, even at zero, so the caller can inspect it). Rounds that were
 * interrupted before review — e.g. a failed check round — are therefore skipped
 * instead of being mis-counted as a "0 new findings" improvement, and the
 * comparisons stay between successive *review* rounds. A finding from an older
 * run without `firstSeenRound` is attributed to round 1.
 */
export function convergenceHistory(
  findings: ReadonlyArray<Finding>,
  currentRound: number,
): RoundConvergence[] {
  const rounds = Math.max(0, Math.floor(currentRound));
  const history: RoundConvergence[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const firstSeen = findings.filter((finding) => roundOf(finding.firstSeenRound, 1) === round);
    if (firstSeen.length === 0 && round !== rounds) continue;
    history.push({
      round,
      newBlocking: firstSeen.filter((finding) => convergenceSeverities.includes(finding.severity)).length,
      newTotal: firstSeen.length,
      resolvedThisRound: findings.filter(
        (finding) => finding.resolved === true && roundOf(finding.lastSeenRound, 1) === round,
      ).length,
    });
  }
  return history;
}

export interface ConvergenceVerdict {
  /** True when the loop is not converging and a repair round must not start. */
  stalled: boolean;
  /** Trailing rounds (comparisons) whose severe count did not decrease. */
  stalledRounds: number;
  previousBlocking?: number;
  currentBlocking?: number;
  /** Human-facing summary; empty when `stalled` is false. */
  message: string;
  perRound: RoundConvergence[];
}

/**
 * "New severe findings did not decrease for two consecutive rounds".
 *
 * Walks the trailing comparisons of the (round-ascending) history. A comparison
 * `curr >= prev` counts as a stalled round; any decrease resets the count. The
 * loop is stalled only when at least `requiredStalledRounds` trailing
 * comparisons did not decrease AND the current round actually raised severe
 * findings (a round with zero new severe findings is progress, never a stall).
 * With fewer than `requiredStalledRounds + 1` rounds there is no judgement.
 */
export function convergenceVerdict(
  history: ReadonlyArray<RoundConvergence>,
  options: { requiredStalledRounds?: number } = {},
): ConvergenceVerdict {
  const required = Math.max(2, Math.floor(options.requiredStalledRounds ?? requiredStalledRounds));
  const perRound = [...history].sort((a, b) => a.round - b.round);
  const current = perRound[perRound.length - 1];
  const previous = perRound[perRound.length - 2];

  let stalledRounds = 0;
  if (current && current.newBlocking > 0) {
    for (let index = perRound.length - 1; index >= 1; index -= 1) {
      if (perRound[index].newBlocking >= perRound[index - 1].newBlocking) stalledRounds += 1;
      else break;
    }
  }

  const stalled = stalledRounds >= required;
  const roundsLabel = stalledRounds === 2 ? "连续两轮" : `连续 ${stalledRounds} 轮`;
  const message = stalled && current && previous
    ? `审核未收敛：${roundsLabel}新增严重问题未下降（${previous.newBlocking}→${current.newBlocking}），建议缩小范围或拆分任务`
    : "";

  return {
    stalled,
    stalledRounds,
    ...(previous ? { previousBlocking: previous.newBlocking } : {}),
    ...(current ? { currentBlocking: current.newBlocking } : {}),
    message,
    perRound,
  };
}

/**
 * Convenience wrapper used by the worker: derives the history from the merged
 * findings and returns the terminal event payload when the loop must stop.
 * `enabled: false` (env `PI_REVIEW_CONVERGENCE_GUARD=off`) never stops the loop.
 */
export function convergenceStop(input: {
  findings: ReadonlyArray<Finding>;
  currentRound: number;
  enabled?: boolean;
  requiredStalledRounds?: number;
}): { stop: false } | { stop: true; message: string; meta: Record<string, unknown> } {
  if (input.enabled === false) return { stop: false };
  const verdict = convergenceVerdict(
    convergenceHistory(input.findings, input.currentRound),
    input.requiredStalledRounds === undefined ? {} : { requiredStalledRounds: input.requiredStalledRounds },
  );
  if (!verdict.stalled) return { stop: false };
  return {
    stop: true,
    message: verdict.message,
    meta: {
      stalledRounds: verdict.stalledRounds,
      previousBlocking: verdict.previousBlocking ?? null,
      currentBlocking: verdict.currentBlocking ?? null,
      perRound: verdict.perRound,
    },
  };
}
