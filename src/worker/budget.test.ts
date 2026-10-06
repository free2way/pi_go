import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types.js";
import { BUDGET_WARNING_RATIO, budgetReadings, budgetWarningMessage, evaluateBudget, mergeRoleUsage, readBudgetLimits } from "./budget.js";
import { baseRealRun } from "../server/real-run.js";

const usage = (totalTokens: number, cost: number) => ({
  inputTokens: totalTokens - 100,
  outputTokens: 100,
  estimatedCost: cost,
  totalTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe("evaluateBudget", () => {
  const limits = { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 4, maxDurationSeconds: 600 };

  it("reports ok well below the limits", () => {
    expect(evaluateBudget({ usage: usage(100, 0.05), modelCalls: 1, elapsedMs: 1_000, limits }).state).toBe("ok");
  });

  it("warns at 80% of the tightest dimension (AT-PERF-008)", () => {
    const status = evaluateBudget({ usage: usage(820, 0.05), modelCalls: 1, elapsedMs: 1_000, limits });
    expect(status.state).toBe("warning");
    expect(status.dimension).toBe("maxTokens");
    expect(budgetWarningMessage(status)).toContain("80%");
  });

  it("stops at 100% and names the exhausted dimension", () => {
    const tokens = evaluateBudget({ usage: usage(1000, 0.05), modelCalls: 1, elapsedMs: 1_000, limits });
    expect(tokens.state).toBe("exhausted");
    expect(tokens.reason).toContain("token");
    expect(budgetWarningMessage(tokens)).toBeTruthy();

    const cost = evaluateBudget({ usage: usage(10, 1.5), modelCalls: 1, elapsedMs: 1_000, limits });
    expect(cost.dimension).toBe("maxCostUsd");

    const calls = evaluateBudget({ usage: usage(10, 0.1), modelCalls: 4, elapsedMs: 1_000, limits });
    expect(calls.dimension).toBe("maxModelCalls");

    const duration = evaluateBudget({ usage: usage(10, 0.1), modelCalls: 1, elapsedMs: 700_000, limits });
    expect(duration.dimension).toBe("maxDurationSeconds");
  });

  it("ignores disabled limits", () => {
    const off = { maxTokens: 0, maxCostUsd: 0, maxModelCalls: 0, maxDurationSeconds: 0 };
    expect(evaluateBudget({ usage: usage(9_999_999, 999), modelCalls: 99, elapsedMs: 10_000_000, limits: off }).state).toBe("ok");
  });

  it("exposes every configured dimension's reading so each can warn once", () => {
    const readings = budgetReadings({ usage: usage(900, 0.9), modelCalls: 1, elapsedMs: 1_000, limits });
    expect(readings.map((reading) => reading.dimension)).toEqual(["maxTokens", "maxCostUsd", "maxModelCalls", "maxDurationSeconds"]);
    // 900/1000 tokens and 0.9/1 cost are both past the 80% threshold at once.
    expect(readings.filter((reading) => reading.ratio >= BUDGET_WARNING_RATIO).map((reading) => reading.dimension))
      .toEqual(["maxTokens", "maxCostUsd"]);
    // Disabled limits (<= 0) are never reported.
    expect(budgetReadings({ usage: usage(900, 0.9), modelCalls: 1, elapsedMs: 1_000, limits: { ...limits, maxCostUsd: 0 } }).map((reading) => reading.dimension))
      .toEqual(["maxTokens", "maxModelCalls", "maxDurationSeconds"]);
  });
});

describe("readBudgetLimits", () => {
  it("reads env configuration with a duration fallback to the run timeout", () => {
    const limits = readBudgetLimits({ PI_RUN_MAX_TOKENS: "5000", PI_RUN_MAX_COST_USD: "2.5", PI_RUN_TIMEOUT_SECONDS: "900" } as NodeJS.ProcessEnv);
    expect(limits).toEqual({ maxTokens: 5000, maxCostUsd: 2.5, maxModelCalls: 0, maxDurationSeconds: 900 });
  });

  it("treats an absent duration budget as unlimited (0), not an eager default", () => {
    expect(readBudgetLimits({} as NodeJS.ProcessEnv).maxDurationSeconds).toBe(0);
    expect(readBudgetLimits({ PI_RUN_MAX_DURATION_SECONDS: "0" } as NodeJS.ProcessEnv).maxDurationSeconds).toBe(0);
    // An explicit 0 duration wins over the run-timeout fallback (0 = unlimited).
    expect(readBudgetLimits({ PI_RUN_MAX_DURATION_SECONDS: "0", PI_RUN_TIMEOUT_SECONDS: "900" } as NodeJS.ProcessEnv).maxDurationSeconds).toBe(0);
  });
});

describe("mergeRoleUsage", () => {
  const run = (): Run => baseRealRun({
    title: "usage",
    task: "usage accounting test task",
    repository: "/srv/pi_go",
    workspaceId: "ws_1",
    mode: "real",
    checks: ["npm test"],
    developerModel: { provider: "deepseek", model: "deepseek-flash" },
    reviewerModel: { provider: "openai-proxy", model: "gpt-5.6-sol" },
  }, "owner");

  it("records per-role usage and accumulates repeats (COST-001)", () => {
    const target = run();
    mergeRoleUsage(target, { role: "planner", provider: "deepseek", model: "deepseek-flash", usage: usage(1000, 0.01) });
    mergeRoleUsage(target, { role: "developer", provider: "deepseek", model: "deepseek-flash", usage: usage(2000, 0.02) });
    mergeRoleUsage(target, { role: "developer", provider: "deepseek", model: "deepseek-flash", usage: usage(500, 0.005) });
    mergeRoleUsage(target, { role: "reviewer", provider: "openai-proxy", model: "gpt-5.6-sol", usage: usage(800, 0.03) });

    expect(target.modelCalls).toBe(4);
    expect(target.usageRoles?.map((item) => `${item.role}:${item.calls}:${item.estimatedCost.toFixed(3)}`)).toEqual([
      "planner:1:0.010",
      "developer:2:0.025",
      "reviewer:1:0.030",
    ]);
    const developer = target.usageRoles?.find((item) => item.role === "developer");
    expect(developer?.inputTokens).toBe(1900 + 400);
  });
});
