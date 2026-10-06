import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_ENGINE_DEFAULTS } from "./config.js";
import { BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD, createJevEngine, resetDecisionCircuitBreakers } from "./jev.js";
import type { DecisionEngineConfig, DecisionEvaluation, DecisionQuestion, DecisionRequest } from "./types.js";

/**
 * docs/27 §4.1/§8 · Integration layer for the Jev adapter (AT-JEV-040/041/042/
 * 043/045/046/048/050).
 *
 * `jev.test.ts` already pins the transport contract against a fake `fetch`.
 * This file deliberately does NOT repeat it: it stands up a REAL local
 * `node:http` server and drives the real global `fetch` through it, so the parts
 * that only exist over a socket — header casing, body framing, Retry-After
 * parsing, connection aborts, and the breaker's real timing seam — are exercised
 * end to end. It consumes no external quota (docs/27 §4.1) and stays out of the
 * provider's code path entirely.
 */

const API_KEY = "sk-DUMMY-integration-key-must-never-leak";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

type Handler = (request: CapturedRequest, response: ServerResponse) => void | Promise<void>;

interface MockServer {
  baseUrl: string;
  requests: CapturedRequest[];
}

const openServers: Server[] = [];

/** Starts a real HTTP server on an ephemeral loopback port and records every request. */
async function startMockServer(handler: Handler): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("error", () => undefined);
    response.on("error", () => undefined);
    incoming.on("end", () => {
      const captured: CapturedRequest = {
        method: incoming.method,
        url: incoming.url,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      void Promise.resolve(handler(captured, response)).catch(() => undefined);
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function respondJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

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
  evaluationId: "de_it",
  runId: "run_it",
  kind: "review_triage",
  mode: "shadow",
  policyVersion: "review-triage-v1",
  stateHash: "hash",
  state: { run: { round: 1 } },
  questions,
  timeoutMs: 3000,
  ...overrides,
});

/**
 * The live System One shape (docs/27 §7.2): a `noul`, a `choice` and a `score`
 * answer. Score probabilities/legend are keyed by POSITION ("0"/"1"), exactly as
 * the provider returns them, so the integration test also covers the positional
 * translation rather than a hand-written level name.
 */
const validBody = () => ({
  model: "jev-1.13.0",
  answers: {
    q_prob: { type: "noul", noul: 0.93 },
    q_choice: { type: "choice", choice: "material", confidence: 0.9, probabilities: { none: 0.1, material: 0.9 } },
    q_score: {
      type: "score",
      score: 1,
      confidence: 0.8,
      legend: { "0": "low", "1": "high" },
      probabilities: { "0": 0.1, "1": 0.9 },
    },
  },
  usage: { input_tokens: 42, output_tokens: 7 },
});

/** AT-JEV-050: no failure shape and no request body may ever carry the key. */
function expectNoKeyLeak(evaluation: DecisionEvaluation): void {
  expect(evaluation.detail ?? "").not.toContain(API_KEY);
  expect(JSON.stringify(evaluation)).not.toContain(API_KEY);
}

const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = API_KEY;
  resetDecisionCircuitBreakers();
});

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetDecisionCircuitBreakers();
  vi.restoreAllMocks();
});

describe("jev engine over a real local HTTP server", () => {
  it("POSTs an authenticated, well-formed body and maps a 200 into a completed evaluation", async () => {
    const server = await startMockServer((_request, response) => respondJson(response, 200, validBody()));
    const engine = createJevEngine(config({ baseUrl: server.baseUrl }));

    const evaluation = await engine.evaluate(request());

    expect(server.requests).toHaveLength(1);
    const sent = server.requests[0];
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/v1/systemone");
    expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(String(sent.headers["content-type"] ?? "")).toContain("application/json");

    const body = JSON.parse(sent.body) as { state: unknown; model: string; questions: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["state", "model", "questions"]);
    expect(body.state).toEqual({ run: { round: 1 } });
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["q_prob", "q_choice", "q_score"]);
    expect(sent.body).not.toContain(API_KEY);

    expect(evaluation.status).toBe("completed");
    expect(evaluation.provider).toBe("typesafe");
    expect(evaluation.requestedModel).toBe("jev-latest");
    expect(evaluation.resolvedModel).toBe("jev-1.13.0");
    expect(evaluation.inputTokens).toBe(42);
    expect(evaluation.outputTokens).toBe(7);
    expect(evaluation.answers).toHaveLength(3);

    const byId = Object.fromEntries(evaluation.answers.map((answer) => [answer.questionId, answer]));
    expect(byId.q_prob).toMatchObject({ type: "probability", value: true, probability: 0.93 });
    expect(byId.q_choice).toMatchObject({ type: "choice", value: "material" });
    expect(byId.q_score).toMatchObject({ type: "score", value: "high", weightedScore: 1 });
    expectNoKeyLeak(evaluation);
  });

  it("retries a 429 once while honoring Retry-After, then completes", async () => {
    let attempts = 0;
    const server = await startMockServer((_request, response) => {
      attempts += 1;
      if (attempts === 1) {
        respondJson(response, 429, { error: "slow down" }, { "Retry-After": "0" });
        return;
      }
      respondJson(response, 200, validBody());
    });

    const engine = createJevEngine(config({ baseUrl: server.baseUrl }));
    const evaluation = await engine.evaluate(request());

    expect(server.requests).toHaveLength(2);
    expect(evaluation.status).toBe("completed");
    expectNoKeyLeak(evaluation);
  });

  it("reports rate_limited when the 429 persists through the retry", async () => {
    const server = await startMockServer((_request, response) =>
      respondJson(response, 429, { error: "slow down" }, { "Retry-After": "0" }),
    );
    const engine = createJevEngine(config({ baseUrl: server.baseUrl }));

    const evaluation = await engine.evaluate(request());

    expect(server.requests).toHaveLength(2);
    expect(evaluation.status).toBe("fallback");
    expect(evaluation.fallbackReason).toBe("rate_limited");
    expectNoKeyLeak(evaluation);
  });

  it.each([500, 503, 529])("retries HTTP %i once and reports provider_unavailable when it persists", async (status) => {
    const server = await startMockServer((_request, response) => respondJson(response, status, { error: "unavailable" }));
    const engine = createJevEngine(config({ baseUrl: server.baseUrl }));

    const evaluation = await engine.evaluate(request());

    expect(server.requests).toHaveLength(2);
    expect(evaluation.fallbackReason).toBe("provider_unavailable");
    expectNoKeyLeak(evaluation);
  });

  it("aborts a hung socket at the total budget and reports timeout", async () => {
    const server = await startMockServer(() => {
      // Deliberately never respond: the adapter's own timer must abort.
    });
    const engine = createJevEngine(config({ baseUrl: server.baseUrl, timeoutMs: 150 }));

    const started = Date.now();
    const evaluation = await engine.evaluate(request());

    expect(evaluation.fallbackReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.requests).toHaveLength(1);
    expectNoKeyLeak(evaluation);
  });

  it("propagates a caller abort on an in-flight request as aborted", async () => {
    const server = await startMockServer(() => {
      // In-flight socket, cancelled below by the caller.
    });
    const engine = createJevEngine(config({ baseUrl: server.baseUrl, timeoutMs: 5000 }));

    const controller = new AbortController();
    const pending = engine.evaluate(request(), controller.signal);
    setTimeout(() => controller.abort(), 25);
    const evaluation = await pending;

    expect(evaluation.fallbackReason).toBe("aborted");
    expectNoKeyLeak(evaluation);
  });

  it("opens the breaker after consecutive provider failures and recovers after the cooldown", async () => {
    // The public engine has no clock seam, but its breaker reads `Date.now` at
    // call time (see `CircuitBreaker`), so freezing/advancing it is the existing
    // injectable-clock mechanism that avoids a real 60s cooldown. Real HTTP is
    // unaffected (it uses signals and real timers, not `Date.now`).
    let fakeNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    let status = 500;
    const server = await startMockServer((_request, response) =>
      status === 200 ? respondJson(response, 200, validBody()) : respondJson(response, status, { error: "boom" }),
    );
    const engine = createJevEngine(config({ baseUrl: server.baseUrl }));

    for (let index = 0; index < 3; index += 1) {
      const evaluation = await engine.evaluate(request({ evaluationId: `de_fail_${index}` }));
      expect(evaluation.fallbackReason).toBe("provider_unavailable");
    }
    const dispatched = server.requests.length;
    expect(dispatched).toBeGreaterThanOrEqual(BREAKER_THRESHOLD);

    const open = await engine.evaluate(request({ evaluationId: "de_open" }));
    expect(open.fallbackReason).toBe("circuit_open");
    expect(server.requests).toHaveLength(dispatched);
    expectNoKeyLeak(open);

    fakeNow += BREAKER_COOLDOWN_MS;
    status = 200;
    const probe = await engine.evaluate(request({ evaluationId: "de_probe" }));
    expect(probe.status).toBe("completed");
    expect(server.requests.length).toBeGreaterThan(dispatched);

    const after = await engine.evaluate(request({ evaluationId: "de_after" }));
    expect(after.status).toBe("completed");
    nowSpy.mockRestore();
  });

  it("never puts the key in a 401 detail and locks the breaker until the config changes", async () => {
    const server = await startMockServer((_request, response) => respondJson(response, 401, { error: "nope" }));
    const engine = createJevEngine(config({ baseUrl: server.baseUrl }));

    const rejected = await engine.evaluate(request());
    expect(rejected.fallbackReason).toBe("authentication_failed");
    expect(server.requests).toHaveLength(1);
    expectNoKeyLeak(rejected);

    const blocked = await engine.evaluate(request({ evaluationId: "de_blocked" }));
    expect(blocked.fallbackReason).toBe("circuit_open");
    expect(server.requests).toHaveLength(1);
  });

  it("fails with missing_credentials without dispatch when no key resolves", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const server = await startMockServer((_request, response) => respondJson(response, 200, validBody()));
    const engine = createJevEngine(config({ baseUrl: server.baseUrl, hasApiKey: false }));

    const evaluation = await engine.evaluate(request());

    expect(evaluation.fallbackReason).toBe("missing_credentials");
    expect(server.requests).toHaveLength(0);
  });
});
