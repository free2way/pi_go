import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_ENGINE_DEFAULTS, loadDecisionEngineConfig } from "./config.js";
import { createDecisionEngine } from "./index.js";
import { shouldSampleShadow } from "./policy.js";
import { buildReviewTriageRequest } from "./review-triage.js";
import type { DecisionEngineConfig, DecisionRequest } from "./types.js";
import { baseRealRun } from "../real-run.js";

const API_KEY = "sk-integration-key";

const config = (overrides: Partial<DecisionEngineConfig> = {}): DecisionEngineConfig => ({
  engine: "disabled",
  mode: "off",
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

const run = baseRealRun(
  { title: "index test", task: "Fix the worker.", repository: "/srv/proj", mode: "real", checks: ["npm test"] },
  "owner_1",
);
run.findings = [
  {
    id: "F1",
    severity: "high",
    file: "src/worker.ts",
    line: 1,
    title: "missing check",
    evidence: "no owner check",
    requiredChange: "add owner check",
    resolved: false,
    consecutiveRounds: 1,
  },
];

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  ...buildReviewTriageRequest({
    run,
    mode: "shadow",
    policyVersion: "review-triage-v1",
    maxFindings: 50,
    evaluationId: "de_index",
    timeoutMs: 3000,
  }),
  ...overrides,
});

const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = API_KEY;
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("createDecisionEngine — composition and mode gating", () => {
  it("re-exports the strict config loader", () => {
    const result = loadDecisionEngineConfig({} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
  });

  it("disabled engine never reaches a provider", async () => {
    const fetchImpl = vi.fn();
    const engine = createDecisionEngine(config({ engine: "disabled", mode: "shadow" }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("disabled");
    expect(evaluation.provider).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mock engine completes in shadow and records appliedOutcome=none", async () => {
    const engine = createDecisionEngine(config({ engine: "mock", mode: "shadow" }));
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("completed");
    expect(evaluation.provider).toBe("mock");
    expect(evaluation.appliedOutcome).toBe("none");
    expect(evaluation.answers).toHaveLength(4);
  });

  it("mock engine suggests in assist without applying", async () => {
    const engine = createDecisionEngine(config({ engine: "mock", mode: "assist" }));
    const evaluation = await engine.evaluate(request({ mode: "assist" }));
    expect(evaluation.appliedOutcome).toBe("assist_suggestion");
  });

  it("mode off skips even the mock engine", async () => {
    const engine = createDecisionEngine(config({ engine: "mock", mode: "off" }));
    const evaluation = await engine.evaluate(request({ mode: "assist" }));
    expect(evaluation.status).toBe("disabled");
    expect(evaluation.provider).toBe("disabled");
    expect(evaluation.mode).toBe("off");
  });

  it("a request cannot escalate above the configured mode", async () => {
    const engine = createDecisionEngine(config({ engine: "mock", mode: "shadow" }));
    const evaluation = await engine.evaluate(request({ mode: "enforce" }));
    expect(evaluation.mode).toBe("shadow");
    expect(evaluation.appliedOutcome).toBe("none");
  });

  it("dropped shadow samples never call the provider", async () => {
    const engine = createDecisionEngine(config({ engine: "mock", mode: "shadow", shadowSampleRate: 0 }));
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("disabled");
    expect(evaluation.appliedOutcome).toBeUndefined();
  });

  it("does not stamp an outcome onto a fallback evaluation", async () => {
    process.env.PI_JEV_MOCK_FAILURE = "server_error";
    try {
      const engine = createDecisionEngine(config({ engine: "mock", mode: "assist" }));
      const evaluation = await engine.evaluate(request());
      expect(evaluation.status).toBe("fallback");
      expect(evaluation.appliedOutcome).toBeUndefined();
    } finally {
      delete process.env.PI_JEV_MOCK_FAILURE;
    }
  });
});

/** Valid provider answers for whatever questions the request contains. */
function providerAnswers(questions: DecisionRequest["questions"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === "probability") return [id, { probability: 0.9 }];
      if (question.type === "choice") {
        const probabilities = Object.fromEntries(question.options.map((option, index) => [option, index === 0 ? 1 : 0]));
        return [id, { choice: question.options[0], probabilities, confidence: 0.9 }];
      }
      const probabilities = Object.fromEntries(question.levels.map((level, index) => [level.value, index === 0 ? 1 : 0]));
      return [id, { score: 0, probabilities, confidence: 0.9 }];
    }),
  );
}

describe("createDecisionEngine — jev wiring", () => {
  it("dispatches to the provider in shadow and records none", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ model: "jev-1.13.0", answers: providerAnswers(request().questions) }), { status: 200 }),
    );
    const engine = createDecisionEngine(config({ engine: "jev", mode: "shadow", hasApiKey: true }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const evaluation = await engine.evaluate(request());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evaluation.status).toBe("completed");
    expect(evaluation.provider).toBe("typesafe");
    expect(evaluation.resolvedModel).toBe("jev-1.13.0");
    expect(evaluation.appliedOutcome).toBe("none");
  });

  it("reports missing_credentials when the key disappears at call time", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchImpl = vi.fn();
    const engine = createDecisionEngine(config({ engine: "jev", mode: "shadow", hasApiKey: true }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("missing_credentials");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("shouldSampleShadow", () => {
  it("keeps everything at rate 1 and nothing at rate 0", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(shouldSampleShadow(`de_${index}`, 1)).toBe(true);
      expect(shouldSampleShadow(`de_${index}`, 0)).toBe(false);
    }
  });

  it("is deterministic and roughly proportional in between", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `de_${index}`);
    const first = ids.filter((id) => shouldSampleShadow(id, 0.5));
    const second = ids.filter((id) => shouldSampleShadow(id, 0.5));
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(50);
    expect(first.length).toBeLessThan(150);
  });
});
