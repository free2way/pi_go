import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_ENGINE_DEFAULTS } from "./config.js";
import type { DecisionEngineConfig, DecisionQuestion, DecisionRequest } from "./types.js";
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  CircuitBreaker,
  buildProviderRequestBody,
  createJevEngine,
  mapQuestionToProvider,
  resetDecisionCircuitBreakers,
} from "./jev.js";

const API_KEY = "sk-DUMMY-unit-test-key-never-logged";

const config = (overrides: Partial<DecisionEngineConfig> = {}): DecisionEngineConfig => ({
  engine: "jev",
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
  hasApiKey: true,
  ...overrides,
});

const questions: Record<string, DecisionQuestion> = {
  q_prob: { type: "probability", prompt: "relevant?", trueMeaning: "yes", falseMeaning: "no" },
  q_choice: { type: "choice", prompt: "impact?", options: ["none", "material"] },
  q_score: {
    type: "score",
    prompt: "retry?",
    levels: [
      { value: "low", description: "low value" },
      { value: "high", description: "high value" },
    ],
  },
};

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  evaluationId: "de_jev",
  runId: "run_1",
  kind: "review_triage",
  mode: "shadow",
  policyVersion: "review-triage-v1",
  stateHash: "hash",
  state: { run: { round: 1 } },
  questions,
  timeoutMs: 3000,
  ...overrides,
});

const validBody = () => ({
  model: "jev-1.13.0",
  answers: {
    q_prob: { probability: 0.9 },
    q_choice: { choice: "material", probabilities: { none: 0.1, material: 0.9 }, confidence: 0.9 },
    q_score: { score: 1, probabilities: { low: 0.1, high: 0.9 }, confidence: 0.8 },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const hangingFetch = (): typeof fetch => (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = (init as RequestInit | undefined)?.signal ?? undefined;
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });

const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = API_KEY;
  resetDecisionCircuitBreakers();
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetDecisionCircuitBreakers();
  vi.restoreAllMocks();
});

describe("provider request mapping", () => {
  it("maps probability→noul with criteria when meanings are supplied", () => {
    expect(mapQuestionToProvider(questions.q_prob)).toEqual({ type: "noul", criteria: { true: "yes", false: "no" } });
  });

  it("maps probability→noul without criteria when meanings are absent", () => {
    expect(mapQuestionToProvider({ type: "probability", prompt: "p" })).toEqual({ type: "noul" });
  });

  it("maps choice→choice with a criteria map", () => {
    expect(mapQuestionToProvider(questions.q_choice)).toEqual({
      type: "choice",
      criteria: { none: "none", material: "material" },
    });
  });

  it("maps score→score with an ordered criteria array", () => {
    expect(mapQuestionToProvider(questions.q_score)).toEqual({
      type: "score",
      criteria: [
        { name: "low", description: "low value" },
        { name: "high", description: "high value" },
      ],
    });
  });

  it("rejects score questions outside the 2..10 level range", () => {
    const single = mapQuestionToProvider({ type: "score", prompt: "p", levels: [{ value: "x", description: "x" }] });
    expect(single).toHaveProperty("error");
    const many = mapQuestionToProvider({
      type: "score",
      prompt: "p",
      levels: Array.from({ length: 11 }, (_, i) => ({ value: `v${i}`, description: "d" })),
    });
    expect(many).toHaveProperty("error");
    const built = buildProviderRequestBody(request({ questions: { bad: { type: "score", prompt: "p", levels: [{ value: "x", description: "x" }] } } }), config());
    expect(built.ok).toBe(false);
  });

  it("builds {state, model, questions} with no key inside", () => {
    const built = buildProviderRequestBody(request(), config());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.model).toBe("jev-latest");
    expect(built.body.state).toEqual({ run: { round: 1 } });
    expect(Object.keys(built.body.questions)).toEqual(["q_prob", "q_choice", "q_score"]);
    expect(JSON.stringify(built.body)).not.toContain(API_KEY);
  });
});

describe("jev engine — transport", () => {
  it("POSTs to {baseUrl}/v1/systemone with a Bearer header and the mapped body", async () => {
    const fetchImpl = vi.fn(async () => json(validBody()));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    await engine.evaluate(request());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as { model: string; questions: Record<string, unknown> };
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["q_prob", "q_choice", "q_score"]);
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const fetchImpl = vi.fn(async () => json(validBody()));
    const engine = createJevEngine(config({ baseUrl: "https://mock.local/" }), { fetchImpl: fetchImpl as unknown as typeof fetch });
    await engine.evaluate(request());
    expect((fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0][0]).toBe("https://mock.local/v1/systemone");
  });

  it("returns a completed evaluation with resolved model and tokens", async () => {
    const engine = createJevEngine(config(), { fetchImpl: async () => json(validBody()) });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("completed");
    expect(evaluation.provider).toBe("typesafe");
    expect(evaluation.requestedModel).toBe("jev-latest");
    expect(evaluation.resolvedModel).toBe("jev-1.13.0");
    expect(evaluation.inputTokens).toBe(10);
    expect(evaluation.outputTokens).toBe(5);
    expect(evaluation.answers).toHaveLength(3);
    expect(evaluation.stateHash).toBe("hash");
  });

  it("falls back with missing_credentials without any request when the key is absent", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchImpl = vi.fn(async () => json(validBody()));
    const engine = createJevEngine(config({ hasApiKey: false }), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("missing_credentials");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an over-limit payload before dispatch", async () => {
    const fetchImpl = vi.fn(async () => json(validBody()));
    const engine = createJevEngine(config({ maxStateTokens: 1, maxStateBytes: 1 }), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("rejected");
    expect(evaluation.fallbackReason).toBe("payload_rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("jev engine — retry table", () => {
  it("does not retry 401 and opens the breaker until the config changes", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "nope" }, 401));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("authentication_failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evaluation.detail).not.toContain(API_KEY);
    expect(JSON.stringify(evaluation)).not.toContain(API_KEY);

    const blocked = await engine.evaluate(request({ evaluationId: "de_2" }));
    expect(blocked.fallbackReason).toBe("circuit_open");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A different configuration gets a fresh breaker.
    const other = createJevEngine(config({ model: "jev-other" }), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const afterConfigChange = await other.evaluate(request({ evaluationId: "de_3" }));
    expect(afterConfigChange.fallbackReason).toBe("authentication_failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry 422 and reports the policy version and question schema hash", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "contract" }, 422));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("contract_invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evaluation.detail).toContain("review-triage-v1");
    expect(evaluation.detail).toMatch(/schema=[0-9a-f]{64}/);
  });

  it("does not retry an other 4xx", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "bad request" }, 400));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("contract_invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a schema-invalid 200", async () => {
    const fetchImpl = vi.fn(async () => json({ model: "m", answers: { q_prob: { probability: 5 } } }));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("contract_invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 once honoring Retry-After", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return json({ error: "slow down" }, 429, { "Retry-After": "0" });
      return json(validBody());
    });
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not wait when Retry-After exceeds the remaining budget", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "slow down" }, 429, { "Retry-After": "30" }));
    const engine = createJevEngine(config({ timeoutMs: 2000 }), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const started = Date.now();
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("rate_limited");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("retries a 529 once with jitter and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return json({ error: "overloaded" }, 529);
      return json(validBody());
    });
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx once and reports provider_unavailable when it persists", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "boom" }, 503));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("provider_unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network error once and normalizes it to provider_unavailable", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return json(validBody());
    });
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const evaluation = await engine.evaluate(request());
    expect(evaluation.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("opens the breaker after five consecutive provider-attributable failures", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "boom" }, 500));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    for (let i = 0; i < 3; i += 1) {
      const evaluation = await engine.evaluate(request({ evaluationId: `de_${i}` }));
      expect(evaluation.fallbackReason).toBe("provider_unavailable");
    }
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(BREAKER_THRESHOLD);
    const blocked = await engine.evaluate(request({ evaluationId: "de_blocked" }));
    expect(blocked.fallbackReason).toBe("circuit_open");
  });
});

describe("jev engine — time budget and cancellation", () => {
  it("cancels the underlying request at the total timeout and reports timeout", async () => {
    const engine = createJevEngine(config({ timeoutMs: 60 }), { fetchImpl: hangingFetch() });
    const started = Date.now();
    const evaluation = await engine.evaluate(request());
    expect(evaluation.fallbackReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("propagates a caller abort and reports aborted", async () => {
    const engine = createJevEngine(config({ timeoutMs: 5000 }), { fetchImpl: hangingFetch() });
    const controller = new AbortController();
    const promise = engine.evaluate(request(), controller.signal);
    setTimeout(() => controller.abort(), 10);
    const evaluation = await promise;
    expect(evaluation.fallbackReason).toBe("aborted");
  });

  it("reports aborted without dispatching when the signal is already aborted", async () => {
    const fetchImpl = vi.fn(async () => json(validBody()));
    const engine = createJevEngine(config(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const controller = new AbortController();
    controller.abort();
    const evaluation = await engine.evaluate(request(), controller.signal);
    expect(evaluation.fallbackReason).toBe("aborted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("CircuitBreaker", () => {
  const makeClock = (start = 1_000_000) => {
    let current = start;
    return { now: () => current, advance: (ms: number) => (current += ms) };
  };

  it("opens after the threshold and admits one half-open probe after the cooldown", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) breaker.onProviderFailure();
    expect(breaker.state()).toBe("open");
    expect(breaker.allow()).toBe(false);

    clock.advance(BREAKER_COOLDOWN_MS);
    expect(breaker.state()).toBe("half_open");
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(false);
    breaker.onSuccess();
    expect(breaker.state()).toBe("closed");
    expect(breaker.allow()).toBe(true);
  });

  it("re-opens when the half-open probe fails", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) breaker.onProviderFailure();
    clock.advance(BREAKER_COOLDOWN_MS);
    expect(breaker.allow()).toBe(true);
    breaker.onProviderFailure();
    expect(breaker.state()).toBe("open");
    expect(breaker.allow()).toBe(false);
  });

  it("locks open on auth failure until reset (config change)", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    breaker.onAuthFailure();
    clock.advance(BREAKER_COOLDOWN_MS * 10);
    expect(breaker.state()).toBe("open");
    expect(breaker.allow()).toBe(false);
    breaker.reset();
    expect(breaker.state()).toBe("closed");
    expect(breaker.allow()).toBe(true);
  });

  it("resets the failure count on success", () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) breaker.onProviderFailure();
    breaker.onSuccess();
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) breaker.onProviderFailure();
    expect(breaker.state()).toBe("closed");
  });

  it("releases an inconclusive half-open probe and waits another cooldown", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) breaker.onProviderFailure();
    clock.advance(BREAKER_COOLDOWN_MS);
    expect(breaker.allow()).toBe(true);
    breaker.onInconclusive();
    expect(breaker.allow()).toBe(false);
    clock.advance(BREAKER_COOLDOWN_MS);
    expect(breaker.allow()).toBe(true);
  });
});
