import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Queryable } from "./db.js";
import type { Run } from "../shared/types.js";
import { DecisionAuditStore } from "./decision-engine/audit-store.js";
import type { DecisionEvaluationRecord } from "./decision-engine/types.js";
import { readDecisionUsageSafe } from "./decision-usage.js";
import { baseRealRun } from "./real-run.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { createTestDb } from "./test-db.js";

/**
 * Route-level coverage for `GET /api/runs/:id` after the decision-usage wiring
 * (docs/27 AT-JEV-061/062).
 *
 * `src/server/index.ts` is a top-level script (it calls `app.listen` and exports
 * nothing), so it cannot be imported into a unit test. This harness registers a
 * route that reproduces the run-detail route's wiring verbatim — the real
 * `store.getRun(id, ownerKeys)` owner scoping, the real `readDecisionUsageSafe`
 * call and the same warn-on-failure degradation — and drives it with Fastify
 * `inject`. `ownerKeysFor` itself is auth-dependent, so the harness derives the
 * owner keys from a test header instead of a session cookie.
 */

const OWNER = "owner-a";
const LEGACY = "legacy-a";
const STATE_HASH = "f".repeat(64);
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function makeRun(overrides: Partial<Run> = {}, owner: string = OWNER): Run {
  const run = baseRealRun(
    { title: "路由决策用量", task: "路由级决策用量测试。", repository: "/srv/workspace/pi_go", workspaceId: "ws_1", mode: "real", checks: [] },
    owner,
  );
  return { ...run, state: "needs_human", round: 2, ...overrides };
}

function decisionRecord(run: Run, index: number, overrides: Partial<DecisionEvaluationRecord> = {}): DecisionEvaluationRecord {
  return {
    evaluationId: `dev_route_${index}_${run.id.slice(-6)}`,
    runId: run.id,
    kind: "review_triage",
    mode: "shadow",
    provider: "typesafe",
    requestedModel: "jev-latest",
    resolvedModel: "jev-1.13.0",
    policyVersion: "review-triage-v1",
    stateHash: STATE_HASH,
    status: "completed",
    answers: [],
    latencyMs: 100,
    inputTokens: 300,
    outputTokens: 40,
    createdAt: at(index + 1),
    stateManifest: {},
    questionSchemaHash: "a".repeat(64),
    idempotencyKey: `idem_route_${index}_${run.id}`,
    ...overrides,
  };
}

/** Builds the same owner-scoped run-detail route the server registers. */
function buildRoute(db: Queryable, store: PostgresRunStore, warnings: string[]) {
  const app = Fastify();
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const ownerHeader = request.headers["x-test-owner"];
    const ownerKeys = String(ownerHeader ?? "").split(",").filter(Boolean);
    const run = store.getRun(request.params.id, ownerKeys);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return readDecisionUsageSafe(db, run, (error) => {
      warnings.push(error instanceof Error ? error.message : "unknown");
    });
  });
  return app;
}

describe("GET /api/runs/:id decision usage wiring (AT-JEV-061/062)", () => {
  it("attaches a role:decision entry for the owner without touching usage totals", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun({
      usage: { inputTokens: 900, outputTokens: 300, estimatedCost: 9 },
      usageUnknownCalls: 1,
      usageRoles: [{ role: "developer", provider: "deepseek", model: "deepseek-flash", inputTokens: 900, outputTokens: 300, estimatedCost: 9, calls: 2 }],
    });
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    const audit = new DecisionAuditStore(db);
    await audit.insert(decisionRecord(run, 0));
    await audit.insert(decisionRecord(run, 1, { inputTokens: 50, outputTokens: 5 }));

    const warnings: string[] = [];
    const app = buildRoute(db, store, warnings);
    const response = await app.inject({ method: "GET", url: `/api/runs/${run.id}`, headers: { "x-test-owner": OWNER } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Run;
    const decision = (body.usageRoles ?? []).filter((entry) => entry.role === "decision");
    expect(decision).toHaveLength(1);
    expect(decision[0]).toMatchObject({ provider: "typesafe", model: "jev-1.13.0", inputTokens: 350, outputTokens: 45, calls: 2, unpricedCalls: 2, estimatedCost: 0 });
    // Developer totals and the unknown-usage counter are untouched (AT-JEV-061).
    expect(body.usage).toEqual({ inputTokens: 900, outputTokens: 300, estimatedCost: 9 });
    expect(body.usageUnknownCalls).toBe(1);
    expect(body.usageRoles?.find((entry) => entry.role === "developer")).toMatchObject({ inputTokens: 900, outputTokens: 300, calls: 2 });
    expect(warnings).toEqual([]);
  });

  it("keeps the owner scope: another owner's run still 404s, the legacy owner key still resolves", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun();
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    // A run created before the account migration is owned by the legacy id;
    // `ownerKeysFor` returns [userId, legacyOwnerId], so the legacy key resolves it.
    const legacyRun = makeRun({}, LEGACY);
    await store.createRun(legacyRun, { runId: legacyRun.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    const warnings: string[] = [];
    const app = buildRoute(db, store, warnings);

    const stranger = await app.inject({ method: "GET", url: `/api/runs/${run.id}`, headers: { "x-test-owner": "owner-b" } });
    expect(stranger.statusCode).toBe(404);

    const foreign = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(foreign.statusCode).toBe(404);

    const legacy = await app.inject({ method: "GET", url: `/api/runs/${legacyRun.id}`, headers: { "x-test-owner": `${OWNER},${LEGACY}` } });
    expect(legacy.statusCode).toBe(200);
    expect((legacy.json() as Run).id).toBe(legacyRun.id);
  });

  it("degrades to the run without decision usage (200, not 500) when the audit read fails, and warns", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun();
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    const failing: Queryable = {
      query: (text: string, params?: unknown[]) =>
        /decision_evaluations/.test(text) ? Promise.reject(new Error("decision_evaluations unavailable")) : db.query(text, params),
    };
    const warnings: string[] = [];
    const app = buildRoute(failing, store, warnings);

    const response = await app.inject({ method: "GET", url: `/api/runs/${run.id}`, headers: { "x-test-owner": OWNER } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Run;
    expect((body.usageRoles ?? []).some((entry) => entry.role === "decision")).toBe(false);
    expect(warnings).toEqual(["decision_evaluations unavailable"]);
  });
});
