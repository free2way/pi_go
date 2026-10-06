import { describe, expect, it } from "vitest";
import type { Run, RunRoleUsage } from "../shared/types.js";
import { DecisionAuditStore } from "./decision-engine/audit-store.js";
import type { DecisionEvaluationRecord } from "./decision-engine/types.js";
import {
  DECISION_USAGE_PROVIDER,
  DECISION_USAGE_ROLE,
  collectDecisionUsageRows,
  mergeDecisionUsage,
  readDecisionUsage,
  readDecisionUsageSafe,
  summarizeDecisionUsage,
} from "./decision-usage.js";
import { baseRealRun } from "./real-run.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { createTestDb } from "./test-db.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function makeRun(overrides: Partial<Run> = {}): Run {
  const run = baseRealRun(
    { title: "决策用量测试", task: "为决策用量构造测试数据。", repository: "/srv/workspace/pi_go", workspaceId: "ws_1", mode: "real", checks: [] },
    "owner_1",
  );
  return { ...run, state: "needs_human", round: 2, ...overrides };
}

/** A completed decision row, defaulting to one priced-looking provider call. */
function decisionRecord(overrides: Partial<DecisionEvaluationRecord> = {}): DecisionEvaluationRecord {
  const evaluationId = overrides.evaluationId ?? `dev_${Math.random().toString(36).slice(2, 12)}`;
  return {
    evaluationId,
    runId: "run_unused",
    kind: "review_triage",
    mode: "shadow",
    provider: "typesafe",
    requestedModel: "jev-latest",
    resolvedModel: "jev-1.13.0",
    policyVersion: "review-triage-v1",
    stateHash: "f".repeat(64),
    status: "completed",
    answers: [],
    latencyMs: 120,
    inputTokens: 100,
    outputTokens: 20,
    createdAt: at(1),
    stateManifest: {},
    questionSchemaHash: "a".repeat(64),
    idempotencyKey: `idem_${evaluationId}`,
    ...overrides,
  };
}

async function seedDecision(
  db: Awaited<ReturnType<typeof createTestDb>>,
  run: Run,
  rows: Partial<DecisionEvaluationRecord>[],
): Promise<void> {
  const audit = new DecisionAuditStore(db);
  for (const [index, row] of rows.entries()) {
    await audit.insert(
      decisionRecord({
        runId: run.id,
        evaluationId: `dev_${index}_${run.id.slice(-6)}`,
        idempotencyKey: `idem_${index}_${run.id}`,
        createdAt: at(index + 1),
        ...row,
      }),
    );
  }
}

function decisionEntries(run: Run): RunRoleUsage[] {
  return (run.usageRoles ?? []).filter((entry) => entry.role === DECISION_USAGE_ROLE);
}

/** Recursively freezes a value so any mutation attempt throws (strict mode). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

describe("decision usage aggregation (AT-JEV-061/062)", () => {
  it("groups completed rows by resolved_model (falling back to requested_model) and sums tokens/calls", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun();
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await seedDecision(db, run, [
      // Two rows for the same resolved model, one of them resolved via the
      // requested-model fallback (resolved_model is NULL for it).
      { resolvedModel: "jev-1.13.0", inputTokens: 100, outputTokens: 20 },
      { resolvedModel: undefined, requestedModel: "jev-1.13.0", inputTokens: 50, outputTokens: 5 },
      { resolvedModel: "jev-1.14.0", inputTokens: 10, outputTokens: 2, requestedModel: "jev-latest" },
    ]);

    const merged = await readDecisionUsage(db, run);
    const entries = decisionEntries(merged);

    expect(entries).toHaveLength(2);
    const older = entries.find((entry) => entry.model === "jev-1.13.0");
    expect(older).toMatchObject({
      role: "decision",
      provider: DECISION_USAGE_PROVIDER,
      inputTokens: 150,
      outputTokens: 25,
      calls: 2,
    });
    const newer = entries.find((entry) => entry.model === "jev-1.14.0");
    expect(newer).toMatchObject({ inputTokens: 10, outputTokens: 2, calls: 1 });
  });

  it("marks every decision call unpriced and never fabricates a cost (AT-JEV-062)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun();
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await seedDecision(db, run, [
      { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.42 },
      { inputTokens: 1, outputTokens: 1 },
    ]);

    const merged = await readDecisionUsage(db, run);
    const [entry] = decisionEntries(merged);

    expect(entry.calls).toBe(2);
    expect(entry.unpricedCalls).toBe(entry.calls);
    // Even though the audit row carried a cost, the role has no price table and
    // must report "unknown" (0 with every call counted unpriced), not $0.00.
    expect(entry.estimatedCost).toBe(0);
  });

  it("ignores rows that are not completed", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun();
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await seedDecision(db, run, [
      { status: "fallback", inputTokens: 999, outputTokens: 999 },
      { status: "rejected", inputTokens: 5, outputTokens: 5 },
      { status: "disabled", inputTokens: 7, outputTokens: 7 },
    ]);

    const rows = await collectDecisionUsageRows(db, run);
    expect(rows).toHaveLength(0);
    const merged = await readDecisionUsage(db, run);
    expect(decisionEntries(merged)).toEqual([]);
    expect(merged.usageRoles).toBeUndefined();
  });

  it("returns the run unchanged when there are no completed decision rows", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun();
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });

    const merged = await readDecisionUsage(db, run);

    expect(merged).toEqual(run);
    // No empty placeholder entry and no fabricated 0-cost row.
    expect(merged.usageRoles).toBeUndefined();
  });

  it("does not mutate the input run (deep-frozen) and returns a new object", () => {
    const base = makeRun({
      usage: { inputTokens: 10, outputTokens: 4, estimatedCost: 1.5 },
      usageUnknownCalls: 3,
      modelCalls: 7,
      usageRoles: [{ role: "developer", provider: "deepseek", model: "deepseek-flash", inputTokens: 10, outputTokens: 4, estimatedCost: 1.5, calls: 1 }],
    });
    const before = structuredClone(base);
    // A real freeze: a mutating implementation throws in strict mode instead of
    // silently passing a structural comparison.
    deepFreeze(base);
    const entries = summarizeDecisionUsage([
      { resolved_model: "jev-1.13.0", input_tokens: 100, output_tokens: 20 },
    ]);

    const merged = mergeDecisionUsage(base, entries);

    expect(merged).not.toBe(base);
    expect(merged.usageRoles).not.toBe(base.usageRoles);
    // The original object and its nested arrays are untouched.
    expect(base).toEqual(before);
    expect(base.usageRoles).toHaveLength(1);
    expect(base.usageRoles?.[0]?.inputTokens).toBe(10);
  });

  it("merges into an existing role+model entry instead of adding a duplicate", () => {
    const base = makeRun({
      usageRoles: [
        { role: "decision", provider: "typesafe", model: "jev-1.13.0", inputTokens: 10, outputTokens: 3, estimatedCost: 0, calls: 1, unpricedCalls: 1 },
      ],
    });

    const merged = mergeDecisionUsage(base, summarizeDecisionUsage([
      { resolved_model: "jev-1.13.0", input_tokens: 100, output_tokens: 20 },
      { resolved_model: "jev-1.13.0", input_tokens: 5, output_tokens: 1 },
    ]));

    expect(merged.usageRoles).toHaveLength(1);
    expect(merged.usageRoles?.[0]).toMatchObject({
      role: "decision",
      model: "jev-1.13.0",
      inputTokens: 115,
      outputTokens: 24,
      calls: 3,
      unpricedCalls: 3,
      estimatedCost: 0,
    });
  });

  it("never folds decision usage into usage, usageUnknownCalls or developer/reviewer entries", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun({
      usage: { inputTokens: 1_000, outputTokens: 400, estimatedCost: 12.5 },
      usageUnknownCalls: 2,
      modelCalls: 9,
      usageRoles: [
        { role: "developer", provider: "deepseek", model: "deepseek-flash", inputTokens: 800, outputTokens: 300, estimatedCost: 10, calls: 3 },
        { role: "reviewer", provider: "openai-proxy", model: "gpt-5.6-sol", inputTokens: 200, outputTokens: 100, estimatedCost: 2.5, calls: 1 },
      ],
    });
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await seedDecision(db, run, [{ inputTokens: 500, outputTokens: 50 }]);

    const merged = await readDecisionUsage(db, run);

    expect(merged.usage).toEqual(run.usage);
    expect(merged.usageUnknownCalls).toBe(2);
    expect(merged.modelCalls).toBe(9);
    const developer = merged.usageRoles?.find((entry) => entry.role === "developer");
    const reviewer = merged.usageRoles?.find((entry) => entry.role === "reviewer");
    expect(developer).toMatchObject({ inputTokens: 800, outputTokens: 300, calls: 3 });
    expect(reviewer).toMatchObject({ inputTokens: 200, outputTokens: 100, calls: 1 });
    expect(merged.usageRoles?.find((entry) => entry.role === "decision")).toMatchObject({ inputTokens: 500, outputTokens: 50, calls: 1 });
  });

  it("is idempotent: repeated reads of the same run give identical results because nothing is written", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    const run = makeRun();
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: at(0) });
    await seedDecision(db, run, [
      { resolvedModel: "jev-1.13.0", inputTokens: 100, outputTokens: 20 },
      { resolvedModel: "jev-1.14.0", inputTokens: 10, outputTokens: 2 },
    ]);

    const first = await readDecisionUsage(db, run);
    const second = await readDecisionUsage(db, run);
    const third = await readDecisionUsage(db, run);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // The persisted run document was never modified by the aggregation.
    const [latest] = store.listRuns(["owner_1"]);
    expect(latest?.usageRoles ?? []).toEqual([]);
  });

  it("degrades to the untouched run when the audit query fails", async () => {
    const run = makeRun();
    const failure = new Error("relation \"decision_evaluations\" does not exist");
    let seen: unknown;
    const merged = await readDecisionUsageSafe({ query: () => Promise.reject(failure) }, run, (error) => { seen = error; });

    expect(merged).toBe(run);
    expect(seen).toBe(failure);
  });

  it("drops rows without a usable model name instead of throwing", () => {
    expect(summarizeDecisionUsage([
      { resolved_model: "", requested_model: "" },
      { resolved_model: null, requested_model: "  " },
      { resolved_model: "jev-1.13.0", requested_model: "jev-latest", input_tokens: 4, output_tokens: 1 },
    ])).toEqual([
      { role: "decision", provider: "typesafe", model: "jev-1.13.0", inputTokens: 4, outputTokens: 1, estimatedCost: 0, calls: 1, unpricedCalls: 1 },
    ]);
  });
});
