import { describe, expect, it } from "vitest";
import type { DecisionRequest } from "./types.js";
import { DISTRIBUTION_TOLERANCE, mapProviderResponse, providerResponseSchema } from "./response-schema.js";

const request: DecisionRequest = {
  evaluationId: "de_1",
  runId: "run_1",
  kind: "review_triage",
  mode: "shadow",
  policyVersion: "review-triage-v1",
  stateHash: "hash",
  state: {},
  questions: {
    q_prob: { type: "probability", prompt: "relevant?" },
    q_choice: { type: "choice", prompt: "impact?", options: ["none", "possible", "material"] },
    q_score: {
      type: "score",
      prompt: "retry value?",
      levels: [
        { value: "none", description: "no" },
        { value: "low", description: "low" },
        { value: "medium", description: "med" },
        { value: "high", description: "high" },
      ],
    },
  },
  timeoutMs: 3000,
};

const validAnswer = (overrides: Record<string, unknown> = {}) => ({
  q_prob: { probability: 0.8 },
  q_choice: { choice: "material", probabilities: { none: 0.05, possible: 0.15, material: 0.8 }, confidence: 0.9 },
  q_score: { score: 2.4, probabilities: { none: 0.05, low: 0.1, medium: 0.35, high: 0.5 }, confidence: 0.7 },
  ...overrides,
});

const response = (answers: unknown, extra: Record<string, unknown> = {}) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 120, output_tokens: 40 },
  ...extra,
});

describe("mapProviderResponse — happy path", () => {
  it("maps all three answer kinds", () => {
    const result = mapProviderResponse(response(validAnswer()), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(40);
    expect(result.answers).toHaveLength(3);
    expect(result.answers.map((a) => a.questionId)).toEqual(["q_prob", "q_choice", "q_score"]);
  });

  it("[AT-JEV-010] maps noul to probability + certainty and never stores confidence", () => {
    const result = mapProviderResponse(response(validAnswer()), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = result.answers.find((a) => a.questionId === "q_prob")!;
    expect(answer).toMatchObject({ type: "probability", value: true, probability: 0.8 });
    expect(answer.certainty).toBeCloseTo(0.6, 10);
    expect(answer.confidence).toBeUndefined();
  });

  it("[AT-JEV-010] derives a false boolean below 0.5 while keeping the raw probability", () => {
    const result = mapProviderResponse(
      response({ ...validAnswer(), q_prob: { probability: 0.2, confidence: 0.99 } }),
      request,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = result.answers.find((a) => a.questionId === "q_prob")!;
    expect(answer.value).toBe(false);
    expect(answer.probability).toBe(0.2);
    expect(answer.confidence).toBeUndefined();
  });

  it("[AT-JEV-011] maps choice with distribution and confidence", () => {
    const result = mapProviderResponse(response(validAnswer()), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = result.answers.find((a) => a.questionId === "q_choice")!;
    expect(answer).toMatchObject({ type: "choice", value: "material", confidence: 0.9 });
    expect(answer.probabilities).toEqual({ none: 0.05, possible: 0.15, material: 0.8 });
  });

  it("[AT-JEV-012] maps score to the nearest ordered level", () => {
    const result = mapProviderResponse(response(validAnswer()), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = result.answers.find((a) => a.questionId === "q_score")!;
    expect(answer).toMatchObject({ type: "score", value: "medium", weightedScore: 2.4, confidence: 0.7 });
  });

  it("[AT-JEV-012] rounds an in-range weighted score to the nearest level", () => {
    const result = mapProviderResponse(
      response({ ...validAnswer(), q_score: { score: 2.6, probabilities: { none: 0, low: 0, medium: 0.5, high: 0.5 }, confidence: 0.5 } }),
      request,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.find((a) => a.questionId === "q_score")!.value).toBe("high");
  });

  it("tolerates provider answer aliases (value/distribution/weighted_score)", () => {
    const result = mapProviderResponse(
      response({
        q_prob: { probability: 0.5 },
        q_choice: { value: "none", distribution: { none: 1, possible: 0, material: 0 }, confidence: 0.5 },
        q_score: {
          weighted_score: 0,
          distribution: { none: 1, low: 0, medium: 0, high: 0 },
          confidence: 0.5,
        },
      }),
      request,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.map((a) => a.value)).toEqual([true, "none", "none"]);
  });

  it("accepts an optional echo of the provider type", () => {
    const result = mapProviderResponse(
      response({ ...validAnswer(), q_prob: { type: "noul", probability: 0.6 } }),
      request,
    );
    expect(result.ok).toBe(true);
  });

  it("[AT-JEV-062] records missing usage as unknown rather than zero-cost", () => {
    const result = mapProviderResponse({ model: "jev-1.13.0", answers: validAnswer() }, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  it("exports a strict envelope schema", () => {
    expect(providerResponseSchema.safeParse({ model: "m", answers: {} }).success).toBe(true);
    expect(providerResponseSchema.safeParse({ model: "", answers: {} }).success).toBe(false);
    expect(providerResponseSchema.safeParse({ model: "m" }).success).toBe(false);
  });
});

describe("mapProviderResponse — contract_invalid cases (never partial)", () => {
  const cases: Array<[string, unknown]> = [
    ["missing answer", response({ ...validAnswer(), q_prob: undefined })],
    ["unknown question id", response({ ...validAnswer(), q_extra: { probability: 0.5 } })],
    ["unknown field in an answer", response({ ...validAnswer(), q_prob: { probability: 0.5, secret: 1 } })],
    ["probability above 1", response({ ...validAnswer(), q_prob: { probability: 1.2 } })],
    ["probability below 0", response({ ...validAnswer(), q_prob: { probability: -0.1 } })],
    ["NaN probability", response({ ...validAnswer(), q_prob: { probability: Number.NaN } })],
    ["missing probability", response({ ...validAnswer(), q_prob: { value: true } })],
    ["unknown option", response({ ...validAnswer(), q_choice: { choice: "unknown", probabilities: { none: 0.5, possible: 0.5, material: 0 }, confidence: 0.5 } })],
    [
      "distribution with an unknown option",
      response({ ...validAnswer(), q_choice: { choice: "none", probabilities: { none: 0.5, weird: 0.5 }, confidence: 0.5 } }),
    ],
    [
      "distribution not summing to 1",
      response({ ...validAnswer(), q_choice: { choice: "none", probabilities: { none: 0.2, possible: 0.2, material: 0.2 }, confidence: 0.5 } }),
    ],
    ["missing choice", response({ ...validAnswer(), q_choice: { probabilities: { none: 1, possible: 0, material: 0 }, confidence: 0.5 } })],
    [
      "conflicting choice/value",
      response({ ...validAnswer(), q_choice: { choice: "none", value: "material", probabilities: { none: 1, possible: 0, material: 0 }, confidence: 0.5 } }),
    ],
    ["confidence out of range", response({ ...validAnswer(), q_choice: { choice: "none", probabilities: { none: 1, possible: 0, material: 0 }, confidence: 1.5 } })],
    ["unknown level", response({ ...validAnswer(), q_score: { score: 1, probabilities: { none: 0.5, weird: 0.5 }, confidence: 0.5 } })],
    ["score out of range", response({ ...validAnswer(), q_score: { score: 99, probabilities: { none: 0.25, low: 0.25, medium: 0.25, high: 0.25 }, confidence: 0.5 } })],
    ["missing score", response({ ...validAnswer(), q_score: { probabilities: { none: 0.25, low: 0.25, medium: 0.25, high: 0.25 }, confidence: 0.5 } })],
    ["wrong answer type echo", response({ ...validAnswer(), q_prob: { type: "choice", probability: 0.5 } })],
    ["answers is an array", { model: "m", answers: [{ probability: 0.5 }] }],
    ["missing model", { answers: validAnswer() }],
    ["non-object response", "not json"],
    ["null response", null],
  ];

  it.each(cases)("[AT-JEV-013] rejects %s", (_name, payload) => {
    const result = mapProviderResponse(payload, request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail).not.toContain("answers\":");
  });

  it("[AT-JEV-013] does not partially apply a valid answer when another is invalid", () => {
    const result = mapProviderResponse(
      response({ q_prob: { probability: 0.9 }, q_choice: { choice: "bogus", probabilities: {}, confidence: 1 }, q_score: { score: 1, probabilities: { none: 1, low: 0, medium: 0, high: 0 }, confidence: 1 } }),
      request,
    );
    expect(result.ok).toBe(false);
  });

  it("tolerates a distribution floating-point drift within tolerance", () => {
    const drifted = { none: 0.33, possible: 0.33, material: 0.34000001 };
    const result = mapProviderResponse(response({ ...validAnswer(), q_choice: { choice: "material", probabilities: drifted, confidence: 0.5 } }), request);
    expect(result.ok).toBe(true);
    expect(Math.abs(Object.values(drifted).reduce((a, b) => a + b, 0) - 1)).toBeLessThanOrEqual(DISTRIBUTION_TOLERANCE);
  });

  it("rejects a distribution whose drift exceeds tolerance", () => {
    const result = mapProviderResponse(
      response({ ...validAnswer(), q_choice: { choice: "material", probabilities: { none: 0.3, possible: 0.3, material: 0.3 }, confidence: 0.5 } }),
      request,
    );
    expect(result.ok).toBe(false);
  });
});

/**
 * The live System One shapes, taken verbatim from the published OpenAPI at
 * `GET https://api.typesafe.ai/openapi.json`. The first real production call
 * (2026-10-06) was rejected locally as `malformed noul answer` while the
 * provider had answered HTTP 200 — these cases pin the real field names.
 */
describe("mapProviderResponse — live System One contract", () => {
  const liveAnswers = {
    q_prob: { type: "noul", noul: 0.98 },
    q_choice: { type: "choice", choice: "material", confidence: 0.9, probabilities: { none: 0.05, possible: 0.05, material: 0.9 } },
    q_score: {
      type: "score",
      score: 2.4,
      confidence: 0.8,
      legend: { "0": "no", "1": "low", "2": "med", "3": "high" },
      probabilities: { "0": 0.05, "1": 0.1, "2": 0.35, "3": 0.5 },
    },
  };

  it("accepts `noul` as P(true) and derives certainty locally", () => {
    const result = mapProviderResponse(response(liveAnswers), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = result.answers.find((a) => a.questionId === "q_prob")!;
    expect(answer).toMatchObject({ type: "probability", probability: 0.98, value: true });
    expect(answer.certainty).toBeCloseTo(0.96, 6);
  });

  it("accepts the documented ScoreAnswer with `legend` and position-keyed probabilities", () => {
    const result = mapProviderResponse(response(liveAnswers), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = result.answers.find((a) => a.questionId === "q_score")!;
    // 2.4 on the 0..levels-1 scale, nearest level = index 2 ("medium").
    expect(answer).toMatchObject({ type: "score", value: "medium", weightedScore: 2.4 });
    expect(answer.probabilities).toEqual({ none: 0.05, low: 0.1, medium: 0.35, high: 0.5 });
  });

  it("still rejects an answer that carries neither `noul` nor `probability`", () => {
    const result = mapProviderResponse(response({ ...liveAnswers, q_prob: { type: "noul" } }), request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("q_prob");
  });

  it("rejects a positional score key outside the requested rubric", () => {
    const result = mapProviderResponse(
      response({ ...liveAnswers, q_score: { ...liveAnswers.q_score, probabilities: { "0": 0.2, "9": 0.8 } } }),
      request,
    );
    expect(result.ok).toBe(false);
  });
});
