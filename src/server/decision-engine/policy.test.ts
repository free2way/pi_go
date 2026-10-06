import { describe, expect, it } from "vitest";
import {
  APPLIED_ASSIST,
  APPLIED_NONE,
  DEFAULT_DECISION_POLICY,
  OUTCOME_VIOLATIONS,
  createDecisionPolicy,
  effectiveMode,
  isUncertain,
  lowerMode,
  planDecision,
  resolveAppliedOutcome,
  uncertainAnswerIds,
} from "./policy.js";
import type { DecisionAnswer, DecisionMode } from "./types.js";

const probability = (id: string, p: number): DecisionAnswer => ({
  questionId: id,
  type: "probability",
  value: p >= 0.5,
  probability: p,
});

const choice = (id: string, value: string, confidence: number, probabilities: Record<string, number>): DecisionAnswer => ({
  questionId: id,
  type: "choice",
  value,
  confidence,
  probabilities,
});

describe("mode gating", () => {
  it("[AT-JEV-002] off skips the external call", () => {
    const plan = planDecision({ requestedMode: "off", kind: "review_triage" });
    expect(plan).toEqual({ action: "skip", mode: "off", reason: "disabled", detail: expect.any(String) });
  });

  it("shadow/assist call", () => {
    expect(planDecision({ requestedMode: "shadow", kind: "review_triage" }).action).toBe("call");
    expect(planDecision({ requestedMode: "assist", kind: "review_triage" }).action).toBe("call");
  });

  it("a request can never escalate above the configured mode", () => {
    expect(effectiveMode({ requestedMode: "enforce", configuredMode: "shadow", kind: "planner_route" })).toBe("shadow");
    expect(effectiveMode({ requestedMode: "assist", configuredMode: "off", kind: "planner_route" })).toBe("off");
    expect(planDecision({ requestedMode: "assist", configuredMode: "off", kind: "planner_route" }).action).toBe("skip");
  });

  it("enforce is demoted to assist unless the kind is allowlisted", () => {
    expect(effectiveMode({ requestedMode: "enforce", configuredMode: "enforce", kind: "planner_route" })).toBe("assist");
    const policy = createDecisionPolicy({ enforceKinds: ["planner_route"] });
    expect(effectiveMode({ requestedMode: "enforce", configuredMode: "enforce", kind: "planner_route", policy })).toBe("enforce");
    expect(effectiveMode({ requestedMode: "enforce", configuredMode: "enforce", kind: "review_triage", policy })).toBe("assist");
  });

  it("default policy allowlists no kind", () => {
    expect(DEFAULT_DECISION_POLICY.enforceKinds).toEqual([]);
  });

  it("lowerMode orders off < shadow < assist < enforce", () => {
    const modes: DecisionMode[] = ["off", "shadow", "assist", "enforce"];
    for (let i = 0; i < modes.length; i++) {
      for (let j = 0; j < modes.length; j++) {
        expect(lowerMode(modes[i], modes[j])).toBe(modes[Math.min(i, j)]);
      }
    }
  });
});

describe("uncertainty", () => {
  it("marks probabilities close to 0.5 as uncertain", () => {
    expect(isUncertain(probability("q", 0.5))).toBe(true);
    expect(isUncertain(probability("q", 0.55))).toBe(true);
    expect(isUncertain(probability("q", 0.9))).toBe(false);
  });

  it("[AT-JEV-024] marks low confidence and flat distributions as uncertain", () => {
    const flat = choice("q", "a", 0.9, { a: 0.34, b: 0.33, c: 0.33 });
    const unsure = choice("q", "a", 0.3, { a: 0.8, b: 0.1, c: 0.1 });
    const clear = choice("q", "a", 0.9, { a: 0.8, b: 0.1, c: 0.1 });
    expect(isUncertain(flat)).toBe(true);
    expect(isUncertain(unsure)).toBe(true);
    expect(isUncertain(clear)).toBe(false);
  });

  it("treats a missing probability/confidence as uncertain (fail-safe)", () => {
    expect(isUncertain({ questionId: "q", type: "probability", value: true })).toBe(true);
    expect(isUncertain({ questionId: "q", type: "score", value: "low", weightedScore: 1 })).toBe(true);
    expect(isUncertain({ questionId: "q", type: "choice", value: "a", probabilities: { a: 1 } })).toBe(true);
  });

  it("respects policy thresholds", () => {
    const strict = createDecisionPolicy({ minCertainty: 0.8 });
    expect(isUncertain(probability("q", 0.7), strict)).toBe(true);
    expect(isUncertain(probability("q", 0.95), strict)).toBe(false);
  });

  it("collects the uncertain ids", () => {
    expect(uncertainAnswerIds([probability("a", 0.9), probability("b", 0.5)])).toEqual(["b"]);
  });
});

describe("resolveAppliedOutcome — immutable rules", () => {
  const base = {
    kind: "review_triage" as const,
    status: "completed" as const,
    answers: [probability("q", 0.95)],
    subjects: [{ key: "f_1", severity: "high" as const, answerIds: ["q"] }],
  };

  it("[AT-JEV-021] shadow always applies none", () => {
    for (const answers of [[probability("q", 0.99)], [probability("q", 0.5)], []]) {
      const result = resolveAppliedOutcome({ ...base, mode: "shadow", answers });
      expect(result.appliedOutcome).toBe(APPLIED_NONE);
    }
  });

  it("assist suggests, never applies", () => {
    expect(resolveAppliedOutcome({ ...base, mode: "assist" }).appliedOutcome).toBe(APPLIED_ASSIST);
  });

  it("enforce behaves as assist for a non-allowlisted kind", () => {
    const result = resolveAppliedOutcome({ ...base, mode: "enforce", enforceOutcome: "skip_planner" });
    expect(result.appliedOutcome).toBe(APPLIED_ASSIST);
  });

  it("enforce applies only for an allowlisted kind with clean input", () => {
    const policy = createDecisionPolicy({ enforceKinds: ["review_triage"] });
    const result = resolveAppliedOutcome({ ...base, mode: "enforce", policy, enforceOutcome: "route_human" });
    expect(result.appliedOutcome).toBe("route_human");
    expect(result.violations).toEqual([]);
  });

  it("[AT-JEV-023] never turns a failing deterministic state into a pass", () => {
    const result = resolveAppliedOutcome({ ...base, mode: "assist", deterministicFailed: true });
    expect(result.appliedOutcome).toBe(APPLIED_NONE);
    expect(result.violations).toContain(OUTCOME_VIOLATIONS.deterministicFailed);
  });

  it("[AT-JEV-022] never downgrades a critical/high finding", () => {
    const result = resolveAppliedOutcome({
      ...base,
      mode: "assist",
      downgradeAnswerIds: ["q"],
    });
    expect(result.violations).toContain(OUTCOME_VIOLATIONS.protectedDowngrade);
    expect(result.appliedOutcome).toBe(APPLIED_NONE);
  });

  it("allows a downgrade claim for a non-protected (low/medium) finding", () => {
    const result = resolveAppliedOutcome({
      ...base,
      mode: "assist",
      subjects: [{ key: "f_2", severity: "low", answerIds: ["q"] }],
      downgradeAnswerIds: ["q"],
    });
    expect(result.violations).toEqual([]);
    expect(result.appliedOutcome).toBe(APPLIED_ASSIST);
  });

  it("[AT-JEV-024] marks uncertain answers and applies nothing", () => {
    const result = resolveAppliedOutcome({ ...base, mode: "assist", answers: [probability("q", 0.5)] });
    expect(result.uncertain).toEqual(["q"]);
    expect(result.appliedOutcome).toBe(APPLIED_NONE);
  });

  it("applies nothing when the evaluation did not complete", () => {
    const result = resolveAppliedOutcome({ ...base, mode: "assist", status: "fallback" });
    expect(result.appliedOutcome).toBeUndefined();
  });

  it("applies nothing in off mode", () => {
    const result = resolveAppliedOutcome({ ...base, mode: "off" });
    expect(result.appliedOutcome).toBeUndefined();
  });

  it("never returns an executable action", () => {
    const policy = createDecisionPolicy({ enforceKinds: ["review_triage"] });
    const result = resolveAppliedOutcome({ ...base, mode: "enforce", policy, enforceOutcome: "route_human" });
    expect(typeof result.appliedOutcome).toBe("string");
    expect(["none", "assist_suggestion", "route_human"]).toContain(result.appliedOutcome);
  });
});
