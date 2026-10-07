import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { DecisionAuditStore, type DecisionAuditStoreLike } from "./decision-engine/audit-store.js";
import { resetDecisionCircuitBreakers } from "./decision-engine/jev.js";
import { DECISION_METRICS_PATH, registerDecisionRoutes, type DecisionRouteDeps } from "./decision-routes.js";
import type { DecisionEvaluationRecord } from "./decision-engine/types.js";
import type { DecisionCircuitSnapshotEntry } from "./decision-engine/jev.js";
import { createTestDb } from "./test-db.js";

/**
 * docs/26 §16.1 · `GET /api/decisions/metrics`. Runs against the real audit store
 * over pg-mem (exercising migration 15 + the new `listRecent` SQL), a bare
 * Fastify app and an injected session gate — no network, no provider, no Docker.
 */

const SESSION = "session-token";
const PLANTED_SECRET = "sk-DUMMY-DO-NOT-LEAK-0123456789";

function record(overrides: Partial<DecisionEvaluationRecord> = {}): DecisionEvaluationRecord {
  return {
    evaluationId: `de_${Math.random().toString(16).slice(2)}`,
    runId: "run_metrics_1",
    kind: "review_triage",
    mode: "shadow",
    provider: "typesafe",
    requestedModel: "jev-latest",
    resolvedModel: "jev-1.13.0",
    policyVersion: "review-triage-v1",
    stateHash: "f".repeat(64),
    status: "completed",
    answers: [],
    latencyMs: 100,
    createdAt: "2026-10-06T06:00:00.000Z",
    stateManifest: {},
    questionSchemaHash: "0".repeat(64),
    idempotencyKey: `idem_${Math.random().toString(16).slice(2)}`,
    ...overrides,
  };
}

const NOW = () => new Date("2026-10-06T12:00:00.000Z");

function enabledConfig() {
  return {
    ok: true as const,
    config: {
      engine: "jev" as const,
      mode: "shadow" as const,
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
    },
  };
}

async function harness(options: {
  audit?: DecisionAuditStoreLike;
  load?: DecisionRouteDeps["loadConfig"];
  circuits?: () => readonly DecisionCircuitSnapshotEntry[];
  session?: (request: { headers: Record<string, unknown> }) => boolean;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const db = await createTestDb();
  const audit = options.audit ?? new DecisionAuditStore(db);
  const warns: Array<{ message: string; details: Record<string, unknown> }> = [];
  const app = Fastify();
  registerDecisionRoutes(app, {
    store: {
      getRun: () => undefined,
      appendEvent: async () => undefined,
    },
    audit,
    env: options.env ?? { TYPESAFE_API_KEY: "platform-key", PI_DECISION_ENGINE: "jev" },
    loadConfig: options.load ?? (() => enabledConfig()),
    createEngine: () => ({ evaluate: async () => record() }),
    buildBatches: () => [],
    internalAuthorized: () => false,
    ownerKeysFor: () => ["owner"],
    sessionAuthorized: options.session ?? ((request) => request.headers["x-session"] === SESSION),
    ...(options.circuits ? { circuits: options.circuits } : {}),
    warn: (message, details) => warns.push({ message, details }),
    now: NOW,
  });
  await app.ready();
  return {
    app,
    audit,
    db,
    warns,
    get: (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: DECISION_METRICS_PATH, headers }),
    authed: () => app.inject({ method: "GET", url: DECISION_METRICS_PATH, headers: { "x-session": SESSION } }),
  };
}

describe("GET /api/decisions/metrics (docs/26 §16.1)", () => {
  it("rejects an unauthenticated session with 401 and does not touch the audit store", async () => {
    let reads = 0;
    const audit: DecisionAuditStoreLike = {
      findByIdempotencyKey: async () => undefined,
      insert: async (item) => ({ record: item, created: true }),
      listByRun: async () => [],
      aggregate: async () => ({ total: 0, byStatus: {}, byKind: {} }),
      findLatestCompletedByRequestedModel: async () => undefined,
      listRecent: async () => {
        reads += 1;
        return [];
      },
    };
    const h = await harness({ audit });
    const response = await h.get();
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
    expect(reads).toBe(0);
  });

  it("returns an explicit empty shape (rates are null, not 0) with no data", async () => {
    const h = await harness();
    const response = await h.authed();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.available).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.window).toEqual({ hours: 24, since: "2026-10-05T12:00:00.000Z", limit: 5000 });
    expect(body.computedAt).toBe("2026-10-06T12:00:00.000Z");
    expect(body.metrics.total).toBe(0);
    expect(body.metrics.validResponseRate).toBeNull();
    expect(body.metrics.fallbackRate).toBeNull();
    expect(body.metrics.latency).toEqual({ p50: null, p95: null, p99: null, max: null, samples: 0 });
  });

  it("aggregates only the rows inside the configured window", async () => {
    const h = await harness();
    await h.audit.insert(record({ createdAt: "2026-10-06T06:00:00.000Z", latencyMs: 120 }));
    await h.audit.insert(record({ createdAt: "2026-10-05T18:00:00.000Z", latencyMs: 80, status: "fallback", fallbackReason: "timeout", resolvedModel: undefined }));
    // Outside the 24h window (since 2026-10-05T12:00:00Z) — must be excluded.
    await h.audit.insert(record({ createdAt: "2026-10-04T00:00:00.000Z", latencyMs: 999, status: "fallback", fallbackReason: "timeout" }));

    const response = await h.authed();
    const body = response.json();
    expect(body.metrics.total).toBe(2);
    expect(body.metrics.byStatus.completed).toBe(1);
    expect(body.metrics.byStatus.fallback).toBe(1);
    expect(body.metrics.validResponseRate).toBe(0.5);
    expect(body.metrics.fallbackRate).toBe(0.5);
    expect(body.metrics.latency.samples).toBe(2);
    expect(body.metrics.latency.max).toBe(120);
    expect(body.metrics.byFallbackReason).toEqual({ timeout: 1 });
  });

  it("honours PI_DECISION_METRICS_WINDOW_HOURS and falls back on an invalid value", async () => {
    const h = await harness({ env: { PI_DECISION_METRICS_WINDOW_HOURS: "1", PI_DECISION_ENGINE: "jev" } });
    await h.audit.insert(record({ createdAt: "2026-10-06T06:00:00.000Z" }));
    const narrow = (await h.authed()).json();
    expect(narrow.window.hours).toBe(1);
    expect(narrow.window.since).toBe("2026-10-06T11:00:00.000Z");
    expect(narrow.metrics.total).toBe(0);

    const invalid = await harness({ env: { PI_DECISION_METRICS_WINDOW_HOURS: "not-a-number" } });
    expect((await invalid.authed()).json().window.hours).toBe(24);
  });

  it("reports an enabled=false empty state without querying when the plane is disabled", async () => {
    let reads = 0;
    const audit: DecisionAuditStoreLike = {
      findByIdempotencyKey: async () => undefined,
      insert: async (item) => ({ record: item, created: true }),
      listByRun: async () => [],
      aggregate: async () => ({ total: 0, byStatus: {}, byKind: {} }),
      findLatestCompletedByRequestedModel: async () => undefined,
      listRecent: async () => {
        reads += 1;
        return [];
      },
    };
    const h = await harness({
      audit,
      load: () => ({ ok: true, config: { ...enabledConfig().config, engine: "disabled" } }),
    });
    const body = (await h.authed()).json();
    expect(body.enabled).toBe(false);
    expect(body.available).toBe(true);
    expect(body.metrics.total).toBe(0);
    expect(reads).toBe(0);
  });

  it("rolls up injected circuit state and keeps the payload secret-free", async () => {
    resetDecisionCircuitBreakers();
    const h = await harness({
      circuits: () => [
        { scope: `vault:${PLANTED_SECRET}`, baseUrl: "https://api.typesafe.ai", model: "jev-latest", state: "open", authLocked: true },
        { scope: "env", baseUrl: "https://api.typesafe.ai", model: "jev-latest", state: "closed", authLocked: false },
      ],
    });
    await h.audit.insert(record({ runId: "run_secret_id_DO_NOT_LEAK" }));
    const response = await h.authed();
    const body = response.json();
    expect(body.metrics.circuits).toMatchObject({ total: 2, open: 1, authLocked: 1 });
    // Aggregate-only: no run id, no planted secret anywhere in the payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("run_secret_id_DO_NOT_LEAK");
    expect(serialized).not.toContain("platform-key");
    expect(Object.keys(body)).not.toContain("decisions");
  });

  it("degrades to available:false with a warn (never a 500) when the read fails", async () => {
    const failing: DecisionAuditStoreLike = {
      findByIdempotencyKey: async () => undefined,
      insert: async (item) => ({ record: item, created: true }),
      listByRun: async () => [],
      aggregate: async () => ({ total: 0, byStatus: {}, byKind: {} }),
      findLatestCompletedByRequestedModel: async () => undefined,
      listRecent: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    };
    const h = await harness({ audit: failing });
    const response = await h.authed();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.available).toBe(false);
    expect(body.enabled).toBe(true);
    expect(body.metrics.total).toBe(0);
    expect(h.warns.some((entry) => entry.message.includes("decision metrics read failed"))).toBe(true);
  });

  it("degrades (available:false) when the store has no listRecent seam", async () => {
    const legacy: DecisionAuditStoreLike = {
      findByIdempotencyKey: async () => undefined,
      insert: async (item) => ({ record: item, created: true }),
      listByRun: async () => [],
      aggregate: async () => ({ total: 0, byStatus: {}, byKind: {} }),
      findLatestCompletedByRequestedModel: async () => undefined,
    };
    const h = await harness({ audit: legacy });
    const body = (await h.authed()).json();
    expect(body.available).toBe(false);
    expect(body.enabled).toBe(true);
    expect(h.warns.some((entry) => entry.message.includes("no listRecent seam"))).toBe(true);
  });
});

describe("DecisionAuditStore.listRecent", () => {
  it("is newest-first, inclusive on the lower bound and clamped by the cap", async () => {
    const db = await createTestDb();
    const store = new DecisionAuditStore(db);
    await store.insert(record({ evaluationId: "de_a", createdAt: "2026-10-06T01:00:00.000Z" }));
    await store.insert(record({ evaluationId: "de_b", createdAt: "2026-10-06T02:00:00.000Z" }));
    await store.insert(record({ evaluationId: "de_c", createdAt: "2026-10-05T12:00:00.000Z" }));

    const rows = await store.listRecent({ sinceIso: "2026-10-05T12:00:00.000Z", limit: 10 });
    expect(rows.map((item) => item.evaluationId)).toEqual(["de_b", "de_a", "de_c"]);

    const capped = await store.listRecent({ sinceIso: "2026-10-05T12:00:00.000Z", limit: 1 });
    expect(capped.map((item) => item.evaluationId)).toEqual(["de_b"]);

    const excluded = await store.listRecent({ sinceIso: "2026-10-06T01:30:00.000Z", limit: 10 });
    expect(excluded.map((item) => item.evaluationId)).toEqual(["de_b"]);
  });
});
