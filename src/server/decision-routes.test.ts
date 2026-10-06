import { timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../shared/types.js";
import { DecisionAuditStore } from "./decision-engine/audit-store.js";
import { loadDecisionEngineConfig } from "./decision-engine/config.js";
import { createDecisionEngine } from "./decision-engine/index.js";
import { resetDecisionCircuitBreakers } from "./decision-engine/jev.js";
import { buildReviewTriageBatches, type ReviewTriageBatch, type ReviewTriageInput } from "./decision-engine/review-triage.js";
import type {
  DecisionEngine,
  DecisionEngineConfig,
  DecisionEvaluation,
  DecisionRequest,
} from "./decision-engine/types.js";
import {
  batchEvaluationId,
  DECISION_EVALUATE_PATH,
  decisionEngineStatus,
  deriveEvaluationId,
  registerDecisionRoutes,
  type BuildDecisionBatches,
  type DecisionConfigLoad,
  type DecisionRouteDeps,
} from "./decision-routes.js";
import { baseDemoRun } from "./demo-runner.js";
import { RunStore } from "./store.js";
import { createTestDb } from "./test-db.js";

/**
 * docs/26 §8/§13 · decision-plane persistence, internal evaluate API, query API
 * and config-status projection.
 *
 * Everything runs in-process: a real `RunStore` (temp JSON), the real
 * `DecisionAuditStore` over pg-mem (which also exercises migration 15), an
 * injected fake engine/config loader/request builder and Fastify `inject` — no
 * network, no provider, no Docker.
 */

const INTERNAL_TOKEN = "internal-worker-token-for-tests";
const OWNER = "owner-a";
/** A credential and a raw-state marker that must never reach a response or a row. */
const FAKE_KEY = "sk-DUMMY-DO-NOT-LEAK-0123456789abcdef";
/**
 * The harness's default platform key. `testConfig()` reports `hasApiKey: true`,
 * so the env must actually resolve one; a test that exercises vault-only or
 * "nothing resolves" passes its own `env` explicitly.
 */
const HARNESS_ENV_KEY = "sk-DUMMY-HARNESS-PLATFORM-KEY-0123456789";
const RAW_STATE_MARKER = "SECRET-DIFF-SNIPPET-DO-NOT-LEAK";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * Mirrors `safeSecretMatch` in index.ts — the production wiring passes
 * `safeTokenMatch`; the guard is injected so a browser session (cookie/JWT, no
 * worker bearer token) can never satisfy it.
 */
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

const STATE_HASH = "f".repeat(64);
/** A realistic outbound request whose state carries content that must never be persisted. */
function fakeBuildRequest(input: ReviewTriageInput): DecisionRequest {
  return {
    evaluationId: input.evaluationId,
    runId: input.run.id,
    kind: "review_triage",
    mode: input.mode,
    policyVersion: input.policyVersion,
    stateHash: STATE_HASH,
    state: {
      run: { taskSummary: RAW_STATE_MARKER, locale: "zh-CN" },
      findings: [{ key: "f_01", severity: "high", evidenceExcerpt: FAKE_KEY }],
    },
    questions: {
      f_01_security_impact: { type: "choice", prompt: "安全影响？", options: ["none", "possible", "material"] },
    },
    timeoutMs: input.timeoutMs,
  };
}

/** Only `withinLimits`/`request`/`detail` are read by the route; the measurement is inert. */
const FAKE_MEASUREMENT = { stateTokens: 12, longestQuestionTokens: 8, tokens: 20, bytes: 240 };

/** Wraps the fake single request as the one payload-safe batch of a review. */
function fakeBatch(request: DecisionRequest, overrides: Partial<ReviewTriageBatch> = {}): ReviewTriageBatch {
  return { evaluationId: request.evaluationId, request, withinLimits: true, measurement: FAKE_MEASUREMENT, findingKeys: ["f_01"], ...overrides };
}

/** N distinct unresolved findings (severity then stable key order is deterministic). */
function manyFindings(count: number) {
  const severities: Array<"critical" | "high" | "medium" | "low"> = ["critical", "high", "medium", "low"];
  return Array.from({ length: count }, (_value, index) => ({
    id: `F${index + 1}`,
    severity: severities[index % severities.length],
    file: `src/module-${index + 1}.ts`,
    line: index + 1,
    title: `第 ${index + 1} 个问题`,
    evidence: `evidence for finding ${index + 1}`,
    requiredChange: `change ${index + 1}`,
    resolved: false,
  }));
}

function completedEvaluation(request: DecisionRequest, overrides: Partial<DecisionEvaluation> = {}): DecisionEvaluation {
  return {
    evaluationId: request.evaluationId,
    runId: request.runId,
    kind: request.kind,
    mode: request.mode,
    provider: "typesafe",
    requestedModel: "jev-latest",
    resolvedModel: "jev-1.13.0",
    policyVersion: request.policyVersion,
    stateHash: request.stateHash,
    status: "completed",
    answers: [
      {
        questionId: "f_01_security_impact",
        type: "choice",
        value: "possible",
        confidence: 0.8,
        probabilities: { none: 0.1, possible: 0.8, material: 0.1 },
      },
    ],
    latencyMs: 183,
    inputTokens: 412,
    outputTokens: 12,
    createdAt: "2026-10-06T12:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  app: FastifyInstance;
  store: RunStore;
  audit: DecisionAuditStore;
  db: Awaited<ReturnType<typeof createTestDb>>;
  run: Run;
  engineCalls: DecisionRequest[];
  engineConfigs: DecisionEngineConfig[];
  buildCalls: ReviewTriageInput[];
  deps: DecisionRouteDeps;
  evaluate(overrides?: { runId?: string; headers?: Record<string, string>; payload?: Record<string, unknown> }): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>;
  decisions(runId: string, owner?: string): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>;
}

async function harness(options: {
  load?: DecisionConfigLoad;
  evaluation?: (request: DecisionRequest) => DecisionEvaluation | Promise<DecisionEvaluation>;
  /** Overrides the batch builder; defaults to a single fake batch. */
  buildBatches?: BuildDecisionBatches;
  /** Uses the real `createDecisionEngine`/`buildReviewTriageBatches` (no network). */
  realContracts?: boolean;
  findings?: Run["findings"];
  /**
   * Provider→key map for the injected vault reader. Absent providers read as
   * "no credential", exactly like a vault miss.
   */
  vaultKeys?: Record<string, string | undefined>;
  /** Records every `readVaultKey` call so a test can prove a path never queried. */
  vaultReads?: Array<{ userId: string; provider: string }>;
  /** The route's env (e.g. a platform `TYPESAFE_API_KEY`). */
  env?: NodeJS.ProcessEnv;
  /**
   * When set, `createEngine` wires the REAL jev engine with this fetch, so the
   * test can observe the outbound request count and Authorization header
   * without touching the network.
   */
  jevFetch?: typeof fetch;
} = {}): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "pigo-decision-"));
  directories.push(directory);
  const store = new RunStore(path.join(directory, "runs.json"));
  await store.init();
  const run = baseDemoRun({ title: "决策", task: "A sufficiently long decision test task", repository: "test/repo" }, OWNER);
  if (options.findings) run.findings = options.findings;
  await store.createRun(run, {
    runId: run.id,
    round: 1,
    source: "system",
    type: "run.created",
    message: "created",
    at: new Date().toISOString(),
  });

  const db = await createTestDb();
  const audit = new DecisionAuditStore(db);
  const engineCalls: DecisionRequest[] = [];
  const engineConfigs: DecisionEngineConfig[] = [];
  const buildCalls: ReviewTriageInput[] = [];

  const engine: DecisionEngine = {
    evaluate: async (request) => {
      engineCalls.push(request);
      return options.evaluation ? options.evaluation(request) : completedEvaluation(request);
    },
  };

  const deps: DecisionRouteDeps = {
    store,
    audit,
    env: options.env ?? { TYPESAFE_API_KEY: HARNESS_ENV_KEY },
    loadConfig: () => options.load ?? { ok: true, config: testConfig() },
    createEngine: (config, engineDeps) => {
      engineConfigs.push(config);
      if (options.jevFetch) return createDecisionEngine(config, { ...engineDeps, fetchImpl: options.jevFetch });
      return options.realContracts ? createDecisionEngine(config, engineDeps) : engine;
    },
    buildBatches: (input) => {
      buildCalls.push(input);
      if (options.buildBatches) return options.buildBatches(input);
      if (options.realContracts) return buildReviewTriageBatches(input);
      return [fakeBatch(fakeBuildRequest(input))];
    },
    internalAuthorized: (request) => bearerMatches(request.headers.authorization, INTERNAL_TOKEN),
    ownerKeysFor: (request) => [String(request.headers["x-owner"] ?? "")],
    readVaultKey: (userId, provider) => {
      options.vaultReads?.push({ userId, provider });
      return options.vaultKeys?.[provider];
    },
    now: () => new Date("2026-10-06T00:00:00.000Z"),
  };

  const app = Fastify();
  registerDecisionRoutes(app, deps);
  await app.ready();

  return {
    app,
    store,
    audit,
    db,
    run,
    engineCalls,
    engineConfigs,
    buildCalls,
    deps,
    evaluate: (overrides = {}) =>
      app.inject({
        method: "POST",
        url: DECISION_EVALUATE_PATH,
        headers: overrides.headers ?? { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: overrides.payload ?? { runId: overrides.runId ?? run.id, kind: "review_triage" },
      }),
    decisions: (runId, owner = OWNER) =>
      app.inject({ method: "GET", url: `/api/runs/${runId}/decisions`, headers: { "x-owner": owner } }),
  };
}

async function decisionEvents(store: RunStore, runId: string) {
  return (await store.getEvents(runId, 0, 100)).filter((event) => event.type.startsWith("decision."));
}

async function auditRowCount(db: DecisionAuditStore) {
  return (await db.aggregate()).total;
}

describe("POST /api/internal/decisions/evaluate (docs/26 §8.1)", () => {
  it("requires the internal worker token — a browser session is rejected without any provider call", async () => {
    const h = await harness();

    const noAuth = await h.evaluate({ headers: {} });
    expect(noAuth.statusCode).toBe(401);

    const sessionOnly = await h.evaluate({
      headers: { cookie: "pigo_session=valid-looking-session", "cf-access-jwt-assertion": "session-jwt" },
    });
    expect(sessionOnly.statusCode).toBe(401);

    const wrongToken = await h.evaluate({ headers: { authorization: "Bearer DUMMY-not-the-internal-token" } });
    expect(wrongToken.statusCode).toBe(401);

    expect(h.engineCalls).toHaveLength(0);
    expect(h.buildCalls).toHaveLength(0);
    expect(await auditRowCount(h.audit)).toBe(0);
  });

  it("rejects an invalid body and an unknown run", async () => {
    const h = await harness();
    const badKind = await h.evaluate({ payload: { runId: h.run.id, kind: "planner_route" } });
    expect(badKind.statusCode).toBe(400);
    const badShape = await h.evaluate({ payload: { kind: "review_triage" } });
    expect(badShape.statusCode).toBe(400);
    const missingRun = await h.evaluate({ runId: "run_missing" });
    expect(missingRun.statusCode).toBe(404);
    expect(h.engineCalls).toHaveLength(0);
  });

  it("returns a business-safe disabled result for off/disabled without an outbound call or an audit row", async () => {
    const off = await harness({ load: { ok: true, config: testConfig({ mode: "off" }) } });
    const offResponse = await off.evaluate();
    expect(offResponse.statusCode).toBe(200);
    expect(offResponse.json()).toMatchObject({ status: "disabled", mode: "off", provider: "disabled", fallbackReason: "disabled", answers: [] });
    expect(off.engineCalls).toHaveLength(0);
    expect(off.buildCalls).toHaveLength(0);
    expect(await auditRowCount(off.audit)).toBe(0);
    expect(await decisionEvents(off.store, off.run.id)).toHaveLength(0);

    const engineOff = await harness({ load: { ok: true, config: testConfig({ engine: "disabled", mode: "shadow" }) } });
    const engineOffResponse = await engineOff.evaluate();
    expect(engineOffResponse.json()).toMatchObject({ status: "disabled", provider: "disabled" });
    expect(engineOff.engineCalls).toHaveLength(0);
  });

  it("maps a rejected configuration to a standard fallback reason without any call", async () => {
    const h = await harness({ load: { ok: false, reason: "missing_credentials", detail: "TYPESAFE_API_KEY is required" } });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "fallback", fallbackReason: "missing_credentials", mode: "off" });
    expect(response.json().detail).toContain("TYPESAFE_API_KEY");
    expect(h.engineCalls).toHaveLength(0);
    expect(await auditRowCount(h.audit)).toBe(0);
  });

  it("maps a refused request build to a fallback and never calls the provider", async () => {
    const h = await harness({
      buildBatches: () => {
        throw Object.assign(new Error("payload over the state budget"), { reason: "payload_rejected" });
      },
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "fallback", fallbackReason: "payload_rejected" });
    expect(h.engineCalls).toHaveLength(0);
    expect(await auditRowCount(h.audit)).toBe(0);
  });

  it("treats a run with no unresolved findings as a no-op, not an empty provider call", async () => {
    // The builder returns no batch when nothing is unresolved; an empty
    // `questions` object is invalid for TypeSafe (live HTTP 422
    // `loc=body.questions … too_short`), so this must never reach the provider.
    const h = await harness({ buildBatches: () => [] });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "fallback", fallbackReason: "payload_rejected" });
    expect(response.json().detail).toContain("nothing to triage");
    expect(h.engineCalls).toHaveLength(0);
    expect(await auditRowCount(h.audit)).toBe(0);
  });

  it("persists exactly one audit row and appends decision.requested then decision.completed", async () => {
    const h = await harness();
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      runId: h.run.id,
      kind: "review_triage",
      mode: "shadow",
      provider: "typesafe",
      requestedModel: "jev-latest",
      resolvedModel: "jev-1.13.0",
      policyVersion: "review-triage-v1",
      stateHash: STATE_HASH,
      status: "completed",
      appliedOutcome: "none",
      latencyMs: 183,
      inputTokens: 412,
      outputTokens: 12,
    });
    expect(body.evaluationId).toBe(deriveEvaluationId({ runId: h.run.id, kind: "review_triage", policyVersion: "review-triage-v1", stateHash: STATE_HASH }));
    expect(body.answers[0]).toMatchObject({ questionId: "f_01_security_impact", value: "possible", confidence: 0.8 });

    const rows = await h.audit.listByRun(h.run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", appliedOutcome: "none", idempotencyKey: body.evaluationId });
    expect(rows[0].answers).toHaveLength(1);

    const events = await decisionEvents(h.store, h.run.id);
    expect(events.map((event) => event.type)).toEqual(["decision.requested", "decision.completed"]);
    expect(events.map((event) => event.seq)).toEqual([...events.map((event) => event.seq)].sort((a, b) => a - b));
    expect(events[0].meta).toMatchObject({ evaluationId: body.evaluationId, kind: "review_triage", mode: "shadow" });
    expect(events[1].meta).toMatchObject({
      evaluationId: body.evaluationId,
      status: "completed",
      resolvedModel: "jev-1.13.0",
      latencyMs: 183,
      inputTokens: 412,
    });
    // Meta carries identifiers and measurements only — never the payload.
    const serializedMeta = JSON.stringify(events.map((event) => event.meta));
    expect(serializedMeta).not.toContain(RAW_STATE_MARKER);
    expect(serializedMeta).not.toContain(FAKE_KEY);
    expect(serializedMeta).not.toContain("taskSummary");
  });

  it("appends decision.fallback with the standard reason when the engine falls back", async () => {
    const h = await harness({
      evaluation: (request) =>
        completedEvaluation(request, { status: "fallback", fallbackReason: "timeout", detail: "provider timed out", answers: [], resolvedModel: undefined }),
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "fallback", fallbackReason: "timeout", detail: "provider timed out" });
    const rows = await h.audit.listByRun(h.run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "fallback", fallbackReason: "timeout", appliedOutcome: "none" });
    const events = await decisionEvents(h.store, h.run.id);
    expect(events.map((event) => event.type)).toEqual(["decision.requested", "decision.fallback"]);
    expect(events[1].meta).toMatchObject({ fallbackReason: "timeout", status: "fallback" });
  });

  it("turns a thrown engine error into a persisted fallback instead of failing the task", async () => {
    const h = await harness({
      evaluation: () => {
        throw Object.assign(new Error("socket hang up"), { code: "provider_unavailable" });
      },
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "fallback", fallbackReason: "provider_unavailable" });
    expect((await h.audit.listByRun(h.run.id))[0]).toMatchObject({ status: "fallback", fallbackReason: "provider_unavailable" });
    expect((await decisionEvents(h.store, h.run.id)).map((event) => event.type)).toEqual(["decision.requested", "decision.fallback"]);
  });

  it("records the effective mode and the policy-resolved applied outcome", async () => {
    const h = await harness({
      load: { ok: true, config: testConfig({ mode: "enforce" }) },
      evaluation: (request) =>
        completedEvaluation(request, { mode: "assist", appliedOutcome: "assist_suggestion" }),
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    // The request is built with the configured ceiling; the engine (policy) may
    // demote it, and the audit row records what actually governed the call.
    expect(h.buildCalls[0].mode).toBe("enforce");
    expect(response.json()).toMatchObject({ mode: "assist", appliedOutcome: "assist_suggestion", status: "completed" });
    expect((await h.audit.listByRun(h.run.id))[0]).toMatchObject({ mode: "assist", appliedOutcome: "assist_suggestion" });
  });

  it("is idempotent: a duplicate evaluationId returns the stored row without a second call, row or event pair", async () => {
    const h = await harness();
    const first = await h.evaluate();
    const second = await h.evaluate();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.engineCalls).toHaveLength(1);
    expect(await auditRowCount(h.audit)).toBe(1);
    expect((await decisionEvents(h.store, h.run.id)).map((event) => event.type)).toEqual(["decision.requested", "decision.completed"]);
  });

  it("does not double-insert when the store sees a duplicate key directly", async () => {
    const h = await harness();
    await h.evaluate();
    const stored = (await h.audit.listByRun(h.run.id))[0];
    const duplicate = await h.audit.insert({ ...stored, evaluationId: "de_other_id" });
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.evaluationId).toBe(stored.evaluationId);
    expect(await auditRowCount(h.audit)).toBe(1);
  });

  it("stores an unknown cost as NULL (never 0) and keeps a small real cost unrounded", async () => {
    const h = await harness();
    await h.evaluate();
    const unknownRow = (await h.db.query("SELECT estimated_cost_usd FROM decision_evaluations")).rows[0];
    expect(unknownRow.estimated_cost_usd).toBeNull();
    expect((await h.decisions(h.run.id)).json().decisions[0].estimatedCostUsd).toBeUndefined();

    const priced = await harness({
      evaluation: (request) => completedEvaluation(request, { estimatedCostUsd: 0.0042 }),
    });
    await priced.evaluate();
    const pricedRow = (await priced.audit.listByRun(priced.run.id))[0];
    expect(pricedRow.estimatedCostUsd).toBe(0.0042);
    expect((await priced.decisions(priced.run.id)).json().decisions[0].estimatedCostUsd).toBe(0.0042);
  });

  it("never persists the outbound payload or a credential", async () => {
    const h = await harness();
    const response = await h.evaluate();
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain(RAW_STATE_MARKER);
    expect(serialized).not.toContain(FAKE_KEY);
    const row = (await h.db.query("SELECT state_manifest_json, answers_json FROM decision_evaluations")).rows[0];
    expect(String(row.state_manifest_json)).not.toContain(RAW_STATE_MARKER);
    expect(String(row.state_manifest_json)).not.toContain(FAKE_KEY);
    // The manifest keeps field names / counts / sizes only.
    const manifest = JSON.parse(String(row.state_manifest_json)) as { fields: string[]; counts: Record<string, number> };
    expect(manifest.fields).toContain("run.taskSummary");
    expect(manifest.counts["findings"]).toBe(1);
  });
});

describe("integration with the real review-triage builder and decision engine", () => {
  it("runs the mock provider end-to-end: audit row, events and answers (no network)", async () => {
    const h = await harness({
      realContracts: true,
      load: { ok: true, config: testConfig({ engine: "mock", mode: "shadow" }) },
      findings: [
        {
          id: "F1",
          severity: "high",
          file: "src/auth/session.ts",
          line: 12,
          title: "刷新竞态",
          evidence: `session refresh races; token ${FAKE_KEY}`,
          requiredChange: "serialize refreshes",
          resolved: false,
        },
      ],
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ runId: h.run.id, kind: "review_triage", mode: "shadow", status: "completed", appliedOutcome: "none" });
    expect(body.evaluationId).toMatch(/^de_[a-f0-9]{32}$/);
    expect(body.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.questionSchemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.answers.length).toBeGreaterThan(0);
    expect(h.engineCalls).toHaveLength(0); // the real engine was used, not the fake recorder

    const rows = await h.audit.listByRun(h.run.id);
    expect(rows).toHaveLength(1);
    expect((await decisionEvents(h.store, h.run.id)).map((event) => event.type)).toEqual([
      "decision.requested",
      "decision.completed",
    ]);
    // The outbound payload (with the credential-shaped evidence excerpt) is never stored.
    const row = (await h.db.query("SELECT state_manifest_json, answers_json FROM decision_evaluations")).rows[0];
    expect(String(row.state_manifest_json)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });
});

describe("review-triage batch fan-out (docs/26 §9.2)", () => {
  it("persists one row and one event pair per batch with per-batch ids when the review exceeds maxFindings", async () => {
    const h = await harness({
      buildBatches: buildReviewTriageBatches,
      load: { ok: true, config: testConfig({ reviewMaxFindings: 1 }) },
      findings: manyFindings(3),
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      evaluationId: string;
      batches: Array<{ evaluationId: string; stateHash: string; status: string }>;
    };
    expect(body.batches).toHaveLength(3);
    expect(h.engineCalls).toHaveLength(3);
    // Each batch carries its own deterministic, content-derived id and hash.
    expect(new Set(h.engineCalls.map((request) => request.evaluationId)).size).toBe(3);
    expect(new Set(h.engineCalls.map((request) => request.stateHash)).size).toBe(3);
    body.batches.forEach((batch, index) => {
      expect(batch.evaluationId).toBe(
        batchEvaluationId({
          runId: h.run.id,
          kind: "review_triage",
          policyVersion: "review-triage-v1",
          stateHash: batch.stateHash,
          index,
          count: 3,
        }),
      );
    });
    // The top level mirrors batch 1 (the previous single-evaluation shape).
    expect(body.evaluationId).toBe(body.batches[0].evaluationId);

    const rows = await h.audit.listByRun(h.run.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.evaluationId))).toEqual(new Set(body.batches.map((batch) => batch.evaluationId)));
    expect(rows.every((row) => row.idempotencyKey === row.evaluationId)).toBe(true);

    const events = await decisionEvents(h.store, h.run.id);
    expect(events.map((event) => event.type)).toEqual([
      "decision.requested",
      "decision.completed",
      "decision.requested",
      "decision.completed",
      "decision.requested",
      "decision.completed",
    ]);
    expect(events.map((event) => event.meta?.batchIndex)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(events.every((event) => event.meta?.batchCount === 3)).toBe(true);
    expect(new Set(events.map((event) => event.meta?.evaluationId)).size).toBe(3);
  });

  it("keeps the other batches when one batch's provider call fails", async () => {
    let calls = 0;
    const h = await harness({
      buildBatches: buildReviewTriageBatches,
      load: { ok: true, config: testConfig({ reviewMaxFindings: 1 }) },
      findings: manyFindings(2),
      evaluation: (request) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("socket hang up"), { code: "provider_unavailable" });
        return completedEvaluation(request);
      },
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; batches: Array<{ status: string; fallbackReason?: string }> };
    expect(h.engineCalls).toHaveLength(2);
    expect(body.batches).toHaveLength(2);
    // The first batch is unaffected and still mirrors the top-level status.
    expect(body.status).toBe("completed");
    expect(body.batches[0].status).toBe("completed");
    expect(body.batches[1]).toMatchObject({ status: "fallback", fallbackReason: "provider_unavailable" });

    const rows = await h.audit.listByRun(h.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(["completed", "fallback"]);
    expect(rows.find((row) => row.status === "fallback")?.fallbackReason).toBe("provider_unavailable");
    expect((await decisionEvents(h.store, h.run.id)).map((event) => event.type)).toEqual([
      "decision.requested",
      "decision.completed",
      "decision.requested",
      "decision.fallback",
    ]);
  });

  it("records an oversized finding set as a payload_rejected fallback without dropping the other batches", async () => {
    const h = await harness({
      buildBatches: (input) => [
        fakeBatch({ ...fakeBuildRequest(input), stateHash: "a".repeat(64) }),
        fakeBatch({ ...fakeBuildRequest(input), stateHash: "b".repeat(64) }, {
          withinLimits: false,
          reason: "payload_rejected",
          detail: "serialized payload 999999 bytes > 262144",
        }),
      ],
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; batches: Array<{ status: string; fallbackReason?: string; latencyMs: number }> };
    expect(body.batches).toHaveLength(2);
    expect(body.batches[1]).toMatchObject({ status: "fallback", fallbackReason: "payload_rejected", latencyMs: 0 });
    // The over-limit batch is never dispatched.
    expect(h.engineCalls).toHaveLength(1);

    const rows = await h.audit.listByRun(h.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(["completed", "fallback"]);
    const rejected = rows.find((row) => row.fallbackReason === "payload_rejected");
    expect(rejected).toMatchObject({ status: "fallback", provider: "typesafe", appliedOutcome: "none" });
    expect((await decisionEvents(h.store, h.run.id)).map((event) => event.type)).toEqual([
      "decision.requested",
      "decision.completed",
      "decision.requested",
      "decision.fallback",
    ]);
  });

  it("is idempotent per batch on replay: no second provider call, row or event pair", async () => {
    const h = await harness({
      buildBatches: buildReviewTriageBatches,
      load: { ok: true, config: testConfig({ reviewMaxFindings: 1 }) },
      findings: manyFindings(3),
    });
    const first = await h.evaluate();
    const second = await h.evaluate();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.engineCalls).toHaveLength(3);
    expect(await auditRowCount(h.audit)).toBe(3);
    expect(await decisionEvents(h.store, h.run.id)).toHaveLength(6);
  });

  it("stays business-safe when the worker opts in but the web configuration is off", async () => {
    const h = await harness({
      buildBatches: buildReviewTriageBatches,
      load: { ok: true, config: testConfig({ mode: "off" }) },
      findings: manyFindings(3),
    });
    const response = await h.evaluate();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "disabled",
      mode: "off",
      provider: "disabled",
      fallbackReason: "disabled",
      answers: [],
    });
    // The gateway is the authority: no outbound call, no batch built, no row, no event.
    expect(h.engineCalls).toHaveLength(0);
    expect(h.buildCalls).toHaveLength(0);
    expect(await auditRowCount(h.audit)).toBe(0);
    expect(await decisionEvents(h.store, h.run.id)).toHaveLength(0);
  });
});

const PROVIDER_BODY = () => ({
  model: "jev-1.13.0",
  answers: {
    f_01_security_impact: { choice: "possible", probabilities: { none: 0.1, possible: 0.8, material: 0.1 }, confidence: 0.8 },
  },
  usage: { input_tokens: 3, output_tokens: 2 },
});

/** Real jev engine fetch: one valid provider response, never a network call. */
function providerFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify(PROVIDER_BODY()), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

describe("decision-plane key resolution — vault first, env fallback (docs/26 §11)", () => {
  it("prefers the per-user vault key and makes exactly one provider call with it", async () => {
    resetDecisionCircuitBreakers();
    const fetchImpl = providerFetch();
    const vaultReads: Array<{ userId: string; provider: string }> = [];
    const h = await harness({
      load: { ok: true, config: testConfig({ maxAttempts: 1, hasApiKey: false }) },
      vaultKeys: { typesafe: FAKE_KEY },
      vaultReads,
      env: { TYPESAFE_API_KEY: "sk-DUMMY-ENV-FALLBACK-MUST-LOSE" },
      jevFetch: fetchImpl as unknown as typeof fetch,
    });

    const response = await h.evaluate();
    expect(response.json()).toMatchObject({ status: "completed", provider: "typesafe", resolvedModel: "jev-1.13.0" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    // Looked up by the run owner with the canonical provider id; the vault hit
    // short-circuits, so the `jev` alias and the env key are never consulted.
    expect(vaultReads).toEqual([{ userId: h.run.ownerId, provider: "typesafe" }]);
    // The config carries presence, never the value.
    expect(h.engineConfigs[0].hasApiKey).toBe(true);
    expect(JSON.stringify(h.engineConfigs[0])).not.toContain(FAKE_KEY);
  });

  it("accepts a key stored under the `jev` alias of the provider id", async () => {
    resetDecisionCircuitBreakers();
    const fetchImpl = providerFetch();
    const vaultReads: Array<{ userId: string; provider: string }> = [];
    const h = await harness({
      load: { ok: true, config: testConfig({ maxAttempts: 1, hasApiKey: false }) },
      vaultKeys: { jev: FAKE_KEY },
      vaultReads,
      env: {},
      jevFetch: fetchImpl as unknown as typeof fetch,
    });

    expect((await h.evaluate()).json()).toMatchObject({ status: "completed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(vaultReads.map((read) => read.provider)).toEqual(["typesafe", "jev"]);
  });

  it("falls back to TYPESAFE_API_KEY when the vault has no key, with exactly one provider call", async () => {
    resetDecisionCircuitBreakers();
    const fetchImpl = providerFetch();
    const vaultReads: Array<{ userId: string; provider: string }> = [];
    const h = await harness({
      load: { ok: true, config: testConfig({ maxAttempts: 1, hasApiKey: true }) },
      vaultReads,
      env: { TYPESAFE_API_KEY: FAKE_KEY },
      jevFetch: fetchImpl as unknown as typeof fetch,
    });

    expect((await h.evaluate()).json()).toMatchObject({ status: "completed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    // Both providers were tried (and missed) before the env fallback applied.
    expect(vaultReads.map((read) => read.provider)).toEqual(["typesafe", "jev"]);
  });

  it("reports missing_credentials with no provider call, batch build or audit row when nothing resolves", async () => {
    resetDecisionCircuitBreakers();
    const fetchImpl = providerFetch();
    const h = await harness({
      load: { ok: true, config: testConfig({ hasApiKey: false }) },
      vaultKeys: {},
      env: {},
      jevFetch: fetchImpl as unknown as typeof fetch,
    });

    const response = await h.evaluate();
    expect(response.json()).toMatchObject({
      status: "fallback",
      fallbackReason: "missing_credentials",
      provider: "disabled",
      answers: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.buildCalls).toHaveLength(0);
    expect(h.engineConfigs).toHaveLength(0);
    expect(await auditRowCount(h.audit)).toBe(0);
    expect(await decisionEvents(h.store, h.run.id)).toHaveLength(0);
  });

  it("never persists the resolved key in the response, the audit row or the events", async () => {
    resetDecisionCircuitBreakers();
    const fetchImpl = providerFetch();
    const h = await harness({
      load: { ok: true, config: testConfig({ maxAttempts: 1, hasApiKey: false }) },
      vaultKeys: { typesafe: FAKE_KEY },
      env: {},
      jevFetch: fetchImpl as unknown as typeof fetch,
    });

    const response = await h.evaluate();
    expect(JSON.stringify(response.json())).not.toContain(FAKE_KEY);
    const row = (await h.db.query("SELECT * FROM decision_evaluations")).rows[0];
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
    const events = JSON.stringify(await decisionEvents(h.store, h.run.id));
    expect(events).not.toContain(FAKE_KEY);
    const stored = JSON.stringify(await h.audit.listByRun(h.run.id));
    expect(stored).not.toContain(FAKE_KEY);
  });
});

describe("non-jev engines never read the credential vault (docs/26 §11)", () => {
  it("does not query the vault for a disabled engine or the off kill switch", async () => {
    const reads: Array<{ userId: string; provider: string }> = [];
    const disabled = await harness({
      load: { ok: true, config: testConfig({ engine: "disabled", mode: "shadow" }) },
      vaultKeys: { typesafe: FAKE_KEY },
      vaultReads: reads,
    });
    expect((await disabled.evaluate()).json()).toMatchObject({ status: "disabled" });

    const off = await harness({
      load: { ok: true, config: testConfig({ mode: "off" }) },
      vaultKeys: { typesafe: FAKE_KEY },
      vaultReads: reads,
    });
    expect((await off.evaluate()).json()).toMatchObject({ status: "disabled" });

    expect(reads).toHaveLength(0);
    expect(disabled.buildCalls).toHaveLength(0);
    expect(off.buildCalls).toHaveLength(0);
  });

  it("does not query the vault for the mock engine and leaves `hasApiKey` untouched", async () => {
    const reads: Array<{ userId: string; provider: string }> = [];
    const h = await harness({
      load: { ok: true, config: testConfig({ engine: "mock", mode: "shadow", hasApiKey: false }) },
      vaultKeys: { typesafe: FAKE_KEY },
      vaultReads: reads,
    });

    expect((await h.evaluate()).json()).toMatchObject({ status: "completed" });
    expect(reads).toHaveLength(0);
    expect(h.engineConfigs[0].hasApiKey).toBe(false);
  });
});

describe("GET /api/runs/:runId/decisions (docs/26 §8.2)", () => {
  it("is owner-scoped like the other run routes", async () => {
    const h = await harness();
    await h.evaluate();
    expect((await h.decisions(h.run.id)).statusCode).toBe(200);
    expect((await h.decisions(h.run.id, "owner-b")).statusCode).toBe(404);
    expect((await h.decisions("run_missing")).statusCode).toBe(404);
  });

  it("returns only the redacted audit projection, newest first", async () => {
    const h = await harness();
    await h.evaluate();
    const response = await h.decisions(h.run.id);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { decisions: Array<Record<string, unknown>> };
    expect(body.decisions).toHaveLength(1);
    const decision = body.decisions[0];
    expect(Object.keys(decision).sort()).toEqual(
      [
        "answers",
        "appliedOutcome",
        "createdAt",
        "evaluationId",
        "kind",
        "latencyMs",
        "mode",
        "policyVersion",
        "provider",
        "questionSchemaHash",
        "requestedModel",
        "resolvedModel",
        "runId",
        "stateHash",
        "stateManifest",
        "status",
        "outputTokens",
        "inputTokens",
      ].sort(),
    );
    // No outbound payload, no idempotency key, no credential.
    expect(decision).not.toHaveProperty("state");
    expect(decision).not.toHaveProperty("idempotencyKey");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(RAW_STATE_MARKER);
    expect(serialized).not.toContain(FAKE_KEY);
  });
});

describe("decision audit aggregate (docs/26 §13)", () => {
  it("counts by status and kind for the config/metrics surface", async () => {
    let fallbackRunId = "";
    const h = await harness({
      evaluation: (request) =>
        completedEvaluation(
          request,
          request.runId === fallbackRunId ? { status: "fallback", fallbackReason: "timeout", answers: [] } : {},
        ),
    });
    await h.evaluate();
    const fallbackRun = baseDemoRun({ title: "回退", task: "A sufficiently long decision test task", repository: "test/repo" }, OWNER);
    fallbackRunId = fallbackRun.id;
    await h.store.createRun(fallbackRun, { runId: fallbackRun.id, round: 1, source: "system", type: "run.created", message: "created", at: new Date().toISOString() });
    const fallback = await h.evaluate({ runId: fallbackRun.id });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json()).toMatchObject({ status: "fallback", fallbackReason: "timeout" });

    expect(await h.audit.aggregate()).toEqual({
      total: 2,
      byStatus: { completed: 1, fallback: 1 },
      byKind: { review_triage: 2 },
    });
    expect(await h.audit.listByRun(fallbackRun.id)).toHaveLength(1);
  });
});

describe("decisionEngineStatus (/api/config/status)", () => {
  it("reports the shape without the key, the base URL or any env value", () => {
    const configured = decisionEngineStatus(
      loadDecisionEngineConfig({ PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow", TYPESAFE_API_KEY: FAKE_KEY, PI_JEV_BASE_URL: "https://user:pass@internal.example" }),
    );
    expect(configured).toEqual({ engine: "jev", mode: "shadow", configured: true, keySource: "env", policyVersion: "review-triage-v1" });
    const serialized = JSON.stringify(configured);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("internal.example");
    expect(serialized).not.toContain("pass");
  });

  it("reports jev without a key as not configured, with the standard reason (preflight, AT-JEV-003)", () => {
    const status = decisionEngineStatus(loadDecisionEngineConfig({ PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow" }));
    expect(status).toEqual({
      engine: "disabled",
      mode: "off",
      configured: false,
      policyVersion: null,
      reason: "missing_credentials",
    });
  });

  it("reports a vault-backed jev config as configured with keySource=vault", () => {
    const loaded = loadDecisionEngineConfig(
      { PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow" },
      { allowMissingApiKey: true },
    );
    const status = decisionEngineStatus(loaded, { vaultKey: true });
    expect(status).toEqual({
      engine: "jev",
      mode: "shadow",
      configured: true,
      keySource: "vault",
      policyVersion: "review-triage-v1",
    });
    expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
  });

  it("prefers keySource=vault over the platform env key, and degrades to missing_credentials without either", () => {
    const both = loadDecisionEngineConfig(
      { PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow", TYPESAFE_API_KEY: FAKE_KEY },
      { allowMissingApiKey: true },
    );
    const vaultWins = decisionEngineStatus(both, { vaultKey: true });
    expect(vaultWins).toMatchObject({ configured: true, keySource: "vault" });
    expect(JSON.stringify(vaultWins)).not.toContain(FAKE_KEY);

    const envOnly = decisionEngineStatus(both, { vaultKey: false });
    expect(envOnly).toMatchObject({ configured: true, keySource: "env" });

    const none = loadDecisionEngineConfig(
      { PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow" },
      { allowMissingApiKey: true },
    );
    // The deployment IS enabled: only this user's credential is missing. Reporting
    // `disabled` here would send the operator looking for a config toggle that is
    // already set, so the configured engine/mode is kept and `configured`/`reason`
    // carry the actionable part.
    expect(decisionEngineStatus(none, { vaultKey: false })).toEqual({
      engine: "jev",
      mode: "shadow",
      configured: false,
      keySource: null,
      policyVersion: "review-triage-v1",
      reason: "missing_credentials",
    });
  });

  it("never reports a key source for disabled/mock, even with a vault key present", () => {
    expect(decisionEngineStatus(loadDecisionEngineConfig({}), { vaultKey: true })).toEqual({
      engine: "disabled",
      mode: "off",
      configured: false,
      policyVersion: "review-triage-v1",
    });
    const mock = loadDecisionEngineConfig({ PI_DECISION_ENGINE: "mock", TYPESAFE_API_KEY: FAKE_KEY });
    expect(decisionEngineStatus(mock, { vaultKey: true })).toEqual({
      engine: "mock",
      mode: "off",
      configured: false,
      policyVersion: "review-triage-v1",
    });
  });

  it("defaults to disabled/off and degrades a rejected configuration safely", () => {
    expect(decisionEngineStatus(loadDecisionEngineConfig({}))).toEqual({
      engine: "disabled",
      mode: "off",
      configured: false,
      policyVersion: "review-triage-v1",
    });
    const rejected = decisionEngineStatus(loadDecisionEngineConfig({ PI_JEV_MODE: "sometimes" }));
    expect(rejected).toEqual({
      engine: "disabled",
      mode: "off",
      configured: false,
      policyVersion: null,
      reason: "invalid_configuration",
    });
  });
});
