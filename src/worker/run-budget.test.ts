import { describe, expect, it } from "vitest";
import { baseDemoRun } from "../server/demo-runner.js";
import type { Run } from "../shared/types.js";
import { addUsage, toRunUsage, type UsageTotals } from "./pi-events.js";
import { BudgetExceededError, createRunBudget } from "./run-budget.js";
import type { BudgetLimits } from "./budget.js";

/**
 * COST-002/003 regression: the 80% warning must be emitted exactly once per
 * dimension when the run first crosses the threshold — including the case where
 * a single model call sails past 80% straight to (or beyond) the 100% cap.
 *
 * These tests reproduce the real worker ordering: `executeJob` seeds a live
 * `UsageTotals` accumulator from the run document, passes it to
 * `createRunBudget`, and only folds each call's usage into it *after*
 * `budget.record` returns (see index.ts runPiWithRetry / addUsage).
 */

const tokensOnly = (maxTokens: number): BudgetLimits => ({ maxTokens, maxCostUsd: 0, maxModelCalls: 0, maxDurationSeconds: 0 });

function usageDelta(totalTokens: number, cost = 0): UsageTotals {
  return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost };
}

type Seed = { usage?: Partial<Run["usage"]>; modelCalls?: number };

function harness(limits: BudgetLimits, seed: Seed = {}) {
  const run = baseDemoRun({ title: "run budget warning", task: "A sufficiently long delegated task", repository: "test/repo" }, "owner-a");
  run.budget = limits;
  run.usage = {
    inputTokens: seed.usage?.inputTokens ?? 0,
    outputTokens: seed.usage?.outputTokens ?? 0,
    estimatedCost: seed.usage?.estimatedCost ?? 0,
    cacheReadTokens: seed.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: seed.usage?.cacheWriteTokens ?? 0,
    totalTokens: seed.usage?.totalTokens ?? 0,
  };
  run.modelCalls = seed.modelCalls ?? 0;

  const accumulator: UsageTotals = {
    input: run.usage.inputTokens,
    output: run.usage.outputTokens,
    cacheRead: run.usage.cacheReadTokens ?? 0,
    cacheWrite: run.usage.cacheWriteTokens ?? 0,
    totalTokens: run.usage.totalTokens ?? 0,
    cost: run.usage.estimatedCost,
  };
  const warnings: string[] = [];
  const budget = createRunBudget({
    run,
    startedAt: Date.now(),
    limits,
    usage: () => toRunUsage(accumulator),
    onWarning: async (message) => {
      warnings.push(message);
    },
  });
  /** One model call: reserve → provider result → account, then fold into the tracker. */
  const call = async (delta: UsageTotals) => {
    budget.reserve("developer");
    await budget.record("developer", { provider: "p", model: "m" }, delta);
    addUsage(accumulator, delta);
  };
  return { run, budget, warnings, call };
}

describe("run budget 80% warning (COST-002/003)", () => {
  it("warns once when a single call crosses 80% but stays under the cap", async () => {
    const { warnings, budget, call } = harness(tokensOnly(1000));
    await call(usageDelta(820));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("80%");
    expect(warnings[0]).toContain("token");
    // Still under the cap: the run keeps going.
    expect(() => budget.reserve("developer")).not.toThrow();
  });

  it("warns then exhausts (each once, in order) when a single call crosses both 80% and 100%", async () => {
    const { warnings, budget, call } = harness(tokensOnly(1000));
    await call(usageDelta(1200));
    // The warning is recorded before the run is stopped by the hard cap.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("80%");
    expect(warnings[0]).toContain("token");

    expect(() => budget.reserve("developer")).toThrow(BudgetExceededError);
    // Exhaustion never re-emits or duplicates the warning.
    expect(warnings).toHaveLength(1);
  });

  it("warns once at 80% then exhausts once at 100% across many small calls", async () => {
    const { warnings, budget, call } = harness(tokensOnly(1000));
    await call(usageDelta(300));
    await call(usageDelta(300));
    expect(warnings).toHaveLength(0);

    await call(usageDelta(300)); // 900 = 90%
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("80%");

    await call(usageDelta(300)); // 1200: over the cap on the post-call reading
    expect(warnings).toHaveLength(1);

    expect(() => budget.reserve("developer")).toThrow(BudgetExceededError);
    expect(warnings).toHaveLength(1);
  });

  it("emits neither event when the run never crosses 80%", async () => {
    const { warnings, budget, call } = harness(tokensOnly(1000));
    await call(usageDelta(200));
    await call(usageDelta(200));
    await call(usageDelta(200));
    expect(warnings).toHaveLength(0);
    expect(() => budget.reserve("developer")).not.toThrow();
  });

  it("warns once per dimension with both token and cost budgets (no duplicate warnings)", async () => {
    const limits: BudgetLimits = { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 0, maxDurationSeconds: 0 };
    const { warnings, budget, call } = harness(limits);

    await call(usageDelta(500, 0.9)); // cost crosses 80%
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("费用");

    await call(usageDelta(400, 0.05)); // tokens reach 900 = 90%
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("token");

    await call(usageDelta(200, 0.05)); // tokens reach 1100: over the cap, no re-warning
    expect(warnings).toHaveLength(2);

    expect(() => budget.reserve("developer")).toThrow(BudgetExceededError);
    expect(warnings).toHaveLength(2);
    expect(new Set(warnings).size).toBe(2);
  });

  it("does not re-emit a warning a resumed/reclaimed run already emitted", async () => {
    // Resumed run: 900/1000 tokens were already consumed (and warned) before
    // this job started, so the threshold crossing happened in an earlier run.
    const { warnings, budget, call } = harness(tokensOnly(1000), {
      usage: { inputTokens: 900, outputTokens: 0, estimatedCost: 0, totalTokens: 900 },
      modelCalls: 3,
    });
    await call(usageDelta(50));
    expect(warnings).toHaveLength(0);
    expect(() => budget.reserve("developer")).not.toThrow();
  });
});
