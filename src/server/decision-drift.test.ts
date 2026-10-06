import { timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../shared/types.js";
import type { Alert } from "./alerts.js";
import { DecisionAuditStore, type DecisionAuditStoreLike } from "./decision-engine/audit-store.js";
import type {
  DecisionEngine,
  DecisionEngineConfig,
  DecisionEvaluation,
  DecisionEvaluationRecord,
  DecisionRequest,
} from "./decision-engine/types.js";
import type { ReviewTriageBatch, ReviewTriageInput } from "./decision-engine/review-triage.js";
import {
  DECISION_EVALUATE_PATH,
  registerDecisionRoutes,
  type DecisionRouteDeps,
} from "./decision-routes.js";
import { baseDemoRun } from "./demo-runner.js";
import { RunStore } from "./store.js";
import { createTestDb } from "./test-db.js";

/**
 * docs/27 §7.9 · AT-JEV-081: `jev-latest` starts resolving to a new model
 * version.
 *
 * Expected: an alert per alias drift; historical metrics stay separated by
 * resolved model; the alias keeps its (possibly shadow) behaviour.
 *
 * Everything runs in-process with the real `DecisionAuditStore` over pg-mem (so
 * the drift baseline query is the production SQL), an injected fake engine and
 * an injected alert sink — no network, no provider, no Docker.
 *
 * This file is deliberately separate from `decision-routes.test.ts` (the
 * AT-JEV-081 cases are additive and that file is owned by another change).
 */

const INTERNAL_TOKEN = "internal-worker-token-for-tests";
const OWNER = "owner-a";
const HARNESS_ENV_KEY = "sk-DUMMY-HARNESS-PLATFORM-KEY-0123456789";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Mirrors `safeSecretMatch` in index.ts; the guard is injected, never global auth. */
function bearerMatches(value: string | undefined, secret: string) {
  if (!value || !secret) return false;
  const actual = Buffer.from(value.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function testConfig(overrides: Partial<DecisionEngineConfig> = {}): DecisionEngineConfig {
  return {
    engine: "jev",
    mode: "shadow",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    timeoutMs: 3000,
    maxAttempts: 2,
    maxStateTokens: 24000,
    maxStateBytes: 262144,
    reviewMaxFindings: 50,
    shadowSampleRate: 1,
    policyVersion: "review-triage-v1",
    allowSource: false,
    hasApiKey: true,
    ...overrides,
  };
}

const FAKE_MEASUREMENT = { stateTokens: 12, longestQuestionTokens: 8, tokens: 20, bytes: 240 };

/** One payload-safe batch whose `stateHash` decides the evaluation id. */
function fakeBatch(input: ReviewTriageInput, stateHash: string): ReviewTriageBatch {
  const request: DecisionRequest = {
    evaluationId: input.evaluationId,
    runId: input.run.id,
    kind: "review_triage",
    mode: input.mode,
    policyVersion: input.policyVersion,
    stateHash,
    state: { run: { taskSummary: "drift test", locale: "zh-CN" } },
    questions: {
      f_01_security_impact: { type: "choice", prompt: "安全影响？", options: ["none", "possible", "material"] },
    },
    timeoutMs: input.timeoutMs,
  };
  return { evaluationId: request.evaluationId, request, withinLimits: true, measurement: FAKE_MEASUREMENT, findingKeys: ["f_01"] };
}

function completedEvaluation(request: DecisionRequest, resolvedModel: string): DecisionEvaluation {
  return {
    evaluationId: request.evaluationId,
    runId: request.runId,
    kind: request.kind,
    mode: request.mode,
    provider: "typesafe",
    requestedModel: "jev-latest",
    resolvedModel,
    policyVersion: request.policyVersion,
    stateHash: request.stateHash,
    status: "completed",
    answers: [],
    latencyMs: 183,
    inputTokens: 10,
    outputTokens: 2,
    createdAt: "2026-10-06T12:00:00.000Z",
  };
}

/** The drift baseline query always fails; every other store method stays real. */
class ThrowingDriftQueryAudit extends DecisionAuditStore {
  override async findLatestCompletedByRequestedModel(): Promise<DecisionEvaluationRecord | undefined> {
    throw new Error("drift baseline query unavailable");
  }
}

interface Harness {
  run: Run;
  audit: DecisionAuditStoreLike;
  engineCalls: DecisionRequest[];
  evaluate(): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>;
}

async function harness(options: {
  /** One per `buildBatches` call — distinct values make distinct evaluations. */
  stateHashes?: string[];
  /** One per provider call: the `resolved_model` each evaluation reports. */
  resolvedModels?: string[];
  raiseAlert?: (alert: Alert) => void;
  /** Makes the AT-JEV-081 baseline query throw. */
  driftQueryThrows?: boolean;
} = {}): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "pigo-decision-drift-"));
  directories.push(directory);
  const store = new RunStore(path.join(directory, "runs.json"));
  await store.init();
  const run = baseDemoRun(
    { title: "漂移", task: "A sufficiently long model drift test task", repository: "test/repo" },
    OWNER,
  );
  await store.createRun(run, {
    runId: run.id,
    round: 1,
    source: "system",
    type: "run.created",
    message: "created",
    at: new Date().toISOString(),
  });

  const db = await createTestDb();
  const audit: DecisionAuditStoreLike = options.driftQueryThrows
    ? new ThrowingDriftQueryAudit(db)
    : new DecisionAuditStore(db);

  const engineCalls: DecisionRequest[] = [];
  const stateHashes = [...(options.stateHashes ?? [])];
  const resolvedModels = [...(options.resolvedModels ?? [])];
  let batchCount = 0;

  const engine: DecisionEngine = {
    evaluate: async (request) => {
      engineCalls.push(request);
      return completedEvaluation(request, resolvedModels.shift() ?? "jev-1.13.0");
    },
  };

  const deps: DecisionRouteDeps = {
    store,
    audit,
    env: { TYPESAFE_API_KEY: HARNESS_ENV_KEY },
    loadConfig: () => ({ ok: true, config: testConfig() }),
    createEngine: () => engine,
    buildBatches: (input) => [fakeBatch(input, stateHashes.shift() ?? `state-${batchCount++}`)],
    internalAuthorized: (request) => bearerMatches(request.headers.authorization, INTERNAL_TOKEN),
    ownerKeysFor: () => [OWNER],
    now: () => new Date("2026-10-06T00:00:00.000Z"),
    ...(options.raiseAlert ? { raiseAlert: options.raiseAlert } : {}),
  };

  const app = Fastify();
  registerDecisionRoutes(app, deps);
  await app.ready();

  return {
    run,
    audit,
    engineCalls,
    evaluate: () =>
      app.inject({
        method: "POST",
        url: DECISION_EVALUATE_PATH,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: { runId: run.id, kind: "review_triage" },
      }),
  };
}

async function totalRows(audit: DecisionAuditStoreLike) {
  return (await audit.aggregate()).total;
}

describe("AT-JEV-081 model alias drift", () => {
  it("does not alert on the first observation of an alias (no baseline row)", async () => {
    const alerts: Alert[] = [];
    const h = await harness({ stateHashes: ["a"], resolvedModels: ["jev-1.13.0"], raiseAlert: (a) => alerts.push(a) });

    const response = await h.evaluate();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", requestedModel: "jev-latest", resolvedModel: "jev-1.13.0" });
    expect(alerts).toHaveLength(0);
    expect(await totalRows(h.audit)).toBe(1);
  });

  it("does not alert when the alias keeps resolving to the same version", async () => {
    const alerts: Alert[] = [];
    const h = await harness({
      stateHashes: ["a", "b"],
      resolvedModels: ["jev-1.13.0", "jev-1.13.0"],
      raiseAlert: (a) => alerts.push(a),
    });

    expect((await h.evaluate()).statusCode).toBe(200);
    expect((await h.evaluate()).statusCode).toBe(200);

    expect(alerts).toHaveLength(0);
    expect(await totalRows(h.audit)).toBe(2);
  });

  it("raises exactly one warning when the alias starts resolving to a new version", async () => {
    const alerts: Alert[] = [];
    const h = await harness({
      stateHashes: ["a", "b"],
      resolvedModels: ["jev-1.12.0", "jev-1.13.0"],
      raiseAlert: (a) => alerts.push(a),
    });

    const first = await h.evaluate();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ resolvedModel: "jev-1.12.0", status: "completed" });
    // First observation: no baseline yet.
    expect(alerts).toHaveLength(0);

    const second = await h.evaluate();
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { evaluationId: string; resolvedModel: string };
    expect(secondBody.resolvedModel).toBe("jev-1.13.0");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      key: "jev_model_drift",
      severity: "warning",
      message: "Jev 模型别名漂移：jev-latest 由 jev-1.12.0 变为 jev-1.13.0",
      details: {
        requestedModel: "jev-latest",
        previousResolvedModel: "jev-1.12.0",
        resolvedModel: "jev-1.13.0",
        evaluationId: secondBody.evaluationId,
        at: "2026-10-06T00:00:00.000Z",
      },
    });
    // No secret and no outbound payload may leak into the alert.
    expect(JSON.stringify(alerts[0])).not.toContain(HARNESS_ENV_KEY);
    expect(JSON.stringify(alerts[0])).not.toContain("taskSummary");
    expect(await totalRows(h.audit)).toBe(2);
  });

  it("does not alert or persist twice on an idempotent replay of the drifted evaluation", async () => {
    const alerts: Alert[] = [];
    const h = await harness({
      // Third request reuses the second state hash → same evaluation id.
      stateHashes: ["a", "b", "b"],
      resolvedModels: ["jev-1.12.0", "jev-1.13.0"],
      raiseAlert: (a) => alerts.push(a),
    });

    const first = await h.evaluate();
    const drifted = await h.evaluate();
    expect(alerts).toHaveLength(1);

    const replay = await h.evaluate();
    expect(replay.statusCode).toBe(200);
    // The replay returns the stored row (same evaluation id) without re-raising:
    // the drift query would otherwise see jev-1.12.0 as the previous version.
    expect((replay.json() as { evaluationId: string }).evaluationId).toBe(
      (drifted.json() as { evaluationId: string }).evaluationId,
    );
    expect((first.json() as { evaluationId: string }).evaluationId).not.toBe(
      (drifted.json() as { evaluationId: string }).evaluationId,
    );
    expect(alerts).toHaveLength(1);
    expect(h.engineCalls).toHaveLength(2);
    expect(await totalRows(h.audit)).toBe(2);
  });

  it("is a silent no-op when no alert sink is injected", async () => {
    const h = await harness({ stateHashes: ["a", "b"], resolvedModels: ["jev-1.12.0", "jev-1.13.0"] });

    expect((await h.evaluate()).statusCode).toBe(200);
    const drifted = await h.evaluate();

    expect(drifted.statusCode).toBe(200);
    expect(drifted.json()).toMatchObject({ status: "completed", resolvedModel: "jev-1.13.0" });
    expect(await totalRows(h.audit)).toBe(2);
  });

  it("still returns and persists the evaluation when the drift baseline query fails", async () => {
    const alerts: Alert[] = [];
    const h = await harness({
      stateHashes: ["a", "b"],
      resolvedModels: ["jev-1.12.0", "jev-1.13.0"],
      raiseAlert: (a) => alerts.push(a),
      driftQueryThrows: true,
    });

    const first = await h.evaluate();
    const second = await h.evaluate();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "completed", resolvedModel: "jev-1.13.0" });
    expect(alerts).toHaveLength(0);
    expect(await totalRows(h.audit)).toBe(2);
  });
});
