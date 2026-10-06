import { describe, expect, it } from "vitest";
import { DECISION_ENGINE_DEFAULTS } from "./config.js";
import type { DecisionEngineConfig, DecisionQuestion, DecisionRequest } from "./types.js";
import { createDisabledEngine } from "./disabled.js";
import { createMockEngine } from "./mock.js";

const config = (overrides: Partial<DecisionEngineConfig> = {}): DecisionEngineConfig => ({
  engine: "mock",
  mode: "shadow",
  baseUrl: DECISION_ENGINE_DEFAULTS.baseUrl,
  model: DECISION_ENGINE_DEFAULTS.model,
  timeoutMs: 3000,
  maxAttempts: 2,
  maxStateTokens: DECISION_ENGINE_DEFAULTS.maxStateTokens,
  maxStateBytes: DECISION_ENGINE_DEFAULTS.maxStateBytes,
  reviewMaxFindings: 50,
  shadowSampleRate: 1,
  policyVersion: "review-triage-v1",
  allowSource: false,
  hasApiKey: false,
  ...overrides,
});

const questions: Record<string, DecisionQuestion> = {
  f_1_requirement_relevant: { type: "probability", prompt: "relevant?" },
  f_1_security_impact: { type: "choice", prompt: "impact?", options: ["none", "possible", "material"] },
  f_1_retry_value: {
    type: "score",
    prompt: "retry?",
    levels: [
      { value: "none", description: "no" },
      { value: "low", description: "low" },
      { value: "medium", description: "med" },
      { value: "high", description: "high" },
    ],
  },
};

const request: DecisionRequest = {
  evaluationId: "de_mock",
  runId: "run_1",
  kind: "review_triage",
  mode: "shadow",
  policyVersion: "review-triage-v1",
  stateHash: "hash",
  state: { run: { round: 1 } },
  questions,
  timeoutMs: 3000,
};

describe("disabled engine", () => {
  it("makes no I/O and returns a disabled evaluation", async () => {
    const engine = createDisabledEngine(config({ engine: "disabled", mode: "off" }));
    const evaluation = await engine.evaluate(request);
    expect(evaluation.status).toBe("disabled");
    expect(evaluation.provider).toBe("disabled");
    expect(evaluation.fallbackReason).toBe("disabled");
    expect(evaluation.answers).toEqual([]);
    expect(evaluation.stateHash).toBe("hash");
    expect(evaluation.evaluationId).toBe("de_mock");
  });
});

describe("mock engine", () => {
  it("returns schema-valid, deterministic answers for every question", async () => {
    const engine = createMockEngine(config());
    const first = await engine.evaluate(request);
    const second = await engine.evaluate(request);
    expect(first.status).toBe("completed");
    expect(first.provider).toBe("mock");
    expect(first.answers).toHaveLength(3);
    expect(first.answers).toEqual(second.answers);

    const probability = first.answers.find((answer) => answer.questionId === "f_1_requirement_relevant")!;
    expect(probability.probability).toBeGreaterThanOrEqual(0);
    expect(probability.probability).toBeLessThanOrEqual(1);
    expect(probability.value).toBe(probability.probability! >= 0.5);
    expect(probability.certainty).toBeGreaterThanOrEqual(0);

    const choice = first.answers.find((answer) => answer.questionId === "f_1_security_impact")!;
    expect(Object.keys(choice.probabilities!).sort()).toEqual(["material", "none", "possible"]);
    expect(Object.values(choice.probabilities!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(choice.confidence).toBeGreaterThan(0);
    expect(choice.confidence).toBeLessThanOrEqual(1);

    const score = first.answers.find((answer) => answer.questionId === "f_1_retry_value")!;
    expect(["none", "low", "medium", "high"]).toContain(score.value);
    expect(Number.isFinite(score.weightedScore!)).toBe(true);
    expect(Object.values(score.probabilities!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("[AT-JEV-014] records a resolved model distinct from the requested alias", async () => {
    const engine = createMockEngine(config());
    const evaluation = await engine.evaluate(request);
    expect(evaluation.requestedModel).toBe("jev-latest");
    expect(evaluation.resolvedModel).toBe("mock:jev-latest");
  });

  it("is stable across differently-keyed states (answers depend only on questions)", async () => {
    const engine = createMockEngine(config());
    const other = await engine.evaluate({ ...request, state: { run: { round: 9 } }, stateHash: "other" });
    const base = await engine.evaluate(request);
    expect(other.answers).toEqual(base.answers);
    expect(other.stateHash).toBe("other");
  });

  it.each([
    ["rate_limited", "rate_limited"],
    ["server_error", "provider_unavailable"],
    ["authentication_failed", "authentication_failed"],
    ["contract_invalid", "contract_invalid"],
  ] as const)("injects %s as a fallback", async (failure, reason) => {
    const engine = createMockEngine(config(), { failure });
    const evaluation = await engine.evaluate(request);
    expect(evaluation.status).toBe("fallback");
    expect(evaluation.fallbackReason).toBe(reason);
    expect(evaluation.answers).toEqual([]);
  });

  it("injects a timeout that is bounded by the configured budget", async () => {
    const engine = createMockEngine(config({ timeoutMs: 5 }), { failure: "timeout" });
    const started = Date.now();
    const evaluation = await engine.evaluate(request);
    expect(evaluation.fallbackReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports aborted when the caller cancels a simulated timeout", async () => {
    const engine = createMockEngine(config({ timeoutMs: 5000 }), { failure: "timeout" });
    const controller = new AbortController();
    const promise = engine.evaluate(request, controller.signal);
    controller.abort();
    const evaluation = await promise;
    expect(evaluation.fallbackReason).toBe("aborted");
  });

  it("honors an immediate caller abort before answering", async () => {
    const engine = createMockEngine(config());
    const controller = new AbortController();
    controller.abort();
    const evaluation = await engine.evaluate(request, controller.signal);
    expect(evaluation.fallbackReason).toBe("aborted");
  });
});
