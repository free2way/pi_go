/**
 * docs/27 §7.8 · Performance & capacity acceptance (AT-JEV-070 / 072 / 073).
 *
 * Opt-in and volume-bearing on purpose (500 evaluations, a 2×-peak burst, a
 * 100-finding batch), so it is NOT part of the default gate:
 *
 *  - the regular `vitest.config.ts` only collects `src/**` and never sees this
 *    directory;
 *  - `tests/perf/**` is collected by `vitest.perf.config.ts` only, and on top of
 *    that every suite here skips unless `PI_DECISION_PERF=1` is set.
 *
 *   PI_DECISION_PERF=1 npx vitest run --config vitest.perf.config.ts   (npm run test:decision:perf)
 *
 * NO network, NO database, NO Docker: the engine is the in-process
 * `createMockEngine` (via the real `createDecisionEngine`), the Jev overload case
 * injects a fake `fetchImpl`, and persistence is an in-memory fake of
 * `DecisionAuditStoreLike` / `DecisionRunStore` (same shape as the harness in
 * `decision-routes.test.ts`, minus pg-mem so the 500-call loop stays cheap).
 *
 * Honest limits of the evidence:
 *  - the timing measurements cover PiGO's own in-process work only (state
 *    projection + redaction + payload measurement + policy + mock engine, and for
 *    073 the full `evaluateDecisionForRun` orchestration). Real socket latency is
 *    explicitly excluded by the AT wording ("除模拟网络等待外").
 *  - the heap assertions are a leak guard, not a profiler: they are only really
 *    conclusive when V8 GC is exposed (this config passes `--expose-gc` to the
 *    worker). Without GC the threshold is deliberately wide and is documented as
 *    a weak signal.
 *  - AT-JEV-072: the decision plane has NO rate limiter and NO concurrency cap.
 *    The only internal overload protection is the Jev circuit breaker; the only
 *    global bound is the worker's own `PI_MAX_ACTIVE_JOBS`. This file pins that
 *    reality instead of inventing a limiter (see the "GAP" case).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseDemoRun } from "../../src/server/demo-runner.js";
import type { DecisionAuditStoreLike } from "../../src/server/decision-engine/audit-store.js";
import { DECISION_ENGINE_DEFAULTS, loadDecisionEngineConfig } from "../../src/server/decision-engine/config.js";
import { createDecisionEngine } from "../../src/server/decision-engine/index.js";
import { BREAKER_THRESHOLD, createJevEngine, resetDecisionCircuitBreakers } from "../../src/server/decision-engine/jev.js";
import {
  QUESTION_SUFFIXES,
  buildReviewTriageBatches,
  runReviewTriageBatches,
  type ReviewTriageInput,
} from "../../src/server/decision-engine/review-triage.js";
import type {
  DecisionEngine,
  DecisionEngineConfig,
  DecisionEvaluation,
  DecisionEvaluationRecord,
  DecisionRequest,
} from "../../src/server/decision-engine/types.js";
import {
  evaluateDecisionForRun,
  type CreateDecisionEngine,
  type DecisionRunStore,
  type DecisionRouteDeps,
} from "../../src/server/decision-routes.js";
import { RateLimiter } from "../../src/server/rate-limit.js";
import type { Finding, Run } from "../../src/shared/types.js";

const PERF_ENABLED = process.env.PI_DECISION_PERF === "1";
/** Double gate: the file lives in a separate config, and it self-skips without the flag. */
const suite = PERF_ENABLED ? describe : describe.skip;

const OWNER = "owner-perf";

/**
 * Peak concurrent DECISION evaluations a single worker can produce: the worker
 * clamps `PI_MAX_ACTIVE_JOBS` to [1, 4] (`src/worker/index.ts`) and runs at most
 * one review-triage call per active run, so 4 is the documented ceiling. The
 * capacity case runs the documented "2× peak" => 8.
 */
const PEAK_CONCURRENT_DECISIONS = 4;
const OVERLOAD_CONCURRENCY = PEAK_CONCURRENT_DECISIONS * 2;

const HEAP_LIMIT_WITH_GC_MB = 8;
const HEAP_LIMIT_WITHOUT_GC_MB = 64;

type EventLike = {
  runId: string;
  round: number;
  source: "system" | "developer" | "checks" | "reviewer";
  type: string;
  message: string;
  at: string;
  meta?: Record<string, unknown>;
};

function makeFindings(runId: string, count: number, evidence = "evidence"): Finding[] {
  const severities: Finding["severity"][] = ["critical", "high", "medium", "low"];
  return Array.from({ length: count }, (_value, index) => ({
    id: `${runId}-F${index + 1}`,
    severity: severities[index % severities.length],
    file: `src/module-${index + 1}.ts`,
    line: index + 1,
    title: `finding ${index + 1}: a review problem that must be triaged`,
    evidence: `${evidence} for finding ${index + 1}`,
    requiredChange: `change required for finding ${index + 1}`,
    resolved: false,
  }));
}

function makeRun(id: string, findingCount: number, evidence = "evidence"): Run {
  const run = baseDemoRun(
    { title: "决策性能", task: "a sufficiently long decision performance task for token estimation", repository: "test/repo" },
    OWNER,
  );
  run.id = id;
  run.round = 2;
  run.findings = makeFindings(id, findingCount, evidence);
  return run;
}

function mockConfig(overrides: Partial<DecisionEngineConfig> = {}): DecisionEngineConfig {
  return {
    engine: "mock",
    mode: "shadow",
    baseUrl: DECISION_ENGINE_DEFAULTS.baseUrl,
    model: DECISION_ENGINE_DEFAULTS.model,
    timeoutMs: DECISION_ENGINE_DEFAULTS.timeoutMs,
    maxAttempts: DECISION_ENGINE_DEFAULTS.maxAttempts,
    maxStateTokens: DECISION_ENGINE_DEFAULTS.maxStateTokens,
    maxStateBytes: DECISION_ENGINE_DEFAULTS.maxStateBytes,
    reviewMaxFindings: DECISION_ENGINE_DEFAULTS.reviewMaxFindings,
    shadowSampleRate: DECISION_ENGINE_DEFAULTS.shadowSampleRate,
    policyVersion: DECISION_ENGINE_DEFAULTS.policyVersion,
    allowSource: false,
    hasApiKey: false,
    ...overrides,
  };
}

function triageInput(
  run: Run,
  config: DecisionEngineConfig,
  evaluationId: string,
  maxFindings = config.reviewMaxFindings,
): ReviewTriageInput {
  return { run, mode: config.mode, policyVersion: config.policyVersion, maxFindings, evaluationId, timeoutMs: config.timeoutMs };
}

/** Nearest-rank percentile over an ascending array (deterministic, no interpolation). */
function percentile(ascending: number[], p: number): number {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * ascending.length) - 1;
  return ascending[Math.min(ascending.length - 1, Math.max(0, rank))];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collectGarbage(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") return false;
  gc();
  return true;
}

function heapUsedMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

interface MemoryAudit {
  store: DecisionAuditStoreLike;
  rows: Map<string, DecisionEvaluationRecord>;
  inserts(): number;
}

function createMemoryAudit(): MemoryAudit {
  const rows = new Map<string, DecisionEvaluationRecord>();
  let insertCount = 0;
  const store: DecisionAuditStoreLike = {
    async findByIdempotencyKey(idempotencyKey) {
      return rows.get(idempotencyKey);
    },
    async insert(record) {
      const existing = rows.get(record.idempotencyKey);
      if (existing) return { record: existing, created: false };
      rows.set(record.idempotencyKey, record);
      insertCount += 1;
      return { record, created: true };
    },
    async listByRun(runId, limit = 50) {
      return [...rows.values()].filter((row) => row.runId === runId).slice(0, limit);
    },
    async aggregate() {
      return { total: rows.size, byStatus: {}, byKind: {} };
    },
    async findLatestCompletedByRequestedModel(requestedModel, excludeEvaluationId) {
      const matches = [...rows.values()].filter(
        (row) => row.requestedModel === requestedModel && row.evaluationId !== excludeEvaluationId && row.status === "completed",
      );
      return matches[matches.length - 1];
    },
  };
  return { store, rows, inserts: () => insertCount };
}

interface PerfHarness {
  deps: DecisionRouteDeps;
  audit: MemoryAudit;
  events: EventLike[];
  engineCalls: { count: number };
}

/** In-memory decision-route harness: real config loading, real batch builder, fake persistence. */
function createHarness(
  runs: Run[],
  options: { env?: NodeJS.ProcessEnv; createEngine?: CreateDecisionEngine } = {},
): PerfHarness {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const audit = createMemoryAudit();
  const events: EventLike[] = [];
  const engineCalls = { count: 0 };
  const store: DecisionRunStore = {
    getRun(id) {
      return byId.get(id);
    },
    async appendEvent(event) {
      events.push(event as EventLike);
      return event;
    },
  };
  const createEngine: CreateDecisionEngine =
    options.createEngine ??
    ((config, engineDeps) => {
      const inner = createDecisionEngine(config, engineDeps);
      return {
        evaluate: (request, signal) => {
          engineCalls.count += 1;
          return inner.evaluate(request, signal);
        },
      };
    });
  const deps: DecisionRouteDeps = {
    store,
    audit: audit.store,
    env: options.env ?? { PI_DECISION_ENGINE: "mock", PI_JEV_MODE: "shadow" },
    loadConfig: (env) => loadDecisionEngineConfig(env),
    createEngine,
    buildBatches: (input) => buildReviewTriageBatches(input),
    internalAuthorized: () => true,
    ownerKeysFor: () => [OWNER],
  };
  return { deps, audit, events, engineCalls };
}

function fallbackEvaluation(
  request: DecisionRequest,
  config: DecisionEngineConfig,
  reason: DecisionEvaluation["fallbackReason"],
): DecisionEvaluation {
  return {
    evaluationId: request.evaluationId,
    runId: request.runId,
    kind: request.kind,
    mode: request.mode,
    provider: "mock",
    requestedModel: config.model,
    policyVersion: request.policyVersion,
    stateHash: request.stateHash,
    status: "fallback",
    answers: [],
    fallbackReason: reason,
    detail: `synthetic ${reason}`,
    latencyMs: 0,
    createdAt: new Date().toISOString(),
  };
}

/** Asserts the 404 branch never appears and narrows the union for the caller. */
function completed(result: Awaited<ReturnType<typeof evaluateDecisionForRun>>) {
  if (result.status !== 200) throw new Error(`unexpected status ${result.status}`);
  return result.body;
}

suite("AT-JEV-070 · mock evaluation overhead (docs/27 §7.8)", () => {
  it("[AT-JEV-070] 500 local mock evaluations: PiGO p95 processing overhead ≤ 50 ms", async () => {
    const WARMUP = 50;
    const N = 500;
    const run = makeRun("run_perf_070", 5);
    const config = mockConfig();
    const engine = createDecisionEngine(config);

    const measureOnce = async (index: number): Promise<number> => {
      const started = performance.now();
      const [batch] = buildReviewTriageBatches(triageInput(run, config, `de_perf_070_${index}`));
      const evaluation = await engine.evaluate(batch.request);
      // A sample only counts if it was a real evaluation, never a skip.
      if (evaluation.status !== "completed") throw new Error(`unexpected status ${evaluation.status}`);
      return performance.now() - started;
    };

    for (let index = 0; index < WARMUP; index += 1) await measureOnce(index);

    const samples: number[] = [];
    for (let index = 0; index < N; index += 1) samples.push(await measureOnce(WARMUP + index));
    samples.sort((a, b) => a - b);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const p99 = percentile(samples, 99);
    const max = samples[samples.length - 1];
    console.log(
      `[AT-JEV-070] n=${N} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms`,
    );

    // Documented budget (docs/27 §7.8): 50 ms. Deliberately NOT relaxed to hide a miss.
    expect(p95).toBeLessThanOrEqual(50);
    expect(p50).toBeLessThanOrEqual(50);
  }, 120_000);

  it("[AT-JEV-070] 500 evaluations show no unbounded heap growth", async () => {
    const run = makeRun("run_perf_070_heap", 5);
    const config = mockConfig();
    const engine = createDecisionEngine(config);

    const iterate = async (index: number): Promise<DecisionEvaluation> => {
      const [batch] = buildReviewTriageBatches(triageInput(run, config, `de_perf_070_heap_${index}`));
      return engine.evaluate(batch.request);
    };

    // Reach steady state first so the measurement is not dominated by lazy init.
    for (let index = 0; index < 100; index += 1) await iterate(index);

    const gcAvailable = collectGarbage();
    const before = heapUsedMb();
    let sink: DecisionEvaluation[] = [];
    for (let index = 0; index < 500; index += 1) {
      sink.push(await iterate(1000 + index));
      // The sink itself is bounded: we measure the decision path, not the test's retention.
      if (sink.length > 10) sink = sink.slice(-10);
    }
    collectGarbage();
    const delta = heapUsedMb() - before;
    const limit = gcAvailable ? HEAP_LIMIT_WITH_GC_MB : HEAP_LIMIT_WITHOUT_GC_MB;
    console.log(
      `[AT-JEV-070] heap delta=${delta.toFixed(2)}MiB gcAvailable=${gcAvailable} limit=${limit}MiB sink=${sink.length}`,
    );

    // Reliable only with GC exposed (vitest.perf.config.ts passes --expose-gc);
    // without it this is a coarse "no runaway growth" guard, documented as such.
    expect(delta).toBeLessThanOrEqual(limit);
  }, 120_000);
});

suite("AT-JEV-072 · concurrency and rate limiting (docs/27 §7.8)", () => {
  beforeEach(() => {
    resetDecisionCircuitBreakers();
  });

  afterEach(() => {
    resetDecisionCircuitBreakers();
    delete process.env.PI_JEV_MOCK_FAILURE;
  });

  it("[AT-JEV-072] 2× peak concurrent mock evaluations all complete, with no throughput collapse", async () => {
    // Baseline runs and overload runs are distinct: idempotency must not turn the
    // concurrent pass into a cache read.
    const runs = Array.from({ length: OVERLOAD_CONCURRENCY * 2 }, (_value, index) => makeRun(`run_perf_072_${index}`, 4));
    const baselineRuns = runs.slice(0, OVERLOAD_CONCURRENCY);
    const overloadRuns = runs.slice(OVERLOAD_CONCURRENCY);
    const harness = createHarness(runs);

    const baseline: number[] = [];
    for (const run of baselineRuns) {
      const started = performance.now();
      const body = completed(await evaluateDecisionForRun({ runId: run.id, kind: "review_triage" }, harness.deps));
      baseline.push(performance.now() - started);
      expect(body.status).toBe("completed");
    }

    const concurrent: number[] = [];
    await Promise.all(
      overloadRuns.map(async (run) => {
        const started = performance.now();
        const body = completed(await evaluateDecisionForRun({ runId: run.id, kind: "review_triage" }, harness.deps));
        concurrent.push(performance.now() - started);
        expect(body.status).toBe("completed");
      }),
    );

    concurrent.sort((a, b) => a - b);
    const baselineMean = mean(baseline);
    const concurrencyP50 = percentile(concurrent, 50);
    const concurrencyP95 = percentile(concurrent, 95);
    console.log(
      `[AT-JEV-072] baseline(n=${baseline.length}) mean=${baselineMean.toFixed(2)}ms | ` +
        `concurrent(n=${OVERLOAD_CONCURRENCY}) p50=${concurrencyP50.toFixed(2)}ms p95=${concurrencyP95.toFixed(2)}ms`,
    );

    // Nothing is lost or thrown away: one audit row and one outcome event pair per
    // run, both under baseline and under 2× peak.
    expect(harness.audit.inserts()).toBe(runs.length);
    expect(harness.engineCalls.count).toBe(runs.length);
    expect(harness.events.filter((event) => event.type === "decision.completed")).toHaveLength(runs.length);
    expect(harness.events.filter((event) => event.type === "decision.fallback")).toHaveLength(0);

    // Loose but real ceilings: an evaluation stays in the documented 50 ms budget,
    // and 2× peak must not cost more than 5× the sequential mean.
    expect(concurrencyP95).toBeLessThanOrEqual(50);
    expect(concurrencyP95).toBeLessThanOrEqual(Math.max(50, baselineMean * 5));
  }, 120_000);

  it("[AT-JEV-072] overloaded (rate-limited) evaluations fall back safely and are still audited", async () => {
    const runs = Array.from({ length: OVERLOAD_CONCURRENCY }, (_value, index) => makeRun(`run_perf_072_overload_${index}`, 4));
    // The mock engine's documented failure injection: the provider answers 429.
    process.env.PI_JEV_MOCK_FAILURE = "rate_limited";
    const harness = createHarness(runs);

    const bodies = (
      await Promise.all(runs.map((run) => evaluateDecisionForRun({ runId: run.id, kind: "review_triage" }, harness.deps)))
    ).map((result) => completed(result));

    for (const body of bodies) {
      expect(body.status).toBe("fallback");
      expect(body.fallbackReason).toBe("rate_limited");
      expect(body.answers).toEqual([]);
    }
    // The overload was absorbed, not dropped: every evaluation is recorded exactly once.
    expect(harness.audit.inserts()).toBe(OVERLOAD_CONCURRENCY);
    expect(harness.events.filter((event) => event.type === "decision.fallback")).toHaveLength(OVERLOAD_CONCURRENCY);
    expect(harness.events.filter((event) => event.type === "decision.completed")).toHaveLength(0);
  }, 120_000);

  it("[AT-JEV-072] the decision plane's only overload protection is the circuit breaker: once tripped, overload short-circuits with zero outbound calls", async () => {
    let dispatches = 0;
    const fetchImpl: typeof fetch = async () => {
      dispatches += 1;
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    };
    const config = mockConfig({ engine: "jev", hasApiKey: true, maxAttempts: 1 });
    const engine = createJevEngine(config, { fetchImpl, resolveApiKey: () => "sk-DUMMY-perf-key" });
    const run = makeRun("run_perf_072_breaker", 2);
    const [batch] = buildReviewTriageBatches(triageInput(run, config, "de_perf_072_breaker"));

    for (let index = 0; index < BREAKER_THRESHOLD; index += 1) {
      const evaluation = await engine.evaluate(batch.request);
      expect(evaluation.status).toBe("fallback");
      expect(evaluation.fallbackReason).toBe("rate_limited");
    }
    const afterTrip = dispatches;
    expect(afterTrip).toBe(BREAKER_THRESHOLD);

    // 2× peak arrives while the provider is down: every call must be answered from
    // the open breaker, and none may touch the provider.
    const burst = await Promise.all(Array.from({ length: OVERLOAD_CONCURRENCY }, () => engine.evaluate(batch.request)));
    for (const evaluation of burst) {
      expect(evaluation.status).toBe("fallback");
      expect(evaluation.fallbackReason).toBe("circuit_open");
    }
    expect(dispatches).toBe(afterTrip);
    console.log(
      `[AT-JEV-072] breaker threshold=${BREAKER_THRESHOLD} dispatches=${dispatches} overloadShortCircuited=${burst.length}`,
    );
  }, 120_000);

  it("[AT-JEV-072] the repo's internal RateLimiter rejects 2× peak safely — but is NOT wired to the decision plane", () => {
    // This is the repo's ONLY real request-rate limiter (`src/server/rate-limit.ts`):
    // it bounds credential writes, run creation and run actions in `index.ts`. The
    // decision plane does not use it — see the "GAP" case below.
    const limiter = new RateLimiter(PEAK_CONCURRENT_DECISIONS, 60_000);
    const now = 1_000_000;
    const decisions = Array.from({ length: OVERLOAD_CONCURRENCY }, () => limiter.check("owner-perf", now));

    const allowed = decisions.filter((decision) => decision.allowed);
    const rejected = decisions.filter((decision) => !decision.allowed);
    expect(allowed).toHaveLength(PEAK_CONCURRENT_DECISIONS);
    expect(rejected).toHaveLength(OVERLOAD_CONCURRENCY - PEAK_CONCURRENT_DECISIONS);
    for (const decision of rejected) {
      expect(decision.remaining).toBe(0);
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    }
    console.log(
      `[AT-JEV-072] RateLimiter limit=${PEAK_CONCURRENT_DECISIONS} offered=${OVERLOAD_CONCURRENCY} allowed=${allowed.length} rejected=${rejected.length}`,
    );
  });

  it("[AT-JEV-072] GAP · the decision plane has no concurrency cap: a 2× peak burst actually reaches the engine", async () => {
    // Documents the gap honestly instead of inventing a limiter: with N concurrent
    // evaluations there is no internal queue/limit, so N engine calls are made in
    // parallel. If a decision-plane limiter is ever added, this assertion (and the
    // §8.1 wording) must be updated — that is the point of pinning it.
    const runs = Array.from({ length: OVERLOAD_CONCURRENCY }, (_value, index) => makeRun(`run_perf_072_gap_${index}`, 2));
    let inFlight = 0;
    let maxInFlight = 0;
    const createEngine: CreateDecisionEngine = (config, engineDeps) => {
      const inner = createDecisionEngine(config, engineDeps);
      return {
        evaluate: async (request, signal) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await inner.evaluate(request, signal);
          } finally {
            inFlight -= 1;
          }
        },
      };
    };
    const harness = createHarness(runs, { createEngine });

    const bodies = (
      await Promise.all(runs.map((run) => evaluateDecisionForRun({ runId: run.id, kind: "review_triage" }, harness.deps)))
    ).map((result) => completed(result));

    expect(bodies.every((body) => body.status === "completed")).toBe(true);
    expect(maxInFlight).toBe(OVERLOAD_CONCURRENCY);
    console.log(
      `[AT-JEV-072] gap probe: burst=${OVERLOAD_CONCURRENCY} observedMaxInFlight=${maxInFlight} (no decision-plane limiter)`,
    );
  }, 120_000);
});

suite("AT-JEV-073 · large finding set batch processing (docs/27 §7.8)", () => {
  it("[AT-JEV-073] 100 findings: bounded audit writes, complete coverage, 4 questions per finding", async () => {
    const run = makeRun("run_perf_073", 100);
    const maxFindings = 50;
    const harness = createHarness([run], {
      env: { PI_DECISION_ENGINE: "mock", PI_JEV_MODE: "shadow", PI_JEV_REVIEW_MAX_FINDINGS: String(maxFindings) },
    });

    const gcAvailable = collectGarbage();
    const before = heapUsedMb();
    const started = performance.now();
    const body = completed(await evaluateDecisionForRun({ runId: run.id, kind: "review_triage" }, harness.deps));
    const elapsed = performance.now() - started;
    collectGarbage();
    const heapDelta = heapUsedMb() - before;

    const batches = body.batches ?? [];
    const expectedBatches = Math.ceil(100 / maxFindings);
    console.log(
      `[AT-JEV-073] findings=100 maxFindings=${maxFindings} batches=${batches.length} ` +
        `engineCalls=${harness.engineCalls.count} auditRows=${harness.audit.inserts()} ` +
        `elapsed=${elapsed.toFixed(1)}ms heapDelta=${heapDelta.toFixed(2)}MiB gc=${gcAvailable}`,
    );

    // Batch plan == the documented ceiling for this knob (no payload split here).
    expect(batches).toHaveLength(expectedBatches);
    // One external request per payload-safe batch, and one audit write per batch.
    expect(harness.engineCalls.count).toBe(expectedBatches);
    expect(harness.audit.inserts()).toBe(expectedBatches);
    expect(harness.events).toHaveLength(expectedBatches * 2);
    // Batches are traceable: the route re-derives one content-derived id per batch
    // (docs/26 §8.3), so every batch has a distinct `de_<hash>` id.
    expect(new Set(batches.map((batch) => batch.evaluationId)).size).toBe(expectedBatches);
    for (const batch of batches) expect(batch.evaluationId).toMatch(/^de_[0-9a-f]{32}$/);

    // The fixed template: exactly 4 questions per finding, all 100 findings covered
    // exactly once (400 unique, well-formed question ids).
    const questionIds = batches.flatMap((batch) => (batch.answers ?? []).map((answer) => answer.questionId));
    expect(questionIds).toHaveLength(400);
    expect(new Set(questionIds).size).toBe(400);
    const suffixes = QUESTION_SUFFIXES.map((suffix) => suffix as string);
    const questionIdPattern = new RegExp("^f_[0-9a-f]{12}_(" + suffixes.join("|") + ")$");
    for (const questionId of questionIds) expect(questionId).toMatch(questionIdPattern);
    for (const suffix of suffixes) {
      expect(questionIds.filter((questionId) => questionId.endsWith(`_${suffix}`))).toHaveLength(100);
    }

    expect(elapsed).toBeLessThan(5_000);
    expect(heapDelta).toBeLessThanOrEqual(gcAvailable ? HEAP_LIMIT_WITH_GC_MB : HEAP_LIMIT_WITHOUT_GC_MB);
  }, 120_000);

  it("[AT-JEV-073] PI_JEV_REVIEW_MAX_FINDINGS is honoured, coverage is complete and no batch exceeds the cap", () => {
    const run = makeRun("run_perf_073_plan", 100);
    const config = mockConfig();
    // `maxFindings` is the initial chunk size of `buildReviewTriageBatches`; a chunk
    // that still exceeds the payload budget is split again (see the next test),
    // and a batch never exceeds `maxFindings`.
    const cases: Array<{ maxFindings: number; expected: number }> = [
      { maxFindings: 50, expected: 2 },
      { maxFindings: 25, expected: 4 },
      { maxFindings: 10, expected: 10 },
      { maxFindings: 100, expected: 1 },
    ];

    for (const { maxFindings, expected } of cases) {
      const batches = buildReviewTriageBatches(triageInput(run, config, `de_perf_073_${maxFindings}`, maxFindings));
      const keyCounts = batches.map((batch) => batch.findingKeys.length);
      const keys = batches.flatMap((batch) => batch.findingKeys);
      const questionIds = batches.flatMap((batch) => Object.keys(batch.request.questions));
      console.log(
        `[AT-JEV-073] maxFindings=${maxFindings} batches=${batches.length} keysPerBatch=${keyCounts.join(",")} ` +
          `requests=${batches.filter((batch) => batch.withinLimits).length}`,
      );

      expect(batches).toHaveLength(expected);
      expect(batches.filter((batch) => batch.withinLimits)).toHaveLength(expected);
      // Design ceiling: never more external requests than findings, never fewer than
      // one chunk per `maxFindings`, and never a batch larger than the cap.
      expect(batches.length).toBeLessThanOrEqual(100);
      expect(batches.length).toBeGreaterThanOrEqual(Math.ceil(100 / maxFindings));
      for (const batch of batches) expect(batch.findingKeys.length).toBeLessThanOrEqual(maxFindings);
      // Complete, duplicate-free coverage of all 100 findings.
      expect(keys).toHaveLength(100);
      expect(new Set(keys).size).toBe(100);
      // Batch ids from the builder are unique and, when a review splits, carry the
      // 1-based batch index (the route re-derives its own ids; see the first test).
      expect(new Set(batches.map((batch) => batch.evaluationId)).size).toBe(batches.length);
      if (batches.length > 1) {
        for (const batch of batches) expect(batch.evaluationId).toMatch(/-b\d{2}$/);
      }
      // Exactly 4 fixed questions per finding, in every batch.
      expect(questionIds).toHaveLength(400);
      expect(new Set(questionIds).size).toBe(400);
      for (const batch of batches) {
        expect(Object.keys(batch.request.questions)).toHaveLength(batch.findingKeys.length * QUESTION_SUFFIXES.length);
      }
    }
  });

  it("[AT-JEV-073] a chunk that exceeds the payload budget is split again — still within limits and never truncated", () => {
    // Long CJK excerpts (capped at 300 chars per field by `redactExcerpt`) push 100
    // findings past the state token budget when they are one chunk.
    const run = makeRun("run_perf_073_split", 100, "证据".repeat(200));
    const config = mockConfig();
    const batches = buildReviewTriageBatches(triageInput(run, config, "de_perf_073_split", 100));
    const keys = batches.flatMap((batch) => batch.findingKeys);
    console.log(
      `[AT-JEV-073] payload-split chunk=100 batches=${batches.length} keysPerBatch=${batches
        .map((batch) => batch.findingKeys.length)
        .join(",")} tokens=${batches.map((batch) => batch.measurement.tokens).join(",")}`,
    );

    // ceil(100/100) = 1, so a higher count can only come from the payload split.
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.withinLimits)).toBe(true);
    expect(keys).toHaveLength(100);
    expect(new Set(keys).size).toBe(100);
    for (const batch of batches) {
      expect(batch.findingKeys.length).toBeLessThanOrEqual(100);
      expect(batch.measurement.tokens).toBeLessThanOrEqual(DECISION_ENGINE_DEFAULTS.maxStateTokens);
      expect(batch.measurement.bytes).toBeLessThanOrEqual(DECISION_ENGINE_DEFAULTS.maxStateBytes);
    }
  });

  it("[AT-JEV-073] an over-limit batch is reported and NEVER dispatched (external requests stay bounded)", async () => {
    const run = makeRun("run_perf_073_reject", 100);
    const config = mockConfig();
    // Force every batch over the byte budget: the builder must split down to single
    // findings and then report them as rejected rather than truncate or send.
    const batches = buildReviewTriageBatches(triageInput(run, config, "de_perf_073_reject"), { maxBytes: 1 });
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((batch) => !batch.withinLimits)).toBe(true);

    let calls = 0;
    const engine: DecisionEngine = {
      evaluate: async (request) => {
        calls += 1;
        return fallbackEvaluation(request, config, "rate_limited");
      },
    };
    const result = await runReviewTriageBatches({ batches, engine });
    console.log(`[AT-JEV-073] over-limit batches=${batches.length} skipped=${result.skipped.length} externalRequests=${calls}`);

    expect(calls).toBe(0);
    expect(result.skipped).toHaveLength(batches.length);
    expect(result.outcomes).toHaveLength(0);
    expect(result.failures.every((failure) => failure.reason === "payload_rejected")).toBe(true);
  });
});
