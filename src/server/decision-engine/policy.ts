/**
 * Decision policy: mode gating and the immutable safety rules (docs/26 §5/§9.4).
 *
 * Pure and dependency-free so the same functions serve the engine wrapper, the
 * review-triage caller and the tests. Three invariants are encoded here:
 *
 *  - `off` never calls out; `shadow` never applies anything (`none`);
 *  - `enforce` is per-kind and defaults to none, so today it behaves as `assist`;
 *  - nothing this module returns can authorize execution, and no path ever turns
 *    a failing deterministic state into a pass or downgrades a `critical`/`high`
 *    finding. Low certainty / flat distributions are reported as `uncertain`
 *    with no applied outcome.
 */

import { createHash } from "node:crypto";
import type { Finding } from "../../shared/types.js";
import { noulCertainty, type DecisionAnswer, type DecisionKind, type DecisionMode, type DecisionStatus, type FallbackReason } from "./types.js";

export const POLICY_VERSION_DEFAULT = "review-triage-v1";
/** Applied outcome recorded when the policy applies nothing. */
export const APPLIED_NONE = "none";
/** Applied outcome recorded when the decision is suggestion-only. */
export const APPLIED_ASSIST = "assist_suggestion";

export interface DecisionPolicy {
  version: string;
  /** Kinds allowed to apply an outcome under `enforce`. Empty by default. */
  enforceKinds: ReadonlyArray<DecisionKind>;
  /** Probability answers below this derived certainty (0..1) are `uncertain`. */
  minCertainty: number;
  /** Choice/score answers below this confidence (0..1) are `uncertain`. */
  minConfidence: number;
  /** Choice/score distributions flatter than this (max − min) are `uncertain`. */
  minDistributionSpread: number;
  /** Severities that are never downgraded by a decision outcome. */
  protectedSeverities: ReadonlyArray<Finding["severity"]>;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  version: POLICY_VERSION_DEFAULT,
  enforceKinds: [],
  minCertainty: 0.2,
  minConfidence: 0.6,
  minDistributionSpread: 0.1,
  protectedSeverities: ["critical", "high"],
};

export function createDecisionPolicy(overrides: Partial<DecisionPolicy> = {}): DecisionPolicy {
  return { ...DEFAULT_DECISION_POLICY, ...overrides };
}

const MODE_RANK: Record<DecisionMode, number> = { off: 0, shadow: 1, assist: 2, enforce: 3 };

/** The more conservative of two modes; a request can never escalate on its own. */
export function lowerMode(a: DecisionMode, b: DecisionMode): DecisionMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/**
 * The mode that actually governs the call: the conservative minimum of the
 * configured and requested modes, with `enforce` demoted to `assist` unless the
 * policy explicitly allowlists the kind.
 */
export function effectiveMode(input: {
  requestedMode: DecisionMode;
  configuredMode?: DecisionMode;
  kind: DecisionKind;
  policy?: DecisionPolicy;
}): DecisionMode {
  const policy = input.policy ?? DEFAULT_DECISION_POLICY;
  const mode = lowerMode(input.requestedMode, input.configuredMode ?? input.requestedMode);
  if (mode === "enforce" && !policy.enforceKinds.includes(input.kind)) return "assist";
  return mode;
}

export type DecisionPlan =
  | { action: "skip"; mode: DecisionMode; reason: FallbackReason; detail: string }
  | { action: "call"; mode: DecisionMode };

/** Whether the decision plane may call the provider at all. */
export function planDecision(input: {
  requestedMode: DecisionMode;
  configuredMode?: DecisionMode;
  kind: DecisionKind;
  policy?: DecisionPolicy;
}): DecisionPlan {
  const mode = effectiveMode(input);
  if (mode === "off") {
    return { action: "skip", mode, reason: "disabled", detail: "decision mode is off" };
  }
  return { action: "call", mode };
}

function distributionSpread(probabilities: Record<string, number> | undefined): number | undefined {
  if (!probabilities) return undefined;
  const values = Object.values(probabilities);
  if (values.length === 0) return undefined;
  if (!values.every((value) => Number.isFinite(value))) return undefined;
  return Math.max(...values) - Math.min(...values);
}

/**
 * A single answer is `uncertain` when it is missing required evidence, its
 * probability is too close to 0.5, or its confidence/distribution is too flat.
 */
export function isUncertain(answer: DecisionAnswer, policy: DecisionPolicy = DEFAULT_DECISION_POLICY): boolean {
  switch (answer.type) {
    case "probability": {
      if (typeof answer.probability !== "number" || !Number.isFinite(answer.probability)) return true;
      const certainty = typeof answer.certainty === "number" ? answer.certainty : noulCertainty(answer.probability);
      return certainty < policy.minCertainty;
    }
    case "choice":
    case "score": {
      if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) return true;
      if (answer.confidence < policy.minConfidence) return true;
      const spread = distributionSpread(answer.probabilities);
      if (spread === undefined) return true;
      return spread < policy.minDistributionSpread;
    }
    default:
      return true;
  }
}

/** Ids of every `uncertain` answer. */
export function uncertainAnswerIds(answers: DecisionAnswer[], policy: DecisionPolicy = DEFAULT_DECISION_POLICY): string[] {
  return answers.filter((answer) => isUncertain(answer, policy)).map((answer) => answer.questionId);
}

/**
 * Deterministic shadow sampling: `rate >= 1` keeps everything, `rate <= 0`
 * drops everything, and anything in between is a stable function of the
 * evaluation id (so a replay of the same run samples identically).
 */
export function shouldSampleShadow(evaluationId: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate >= 1) return true;
  if (rate <= 0) return false;
  const digest = createHash("sha256").update(String(evaluationId), "utf8").digest("hex");
  const fraction = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  return fraction < rate;
}

/** One finding the decision plane judged; used to protect high severities. */
export interface TriageSubject {
  key: string;
  severity: Finding["severity"];
  /** Answer ids that belong to this subject. */
  answerIds: string[];
}

export interface OutcomeInput {
  /** Effective mode (already resolved by {@link effectiveMode}). */
  mode: DecisionMode;
  kind: DecisionKind;
  status: DecisionStatus;
  answers: DecisionAnswer[];
  policy?: DecisionPolicy;
  /** A deterministic gate (checks/review/security) has already failed. */
  deterministicFailed?: boolean;
  /** Findings the provider judged, with their severities. */
  subjects?: TriageSubject[];
  /** Answer ids whose selected value would reduce risk/urgency. */
  downgradeAnswerIds?: string[];
  /**
   * Outcome to apply when `enforce` is allowlisted for this kind and everything
   * is clean. Ignored in every other mode.
   */
  enforceOutcome?: string;
}

export interface OutcomeResult {
  /** What the pipeline may record as applied; `undefined` when nothing applies. */
  appliedOutcome?: string;
  uncertain: string[];
  /** Immutable-rule violations observed (no outcome is applied when non-empty). */
  violations: string[];
}

export const OUTCOME_VIOLATIONS = {
  deterministicFailed: "deterministic_gate_failed",
  protectedDowngrade: "protected_finding_downgrade",
} as const;

/**
 * Resolves the *only* outcome the pipeline may apply. Returns no outcome unless
 * the engine ran, the mode permits it, no deterministic gate failed, no
 * protected finding was downgraded, and no answer is `uncertain`.
 */
export function resolveAppliedOutcome(input: OutcomeInput): OutcomeResult {
  const policy = input.policy ?? DEFAULT_DECISION_POLICY;
  const uncertain = uncertainAnswerIds(input.answers, policy);
  const violations: string[] = [];

  if (input.deterministicFailed) violations.push(OUTCOME_VIOLATIONS.deterministicFailed);

  const downgrades = new Set(input.downgradeAnswerIds ?? []);
  const protectedSeverities = new Set(policy.protectedSeverities);
  for (const subject of input.subjects ?? []) {
    if (!protectedSeverities.has(subject.severity)) continue;
    if (subject.answerIds.some((id) => downgrades.has(id))) {
      violations.push(OUTCOME_VIOLATIONS.protectedDowngrade);
      break;
    }
  }

  if (input.status !== "completed") return { uncertain, violations };
  if (input.mode === "off") return { uncertain, violations };

  // Shadow records advice but must never apply it (docs/26 §9.4 rule 5).
  if (input.mode === "shadow") return { appliedOutcome: APPLIED_NONE, uncertain, violations };

  if (violations.length > 0 || uncertain.length > 0) return { appliedOutcome: APPLIED_NONE, uncertain, violations };

  if (input.mode === "enforce" && policy.enforceKinds.includes(input.kind) && input.enforceOutcome) {
    return { appliedOutcome: input.enforceOutcome, uncertain, violations };
  }
  // assist — and enforce for kinds that are not allowlisted (docs/26 §5).
  return { appliedOutcome: APPLIED_ASSIST, uncertain, violations };
}
