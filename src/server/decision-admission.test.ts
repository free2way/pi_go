/**
 * AT-JEV-072 · the evaluate route's own concurrency admission (docs/26 §4.1,
 * docs/27 §7.8).
 *
 * `decision-routes.test.ts` is owned by another change, so the admission wiring
 * is covered here instead. These are ROUTE-level tests: `registerDecisionRoutes`
 * installs the gate (cap from `PI_DECISION_MAX_CONCURRENT`, default 4), and the
 * interesting properties are observable only through the HTTP surface —
 *
 *  - a 2×-peak burst admits exactly `cap` requests (provider calls = audit rows
 *    = `cap`) and answers the rest with HTTP 200 + `rate_limited`, with ZERO
 *    outbound calls and ZERO audit rows for the rejected ones;
 *  - an admitted request that throws still releases its slot, so the next
 *    request is admitted rather than starved;
 *  - an unset/invalid variable falls back to the documented default of 4.
 *
 * No network, no database, no Docker: the mock engine, an in-memory audit store
 * and an in-memory run store.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Finding, Run } from "../shared/types.js";
import { baseDemoRun } from "./demo-runner.js";
import type { DecisionAuditStoreLike } from "./decision-engine/audit-store.js";
import { loadDecisionEngineConfig } from "./decision-engine/config.js";
import { createDecisionEngine } from "./decision-engine/index.js";
import { buildReviewTriageBatches } from "./decision-engine/review-triage.js";
import type { DecisionEvaluationRecord } from "./decision-engine/types.js";
import {
  DECISION_EVALUATE_PATH,
  registerDecisionRoutes,
  type CreateDecisionEngine,
  type DecisionRouteDeps,
  type DecisionRunStore,
} from "./decision-routes.js";

const OWNER = "owner-admission";
/** Peak the worker can actually produce (its `PI_MAX_ACTIVE_JOBS` ceiling). */
const PEAK = 4;
const OVERLOAD = PEAK * 2;
const MOCK_ENV: NodeJS.ProcessEnv = { PI_DECISION_ENGINE: "mock", PI_JEV_MODE: "shadow" };

type EventLike = {
  runId: string;
  round: number;
  source: "system" | "developer" | "checks" | "reviewer";
  type: string;
  message: string;
  at: string;
  meta?: Record<string, unknown>;
};

function makeFindings(runId: string, count: number): Finding[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `${runId}-F${index + 1}`,
    severity: "high" as const,
    file: `src/module-${index + 1}.ts`,
    line: index + 1,
    title: `finding ${index + 1}: a review problem that must be triaged`,
    evidence: `evidence for finding ${index + 1}`,
    requiredChange: `change required for finding ${index + 1}`,
    resolved: false,
  }));
}

function makeRun(id: string): Run {
  const run = baseDemoRun(
    { title: "准入控制", task: "a sufficiently long decision admission task for token estimation", repository: "test/repo" },
    OWNER,
  );
  run.id = id;
  run.round = 2;
  run.findings = makeFindings(id, 4);
  return run;
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  engineCalls: { count: number };
  maxInFlight: { value: number };
  auditInserts: () => number;
  auditRowsFor: (runId: string) => DecisionEvaluationRecord[];
  events: EventLike[];
  warnings: Array<{ message: string; details: Record<string, unknown> }>;
}

/**
 * Builds a real Fastify app with the real `registerDecisionRoutes`. The engine is
 * the real mock engine behind a counter + a small delay, so "in flight" is
 * observable; persistence and events are in-memory fakes.
 */
async function buildApp(
  env: NodeJS.ProcessEnv,
  options: { failFirstIdempotencyLookup?: boolean } = {},
): Promise<Harness> {
  const runs = new Map<string, Run>();
  for (let index = 0; index < OVERLOAD; index += 1) {
    const run = makeRun(`run_admission_${index}`);
    runs.set(run.id, run);
  }
  const events: EventLike[] = [];
  const warnings: Harness["warnings"] = [];
  const engineCalls = { count: 0 };
  const maxInFlight = { value: 0 };
  let inFlight = 0;
  let idempotencyLookups = 0;

  const rows = new Map<string, DecisionEvaluationRecord>();
  const audit: DecisionAuditStoreLike = {
    async findByIdempotencyKey(idempotencyKey) {
      idempotencyLookups += 1;
      if (options.failFirstIdempotencyLookup && idempotencyLookups === 1) {
        throw new Error("audit store exploded after admission");
      }
      return rows.get(idempotencyKey);
    },
    async insert(record) {
      const existing = rows.get(record.idempotencyKey);
      if (existing) return { record: existing, created: false };
      rows.set(record.idempotencyKey, record);
      return { record, created: true };
    },
    async listByRun(runId, limit = 50) {
      return [...rows.values()].filter((row) => row.runId === runId).slice(0, limit);
    },
    async aggregate() {
      return { total: rows.size, byStatus: {}, byKind: {} };
    },
    async findLatestCompletedByRequestedModel(requestedModel, excludeEvaluationId) {
      return [...rows.values()].find(
        (row) => row.requestedModel === requestedModel && row.evaluationId !== excludeEvaluationId && row.status === "completed",
      );
    },
  };

  const store: DecisionRunStore = {
    getRun(id) {
      return runs.get(id);
    },
    async appendEvent(event) {
      events.push(event as EventLike);
      return event;
    },
  };

  const createEngine: CreateDecisionEngine = (config, engineDeps) => {
    const inner = createDecisionEngine(config, engineDeps);
    return {
      evaluate: async (request, signal) => {
        engineCalls.count += 1;
        inFlight += 1;
        maxInFlight.value = Math.max(maxInFlight.value, inFlight);
        try {
          // Force the admitted calls to overlap at the provider boundary, so the
          // observed peak in-flight is meaningful and not just scheduler luck.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await inner.evaluate(request, signal);
        } finally {
          inFlight -= 1;
        }
      },
    };
  };

  const deps: DecisionRouteDeps = {
    store,
    audit,
    env,
    loadConfig: (configEnv) => loadDecisionEngineConfig(configEnv),
    createEngine,
    buildBatches: (input) => buildReviewTriageBatches(input),
    internalAuthorized: () => true,
    ownerKeysFor: () => [OWNER],
    warn: (message, details) => warnings.push({ message, details }),
  };

  const app = Fastify();
  registerDecisionRoutes(app, deps);
  await app.ready();

  return {
    app,
    engineCalls,
    maxInFlight,
    auditInserts: () => rows.size,
    auditRowsFor: (runId) => [...rows.values()].filter((row) => row.runId === runId),
    events,
    warnings,
  };
}

function evaluate(app: ReturnType<typeof Fastify>, runId: string) {
  return app.inject({ method: "POST", url: DECISION_EVALUATE_PATH, payload: { runId, kind: "review_triage" } });
}

describe("AT-JEV-072 · evaluate-route concurrency admission", () => {
  it("narrows a 2× peak burst to the default cap (4): the rest fall back safely with zero outbound calls", async () => {
    const harness = await buildApp({ ...MOCK_ENV });

    const runIds = Array.from({ length: OVERLOAD }, (_value, index) => `run_admission_${index}`);
    const responses = await Promise.all(runIds.map((runId) => evaluate(harness.app, runId)));
    const bodies = responses.map((response) => response.json() as { status: string; fallbackReason?: string });

    console.log(
      `[AT-JEV-072] default-cap burst: offered=${OVERLOAD} admitted=${harness.engineCalls.count} ` +
        `rejected=${bodies.filter((body) => body.fallbackReason === "rate_limited").length} ` +
        `auditRows=${harness.auditInserts()} maxInFlight=${harness.maxInFlight.value}`,
    );

    // The cap, not the burst size, decides how much work reaches the provider.
    expect(harness.engineCalls.count).toBe(PEAK);
    expect(harness.auditInserts()).toBe(PEAK);
    expect(harness.maxInFlight.value).toBe(PEAK);

    // Split the responses by outcome and pin both halves explicitly.
    const completed = bodies.filter((body) => body.status === "completed");
    const rejected = bodies.filter((body) => body.status === "fallback" && body.fallbackReason === "rate_limited");
    expect(completed).toHaveLength(PEAK);
    expect(rejected).toHaveLength(OVERLOAD - PEAK);
    // Every response is a business-safe 200; nothing is a 5xx or a hang.
    for (const response of responses) expect(response.statusCode).toBe(200);

    // Admitted work is audited and evented exactly once; the rejected requests
    // leave NO audit row and NO event behind.
    expect(harness.events.filter((event) => event.type === "decision.completed")).toHaveLength(PEAK);
    expect(harness.events.filter((event) => event.type === "decision.requested")).toHaveLength(PEAK);
    expect(harness.events.filter((event) => event.type === "decision.fallback")).toHaveLength(0);
    expect(harness.events).toHaveLength(PEAK * 2);

    // The saturation warn is throttled: one line for the whole burst. It reports
    // the counters as observed at the first rejection, hence `rejected: 1`.
    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0]!.details).toMatchObject({ maxConcurrent: PEAK, inFlight: PEAK, rejected: 1 });
  }, 30_000);

  it("honours an explicit PI_DECISION_MAX_CONCURRENT (2)", async () => {
    const harness = await buildApp({ ...MOCK_ENV, PI_DECISION_MAX_CONCURRENT: "2" });
    const runIds = Array.from({ length: OVERLOAD }, (_value, index) => `run_admission_${index}`);
    const bodies = (await Promise.all(runIds.map((runId) => evaluate(harness.app, runId)))).map(
      (response) => response.json() as { status: string; fallbackReason?: string },
    );

    console.log(
      `[AT-JEV-072] cap=2 burst: offered=${OVERLOAD} admitted=${harness.engineCalls.count} ` +
        `rejected=${bodies.filter((body) => body.fallbackReason === "rate_limited").length} auditRows=${harness.auditInserts()}`,
    );

    expect(harness.engineCalls.count).toBe(2);
    expect(harness.auditInserts()).toBe(2);
    expect(bodies.filter((body) => body.status === "completed")).toHaveLength(2);
    expect(bodies.filter((body) => body.fallbackReason === "rate_limited")).toHaveLength(OVERLOAD - 2);
  }, 30_000);

  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["zero", "0"],
    ["non-numeric", "not-a-number"],
  ])("falls back to the default cap of 4 when the variable is %s", async (_label, value) => {
    const env: NodeJS.ProcessEnv = { ...MOCK_ENV };
    if (value !== undefined) env.PI_DECISION_MAX_CONCURRENT = value;
    const harness = await buildApp(env);
    const runIds = Array.from({ length: OVERLOAD }, (_value, index) => `run_admission_${index}`);

    await Promise.all(runIds.map((runId) => evaluate(harness.app, runId)));

    console.log(`[AT-JEV-072] default fallback (${_label}): admitted=${harness.engineCalls.count} auditRows=${harness.auditInserts()}`);
    expect(harness.engineCalls.count).toBe(PEAK);
    expect(harness.auditInserts()).toBe(PEAK);
  }, 30_000);

  it("releases the slot when an admitted request throws, so the next request is admitted", async () => {
    const harness = await buildApp({ ...MOCK_ENV, PI_DECISION_MAX_CONCURRENT: "1" }, { failFirstIdempotencyLookup: true });

    // The first request is admitted, then the audit lookup throws AFTER the slot
    // was taken: it must surface as a 500, and it must NOT keep the single slot.
    const failed = await evaluate(harness.app, "run_admission_0");
    expect(failed.statusCode).toBe(500);
    expect(harness.auditInserts()).toBe(0);

    // If the slot leaked, this second request would be `rate_limited` instead.
    const next = await evaluate(harness.app, "run_admission_1");
    expect(next.statusCode).toBe(200);
    const body = next.json() as { status: string; fallbackReason?: string };
    console.log(`[AT-JEV-072] after-throw request: status=${body.status} fallbackReason=${body.fallbackReason ?? "none"}`);
    expect(body.status).toBe("completed");
    expect(harness.auditInserts()).toBe(1);
  }, 30_000);
});
