import { describe, expect, it } from "vitest";
import { baseDemoRun } from "../server/demo-runner.js";
import type { Run } from "../shared/types.js";
import { BudgetExceededError, createRunBudget, type RunBudgetContext } from "./run-budget.js";
import { runProviderOperation } from "./provider-attempts.js";

function budgetFor(maxModelCalls: number): { run: Run; budget: RunBudgetContext } {
  const run = baseDemoRun({ title: "budget", task: "A sufficiently long delegated task", repository: "test/repo" }, "owner-a");
  run.budget = { maxTokens: 0, maxCostUsd: 0, maxModelCalls, maxDurationSeconds: 600 };
  const budget = createRunBudget({ run, startedAt: Date.now(), limits: run.budget });
  return { run, budget };
}

function attemptBudget(budget: RunBudgetContext) {
  return {
    reserve: () => budget.reserve("developer"),
    recordUnknown: () => budget.recordUnknown(),
  };
}

describe("runProviderOperation / per-attempt budget (NEW-08)", () => {
  it("counts every provider attempt and refuses the next retry at the hard cap", async () => {
    const { run, budget } = budgetFor(1);
    let calls = 0;
    let lastError: unknown;

    try {
      await runProviderOperation(async () => {
        calls += 1;
        if (calls < 3) throw new Error("503 service unavailable");
        return "ok";
      }, {
        budget: attemptBudget(budget),
        policy: { attempts: 6, baseDelayMs: 1 },
      });
    } catch (error) {
      lastError = error;
    }

    // The provider was called once; the retry was refused because the single
    // budgeted call was already consumed by the failed attempt.
    expect(calls).toBe(1);
    expect(lastError).toBeInstanceOf(BudgetExceededError);
    expect(run.modelCalls).toBe(1);
    expect(run.usageUnknownCalls).toBe(1);
  });

  it("accounts a retried failure even when a later attempt succeeds", async () => {
    const { run, budget } = budgetFor(3);
    let calls = 0;

    const result = await runProviderOperation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("502 bad gateway");
      return "ok";
    }, {
      budget: attemptBudget(budget),
      policy: { attempts: 6, baseDelayMs: 1 },
      onSuccess: () => budget.record("developer", { provider: "p", model: "m" }, {
        input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.001,
      }),
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // 2 failed attempts (unknown usage) + 1 successful attempt = 3 model calls.
    expect(run.modelCalls).toBe(3);
    expect(run.usageUnknownCalls).toBe(2);
  });

  it("leaves the normal single-attempt success path unchanged", async () => {
    const { run, budget } = budgetFor(5);
    let calls = 0;

    await runProviderOperation(async () => {
      calls += 1;
      return "ok";
    }, {
      budget: attemptBudget(budget),
      policy: { attempts: 3, baseDelayMs: 1 },
      onSuccess: () => budget.record("developer", { provider: "p", model: "m" }, {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0,
      }),
    });

    expect(calls).toBe(1);
    expect(run.modelCalls).toBe(1);
    expect(run.usageUnknownCalls).toBeUndefined();
  });
});
