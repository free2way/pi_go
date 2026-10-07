import { timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../shared/types.js";
import type { Alert } from "./alerts.js";
import { DecisionAuditStore, type DecisionAuditStoreLike } from "./decision-engine/audit-store.js";
import { createDecisionEngine } from "./decision-engine/index.js";
import { resetDecisionCircuitBreakers } from "./decision-engine/jev.js";
import type { ReviewTriageBatch, ReviewTriageInput } from "./decision-engine/review-triage.js";
import type { DecisionEngineConfig, DecisionRequest } from "./decision-engine/types.js";
import {
  DECISION_EVALUATE_PATH,
  registerDecisionRoutes,
  type DecisionRouteDeps,
} from "./decision-routes.js";
import { baseDemoRun } from "./demo-runner.js";
import { RunStore } from "./store.js";
import { createTestDb } from "./test-db.js";

/**
 * docs/27 §12 · AT-JEV-092: the TypeSafe credential is revoked.
 *
 * Expected: no unbounded retry, ONE explicit alert, an automatic fallback, and
 * recovery once a new key is installed.
 *
 * Everything runs in-process against the REAL jev adapter (an injected `fetch`,
 * never the network), the real `DecisionAuditStore` over pg-mem and an injected
 * alert sink. No provider, no Docker.
 *
 * This file is deliberately separate from `decision-routes.test.ts` (owned by
 * another change).
 */

const INTERNAL_TOKEN = "internal-worker-token-for-tests";
const OWNER = "owner-a";
/** A revoked credential and its replacement; neither may ever leave the route. */
const VAULT_KEY_1 = "sk-DUMMY-REVOKED-KEY-000111222333";
const VAULT_KEY_2 = "sk-DUMMY-ROTATED-KEY-444555666777";
/** Raw provider error body content that must never reach an alert or a row. */
const PROVIDER_BODY_MARKER = "invalid api key sk-PROVIDER-BODY-DO-NOT-LEAK";
const RAW_STATE_MARKER = "SECRET-STATE-SNIPPET-DO-NOT-LEAK";

const directories: string[] = [];

beforeEach(() => {
  // The jev breaker is module-level state; every test starts from a fresh process.
  resetDecisionCircuitBreakers();
});

afterEach(async () => {
  resetDecisionCircuitBreakers();
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

/** One payload-safe batch; the `stateHash` decides the evaluation id. */
function fakeBatch(input: ReviewTriageInput, stateHash: string): ReviewTriageBatch {
  const request: DecisionRequest = {
    evaluationId: input.evaluationId,
    runId: input.run.id,
    kind: "review_triage",
    mode: input.mode,
    policyVersion: input.policyVersion,
    stateHash,
    state: { run: { taskSummary: RAW_STATE_MARKER, locale: "zh-CN" } },
    questions: {
      f_01_security_impact: { type: "choice", prompt: "安全影响？", options: ["none", "possible", "material"] },
    },
    timeoutMs: input.timeoutMs,
  };
  return {
    evaluationId: request.evaluationId,
    request,
    withinLimits: true,
    measurement: FAKE_MEASUREMENT,
    findingKeys: ["f_01"],
  };
}

const PROVIDER_BODY = () => ({
  model: "jev-1.13.0",
  answers: {
    f_01_security_impact: { choice: "possible", probabilities: { none: 0.1, possible: 0.8, material: 0.1 }, confidence: 0.8 },
  },
  usage: { input_tokens: 3, output_tokens: 2 },
});

interface ProviderFetch {
  impl: typeof fetch;
  /** The `Authorization` header of every outbound call, in order. */
  authorizations: string[];
  calls: number;
  /** Stops answering 401 — the credential has been replaced. */
  acceptCredentials(): void;
}

/**
 * A provider that rejects the credentials (401/403) until `acceptCredentials()`
 * is called, then answers normally. Every outbound call is counted, so a test
 * can prove that a terminal status is never retried.
 */
function providerFetch(initialStatus = 401): ProviderFetch {
  let status = initialStatus;
  const authorizations: string[] = [];
  const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authorizations.push(headers.Authorization ?? "");
    if (status !== 0) {
      return new Response(JSON.stringify({ detail: PROVIDER_BODY_MARKER }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(PROVIDER_BODY()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    impl: impl as unknown as typeof fetch,
    authorizations,
    get calls() {
      return authorizations.length;
    },
    acceptCredentials: () => {
      status = 0;
    },
  };
}

interface Harness {
  run: Run;
  store: RunStore;
  audit: DecisionAuditStoreLike;
  engineConfigs: DecisionEngineConfig[];
  evaluate(): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>;
}

async function harness(options: {
  /** Consumed one per `buildBatches` call; a repeat makes the same evaluation id. */
  stateHashes?: string[];
  /** Batches produced per evaluation (all share one state hash). */
  batchesPerCall?: number;
  vaultKeys?: Record<string, string | undefined>;
  env?: NodeJS.ProcessEnv;
  /** Always injected: no test may reach the network. */
  fetchImpl: typeof fetch;
  raiseAlert?: (alert: Alert) => void;
  config?: Partial<DecisionEngineConfig>;
}): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "pigo-decision-auth-"));
  directories.push(directory);
  const store = new RunStore(path.join(directory, "runs.json"));
  await store.init();
  const run = baseDemoRun(
    { title: "凭据撤销", task: "A sufficiently long credential revocation test task", repository: "test/repo" },
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
  const audit = new DecisionAuditStore(db);
  const engineConfigs: DecisionEngineConfig[] = [];
  const stateHashes = [...(options.stateHashes ?? [])];
  let batchCalls = 0;

  const deps: DecisionRouteDeps = {
    store,
    audit,
    env: options.env ?? {},
    loadConfig: () => ({ ok: true, config: testConfig(options.config) }),
    createEngine: (config, engineDeps) => {
      engineConfigs.push(config);
      return createDecisionEngine(config, { ...(engineDeps ?? {}), fetchImpl: options.fetchImpl });
    },
    buildBatches: (input) => {
      const stateHash = stateHashes.shift() ?? `state-${batchCalls++}`;
      const count = options.batchesPerCall ?? 1;
      return Array.from({ length: count }, (_value, index) =>
        fakeBatch(input, count > 1 ? `${stateHash}#${index + 1}` : stateHash),
      );
    },
    internalAuthorized: (request) => bearerMatches(request.headers.authorization, INTERNAL_TOKEN),
    ownerKeysFor: () => [OWNER],
    readVaultKey: (userId, provider) => {
      void userId;
      return options.vaultKeys?.[provider];
    },
    now: () => new Date("2026-10-06T00:00:00.000Z"),
    ...(options.raiseAlert ? { raiseAlert: options.raiseAlert } : {}),
  };

  const app = Fastify();
  registerDecisionRoutes(app, deps);
  await app.ready();

  return {
    run,
    store,
    audit,
    engineConfigs,
    evaluate: () =>
      app.inject({
        method: "POST",
        url: DECISION_EVALUATE_PATH,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: { runId: run.id, kind: "review_triage" },
      }),
  };
}

async function decisionEvents(store: RunStore, runId: string) {
  return (await store.getEvents(runId, 0, 100)).filter((event) => event.type.startsWith("decision."));
}

/** The exact alert AT-JEV-092 requires; `details` carries identifiers only. */
function expectedAlert(input: { evaluationId: string; runId: string }): Alert {
  return {
    key: "jev_authentication_failed",
    severity: "critical",
    message: "Jev 凭据被拒绝（HTTP 401/403）：决策评估暂停，请在「模型与凭据」页更换 TypeSafe key",
    details: {
      provider: "typesafe",
      evaluationId: input.evaluationId,
      runId: input.runId,
      at: "2026-10-06T00:00:00.000Z",
    },
  };
}

describe("AT-JEV-092 credential revocation", () => {
  it.each([401, 403])(
    "HTTP %i: one outbound call, authentication_failed fallback and exactly one critical alert",
    async (status) => {
      const alerts: Alert[] = [];
      const provider = providerFetch(status);
      const h = await harness({
        stateHashes: ["a"],
        fetchImpl: provider.impl,
        vaultKeys: { typesafe: VAULT_KEY_1 },
        raiseAlert: (alert) => alerts.push(alert),
        // 401/403 must be terminal even when retries are allowed.
        config: { maxAttempts: 3 },
      });

      const response = await h.evaluate();
      expect(response.statusCode).toBe(200);
      const body = response.json() as { evaluationId: string; batches: unknown[] };
      expect(body).toMatchObject({
        status: "fallback",
        fallbackReason: "authentication_failed",
        provider: "typesafe",
        mode: "shadow",
        answers: [],
      });
      // AT-JEV-092 「不发生无界重试」: one request, never `maxAttempts`.
      expect(provider.calls).toBe(1);
      expect(provider.authorizations).toEqual([`Bearer ${VAULT_KEY_1}`]);

      // AT-JEV-092 「产生单一明确告警」: exactly one, with the exact payload.
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toEqual(expectedAlert({ evaluationId: body.evaluationId, runId: h.run.id }));
      expect(Object.keys(alerts[0].details ?? {}).sort()).toEqual(["at", "evaluationId", "provider", "runId"]);

      // Neither the key, nor the Authorization header, nor the provider body,
      // nor the outbound payload may leak into the alert.
      const serialized = JSON.stringify(alerts[0]);
      expect(serialized).not.toContain(VAULT_KEY_1);
      expect(serialized).not.toContain("Authorization");
      expect(serialized).not.toContain(PROVIDER_BODY_MARKER);
      expect(serialized).not.toContain(RAW_STATE_MARKER);
      expect(serialized).not.toContain("taskSummary");

      // AT-JEV-092 「自动 fallback」: the failure is persisted and evented.
      const rows = await h.audit.listByRun(h.run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "fallback", fallbackReason: "authentication_failed" });
      expect((await decisionEvents(h.store, h.run.id)).map((event) => event.type)).toEqual([
        "decision.requested",
        "decision.fallback",
      ]);
    },
  );

  it("re-playing the same evaluation neither calls the provider nor alerts twice", async () => {
    const alerts: Alert[] = [];
    const provider = providerFetch(401);
    const h = await harness({
      // The second request reuses the first state → identical evaluation id.
      stateHashes: ["a", "a"],
      fetchImpl: provider.impl,
      vaultKeys: { typesafe: VAULT_KEY_1 },
      raiseAlert: (alert) => alerts.push(alert),
    });

    const first = await h.evaluate();
    const replay = await h.evaluate();

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(provider.calls).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(await h.audit.listByRun(h.run.id)).toHaveLength(1);
    expect((await decisionEvents(h.store, h.run.id)).map((event) => event.type)).toEqual([
      "decision.requested",
      "decision.fallback",
    ]);
  });

  it("is a silent no-op when no alert sink is injected (the evaluation still returns)", async () => {
    const provider = providerFetch(401);
    const h = await harness({
      stateHashes: ["a"],
      fetchImpl: provider.impl,
      vaultKeys: { typesafe: VAULT_KEY_1 },
    });

    const response = await h.evaluate();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "fallback", fallbackReason: "authentication_failed" });
    expect(provider.calls).toBe(1);
    expect(await h.audit.listByRun(h.run.id)).toHaveLength(1);
  });

  it("a locally missing credential is a configuration problem: no alert and no outbound call", async () => {
    const alerts: Alert[] = [];
    const provider = providerFetch(401);

    const missing = await harness({
      stateHashes: ["a"],
      fetchImpl: provider.impl,
      vaultKeys: {},
      env: {},
      raiseAlert: (alert) => alerts.push(alert),
    });
    expect((await missing.evaluate()).json()).toMatchObject({
      status: "fallback",
      fallbackReason: "missing_credentials",
      provider: "disabled",
    });

    // The `off` kill switch is equally not a credential rejection.
    const off = await harness({
      stateHashes: ["a"],
      fetchImpl: provider.impl,
      vaultKeys: { typesafe: VAULT_KEY_1 },
      raiseAlert: (alert) => alerts.push(alert),
      config: { mode: "off" },
    });
    expect((await off.evaluate()).json()).toMatchObject({ status: "disabled", fallbackReason: "disabled" });

    expect(alerts).toHaveLength(0);
    expect(provider.calls).toBe(0);
    expect(await missing.audit.listByRun(missing.run.id)).toHaveLength(0);
    expect(await off.audit.listByRun(off.run.id)).toHaveLength(0);
  });

  it("a multi-batch review raises ONE alert and never re-dispatches after the breaker locks", async () => {
    const alerts: Alert[] = [];
    const provider = providerFetch(401);
    const h = await harness({
      stateHashes: ["a"],
      batchesPerCall: 2,
      fetchImpl: provider.impl,
      vaultKeys: { typesafe: VAULT_KEY_1 },
      raiseAlert: (alert) => alerts.push(alert),
      config: { maxAttempts: 3 },
    });

    const response = await h.evaluate();
    const body = response.json() as { batches: Array<{ fallbackReason?: string }> };

    expect(response.statusCode).toBe(200);
    expect(body.batches).toHaveLength(2);
    // The first batch is rejected and locks the breaker; the second is refused
    // locally instead of producing a second outbound call.
    expect(body.batches[0]).toMatchObject({ fallbackReason: "authentication_failed" });
    expect(body.batches[1]).toMatchObject({ fallbackReason: "circuit_open" });
    expect(provider.calls).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(await h.audit.listByRun(h.run.id)).toHaveLength(2);
  });

  it("rotating the vault key alone does NOT release the auth-locked breaker; a fresh process recovers with the new key", async () => {
    const alerts: Alert[] = [];
    const provider = providerFetch(401);
    const vault: Record<string, string | undefined> = { typesafe: VAULT_KEY_1 };
    const h = await harness({
      // Same run, three distinct states: the evaluation id is derived from the
      // state, so reusing a state would only re-read the stored 401 row.
      stateHashes: ["a", "b", "c"],
      fetchImpl: provider.impl,
      vaultKeys: vault,
      raiseAlert: (alert) => alerts.push(alert),
      config: { maxAttempts: 1 },
    });

    // 1) The revoked key is rejected: one call, one alert, breaker locked.
    const rejected = await h.evaluate();
    expect(rejected.json()).toMatchObject({ status: "fallback", fallbackReason: "authentication_failed" });
    expect(provider.authorizations).toEqual([`Bearer ${VAULT_KEY_1}`]);
    expect(alerts).toHaveLength(1);

    // 2) The operator installs a NEW key in the vault and the provider would now
    //    accept it. The route resolves the new key and builds a new engine, but
    //    the cached breaker (keyed by baseUrl|model|hasApiKey — never by the key
    //    value) is still auth-locked, so no call is dispatched.
    vault.typesafe = VAULT_KEY_2;
    provider.acceptCredentials();
    const blocked = await h.evaluate();
    expect(blocked.json()).toMatchObject({ status: "fallback", fallbackReason: "circuit_open" });
    expect(provider.calls).toBe(1);
    expect(h.engineConfigs.map((config) => config.hasApiKey)).toEqual([true, true]);
    expect(JSON.stringify(blocked.json())).not.toContain(VAULT_KEY_2);

    // A blocked circuit is not a credential rejection: no second alert, so the
    // incident still produced exactly ONE alert.
    expect(alerts).toHaveLength(1);

    // 3) Recovery needs the breaker state gone — in production that means a
    //    restarted process (the breaker map is module-level and is never evicted);
    //    `resetDecisionCircuitBreakers()` here models exactly that restart.
    resetDecisionCircuitBreakers();
    const recovered = await h.evaluate();
    expect(recovered.json()).toMatchObject({ status: "completed", resolvedModel: "jev-1.13.0" });
    expect(provider.authorizations).toEqual([`Bearer ${VAULT_KEY_1}`, `Bearer ${VAULT_KEY_2}`]);
    // `listByRun` is newest-first; reverse to read the incident chronologically.
    const statuses = (await h.audit.listByRun(h.run.id)).map((row) => row.status).reverse();
    expect(statuses).toEqual(["fallback", "fallback", "completed"]);
    expect(alerts).toHaveLength(1);
  });
});
