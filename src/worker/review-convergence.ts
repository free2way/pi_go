import type { Finding } from "../shared/types.js";
import { findingFingerprint } from "../shared/finding-fingerprint.js";

/**
 * Convergence guard (production incidents `run_e2eabf51532448b3`,
 * `run_e7c565d6335a4bc7`).
 *
 * Two distinct failure modes keep a review loop alive without making progress:
 *
 * 1. The reviewer keeps raising NEW severe findings instead of shrinking the
 *    blocking set (`run_e2eabf51532448b3`: 31 findings, 0 ever resolved). The
 *    worker treats two consecutive rounds whose *new* severe count did not
 *    decrease as "not converging".
 * 2. The SAME batch of blocking findings keeps being re-reported — even when the
 *    reviewer renames the id or rewords the title every round
 *    (`run_e7c565d6335a4bc7`: the same `解除阻塞后没有恢复之前状态` defect was
 *    recorded under six different ids, so the NEW-count rule saw a fresh problem
 *    each round and never fired). Under the stable fingerprint this is one
 *    finding, so the worker additionally treats `PI_REVIEW_STALL_ROUNDS`
 *    consecutive review rounds whose unresolved blocking count did not decrease
 *    as "not converging".
 *
 * The counts are derived from the merged findings themselves (`firstSeenRound`
 * /`lastSeenRound` are assigned by `mergeFindings` from the shared stable key),
 * so nothing extra has to be persisted and a resumed run reconstructs its
 * history from the run document.
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
  /**
   * Unresolved critical/high findings the reviewer reported in THIS round (the
   * current blocking batch, keyed by the stable fingerprint), regardless of
   * whether they were first seen now or re-reported from an earlier round.
   */
  unresolvedBlocking: number;
  /** Stable keys (fingerprints) behind `unresolvedBlocking`. */
  blockingKeys: string[];
}

/** Severities whose occurrence the guard watches. */
export const convergenceSeverities: ReadonlyArray<Finding["severity"]> = ["critical", "high"];

/** Consecutive non-decreasing rounds required before the NEW-count rule stalls. */
export const requiredStalledRounds = 2;

/** Default consecutive non-decreasing review rounds for the unresolved-blocking rule. */
export const defaultReviewStallRounds = 2;

/**
 * Strict parser for `PI_REVIEW_STALL_ROUNDS`: only a plain decimal integer >= 2
 * is accepted; anything else (unset, empty, junk, < 2) falls back to the default
 * of 2. `PI_REVIEW_CONVERGENCE_GUARD=off` still disables the whole guard.
 *
 * The default is 2 (not 3): the default `maxRounds` is 3, so a rule that needed
 * three *counted* review rounds could never fire before the max-rounds
 * escalation when the persisting blocker first appeared in round 2 (the live
 * `run_747fa0f5baa141d9` shape: `streak=2` at the round cap).
 */
export function reviewStallRounds(value: string | undefined = process.env.PI_REVIEW_STALL_ROUNDS): number {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return defaultReviewStallRounds;
  const parsed = Number(raw);
  return parsed >= 2 ? parsed : defaultReviewStallRounds;
}

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

/** Stable cross-round key of a finding (persisted fingerprint, else computed). */
export function findingStableKey(finding: Finding): string {
  return finding.fingerprint ?? findingFingerprint(finding);
}

/**
 * Best-effort reconstruction of "was this finding reported in `round`?" from the
 * merged record. The run document only stores the first report, the last report
 * and the length of the current consecutive streak, so the streak window
 * `[lastSeenRound - consecutiveRounds + 1, lastSeenRound]` plus the anchor rounds
 * (first/last report) is what we can recover. A streak broken in the middle is
 * therefore only partially reconstructible — acceptable because the guard only
 * judges the *trailing* run, which the current streak covers exactly.
 */
export function reportedInRound(finding: Finding, round: number): boolean {
  const first = roundOf(finding.firstSeenRound, 1);
  const last = roundOf(finding.lastSeenRound, 1);
  if (round === first || round === last) return true;
  const consecutive = Math.max(0, Math.floor(finding.consecutiveRounds ?? 0));
  if (consecutive <= 0) return false;
  const start = last - consecutive + 1;
  return round >= start && round <= last;
}

/**
 * Per-round convergence counts, derived from the merged findings.
 *
 * A round is kept when it raised a finding, re-reported one (`lastSeenRound`)
 * or is the current round (always present, even at zero, so the caller can
 * inspect it). Rounds interrupted before review — e.g. a failed check round —
 * are skipped instead of being mis-counted as a "0 new findings" improvement,
 * and the comparisons stay between successive *review* rounds. A finding from an
 * older run without `firstSeenRound` is attributed to round 1.
 */
export function convergenceHistory(
  findings: ReadonlyArray<Finding>,
  currentRound: number,
): RoundConvergence[] {
  const rounds = Math.max(0, Math.floor(currentRound));
  const history: RoundConvergence[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const firstSeen = findings.filter((finding) => roundOf(finding.firstSeenRound, 1) === round);
    const reportedThisRound = findings.filter(
      (finding) =>
        finding.resolved !== true &&
        convergenceSeverities.includes(finding.severity) &&
        reportedInRound(finding, round),
    );
    const reviewedThisRound =
      firstSeen.length > 0 ||
      findings.some(
        (finding) => roundOf(finding.lastSeenRound, 1) === round || reportedInRound(finding, round),
      );
    if (!reviewedThisRound && round !== rounds) continue;
    history.push({
      round,
      newBlocking: firstSeen.filter((finding) => convergenceSeverities.includes(finding.severity)).length,
      newTotal: firstSeen.length,
      resolvedThisRound: findings.filter(
        (finding) => finding.resolved === true && roundOf(finding.lastSeenRound, 1) === round,
      ).length,
      unresolvedBlocking: reportedThisRound.length,
      blockingKeys: reportedThisRound.map(findingStableKey),
    });
  }
  return history;
}

export interface ConvergenceVerdict {
  /** True when the loop is not converging and a repair round must not start. */
  stalled: boolean;
  /** Trailing comparisons whose NEW severe count did not decrease (rule 1). */
  stalledRounds: number;
  /** Trailing review rounds whose unresolved blocking count did not decrease (rule 2). */
  unresolvedStalledRounds: number;
  /** Which rule produced `stalled` (undefined when not stalled). */
  stallRule?: "new-blocking" | "unresolved-blocking";
  previousBlocking?: number;
  currentBlocking?: number;
  /** Unresolved blocking findings reported in the current round. */
  currentUnresolvedBlocking: number;
  /** Stable keys persisting across the stalled trailing rounds (rule 2). */
  persistingBlockingKeys: string[];
  /** Human-facing summary; empty when `stalled` is false. */
  message: string;
  perRound: RoundConvergence[];
}

/** Intersection of the blocking keys across the trailing rounds, sorted. */
function persistingKeys(rounds: ReadonlyArray<RoundConvergence>): string[] {
  if (rounds.length === 0) return [];
  let keys = new Set(rounds[0].blockingKeys);
  for (const round of rounds.slice(1)) {
    const next = new Set(round.blockingKeys);
    keys = new Set([...keys].filter((key) => next.has(key)));
  }
  return [...keys].sort();
}

/**
 * Two rules, evaluated on the (round-ascending) history:
 *
 * 1. "New severe findings did not decrease for two consecutive rounds" — a
 *    comparison `curr >= prev` counts as a stalled round; any decrease resets
 *    the count. Only fires when the current round actually raised severe
 *    findings (a round with zero new severe findings is progress, never a stall).
 * 2. "The unresolved blocking batch did not decrease for `requiredUnresolvedRounds`
 *    consecutive review rounds" — the trailing run of rounds whose
 *    `unresolvedBlocking` did not decrease, counted in rounds. This is what
 *    catches a reworded/re-id'd repeat of the same blocking defect.
 */
export function convergenceVerdict(
  history: ReadonlyArray<RoundConvergence>,
  options: { requiredStalledRounds?: number; requiredUnresolvedRounds?: number } = {},
): ConvergenceVerdict {
  const required = Math.max(2, Math.floor(options.requiredStalledRounds ?? requiredStalledRounds));
  const requiredUnresolved = Math.max(
    2,
    Math.floor(options.requiredUnresolvedRounds ?? defaultReviewStallRounds),
  );
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
  const newCountStalled = stalledRounds >= required;

  let unresolvedStalledRounds = 0;
  if (current && current.unresolvedBlocking > 0) {
    unresolvedStalledRounds = 1;
    for (let index = perRound.length - 1; index >= 1; index -= 1) {
      if (perRound[index].unresolvedBlocking >= perRound[index - 1].unresolvedBlocking) unresolvedStalledRounds += 1;
      else break;
    }
  }
  const unresolvedStalled = unresolvedStalledRounds >= requiredUnresolved;

  const stalled = newCountStalled || unresolvedStalled;
  const stallRule = newCountStalled ? "new-blocking" : unresolvedStalled ? "unresolved-blocking" : undefined;
  const trailing = perRound.slice(Math.max(0, perRound.length - unresolvedStalledRounds));
  const persisting = unresolvedStalled ? persistingKeys(trailing) : [];

  let message = "";
  if (newCountStalled && current && previous) {
    const roundsLabel = stalledRounds === 2 ? "连续两轮" : `连续 ${stalledRounds} 轮`;
    message = `审核未收敛：${roundsLabel}新增严重问题未下降（${previous.newBlocking}→${current.newBlocking}），建议缩小范围或拆分任务`;
  } else if (unresolvedStalled && current) {
    const keys = persisting.slice(0, 3).join("，");
    message = `审核未收敛：同一批阻断问题连续 ${unresolvedStalledRounds} 轮未减少（当前 ${current.unresolvedBlocking} 个未解决阻断问题${keys ? `：${keys}` : ""}），建议缩小范围或拆分任务`;
  }

  return {
    stalled,
    stalledRounds,
    unresolvedStalledRounds,
    ...(stallRule ? { stallRule } : {}),
    ...(previous ? { previousBlocking: previous.newBlocking } : {}),
    ...(current ? { currentBlocking: current.newBlocking } : {}),
    currentUnresolvedBlocking: current?.unresolvedBlocking ?? 0,
    persistingBlockingKeys: persisting,
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
  requiredUnresolvedRounds?: number;
}): { stop: false } | { stop: true; message: string; meta: Record<string, unknown> } {
  if (input.enabled === false) return { stop: false };
  const verdict = convergenceVerdict(convergenceHistory(input.findings, input.currentRound), {
    ...(input.requiredStalledRounds === undefined ? {} : { requiredStalledRounds: input.requiredStalledRounds }),
    ...(input.requiredUnresolvedRounds === undefined ? {} : { requiredUnresolvedRounds: input.requiredUnresolvedRounds }),
  });
  if (!verdict.stalled) return { stop: false };
  return {
    stop: true,
    message: verdict.message,
    meta: {
      stalledRounds: verdict.stalledRounds,
      unresolvedStalledRounds: verdict.unresolvedStalledRounds,
      stallRule: verdict.stallRule ?? null,
      persistingBlockingKeys: verdict.persistingBlockingKeys,
      currentUnresolvedBlocking: verdict.currentUnresolvedBlocking,
      previousBlocking: verdict.previousBlocking ?? null,
      currentBlocking: verdict.currentBlocking ?? null,
      perRound: verdict.perRound,
    },
  };
}
