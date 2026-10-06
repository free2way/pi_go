import type { Run, RunUsage } from "../shared/types.js";

export interface BudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
  maxModelCalls: number;
  maxDurationSeconds: number;
}

export type BudgetState = "ok" | "warning" | "exhausted";

/** COST-002/003: the fraction of a limit at which the 80% warning fires. */
export const BUDGET_WARNING_RATIO = 0.8;

export interface BudgetStatus {
  state: BudgetState;
  /** Which limit is closest to being reached (for messages). */
  dimension?: keyof BudgetLimits;
  used?: number;
  limit?: number;
  /** Human readable reason when the budget is exhausted. */
  reason?: string;
}

/** One configured dimension's usage reading. */
export interface BudgetReading {
  dimension: keyof BudgetLimits;
  used: number;
  limit: number;
  ratio: number;
}

/** The budget dimensions with a hard limit to compare against. */
export type BudgetUsage = Pick<
  RunUsage,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens" | "estimatedCost"
>;

/**
 * COST-002/003: reads the run-level hard budgets. Product semantics (docs/03
 * deployment record) are that a value of 0 means UNLIMITED (`生产默认全部为 0
 * （不限制）`); `evaluateBudget` already skips any limit `<= 0`. When nothing is
 * configured at all the duration budget is unlimited (0) rather than an eager
 * default, so an unconfigured worker does not terminate runs with a timeout.
 */
export function readBudgetLimits(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  return {
    maxTokens: Number(env.PI_RUN_MAX_TOKENS || 0),
    maxCostUsd: Number(env.PI_RUN_MAX_COST_USD || 0),
    maxModelCalls: Number(env.PI_RUN_MAX_MODEL_CALLS || 0),
    maxDurationSeconds: Number(env.PI_RUN_MAX_DURATION_SECONDS || env.PI_RUN_TIMEOUT_SECONDS || 0),
  };
}

export interface BudgetEvaluationInput {
  usage: BudgetUsage;
  modelCalls: number;
  elapsedMs: number;
  limits: BudgetLimits;
}

/**
 * COST-002/003: every configured (limit > 0) dimension's usage reading, in a
 * stable order. Warnings are per dimension, so the tracker needs each reading
 * rather than only the single worst status `evaluateBudget` returns.
 */
export function budgetReadings(input: BudgetEvaluationInput): BudgetReading[] {
  const totalTokens = input.usage.totalTokens
    ?? input.usage.inputTokens + input.usage.outputTokens + (input.usage.cacheReadTokens ?? 0) + (input.usage.cacheWriteTokens ?? 0);
  const measurements: Array<[keyof BudgetLimits, number, number]> = [
    ["maxTokens", totalTokens, input.limits.maxTokens],
    ["maxCostUsd", input.usage.estimatedCost, input.limits.maxCostUsd],
    ["maxModelCalls", input.modelCalls, input.limits.maxModelCalls],
    ["maxDurationSeconds", input.elapsedMs / 1000, input.limits.maxDurationSeconds],
  ];
  const readings: BudgetReading[] = [];
  for (const [dimension, used, limit] of measurements) {
    if (limit <= 0) continue;
    readings.push({ dimension, used, limit, ratio: used / limit });
  }
  return readings;
}

/**
 * COST-002 / COST-003 / AT-PERF-008: run level hard budgets. The tracker decides
 * when to warn (>=80%) and when to stop starting new model calls (>=100%).
 */
export function evaluateBudget(input: BudgetEvaluationInput): BudgetStatus {
  let worst: BudgetStatus = { state: "ok" };
  for (const { dimension, used, limit, ratio } of budgetReadings(input)) {
    if (ratio >= 1) {
      return {
        state: "exhausted",
        dimension,
        used,
        limit,
        reason: budgetReason(dimension, used, limit),
      };
    }
    if (ratio >= BUDGET_WARNING_RATIO && worst.state === "ok") {
      worst = { state: "warning", dimension, used, limit };
    }
  }
  return worst;
}

function budgetReason(dimension: keyof BudgetLimits, used: number, limit: number) {
  switch (dimension) {
    case "maxTokens":
      return `token 预算已用尽（${Math.round(used)} / ${limit}）`;
    case "maxCostUsd":
      return `费用预算已用尽（$${used.toFixed(4)} / $${limit}）`;
    case "maxModelCalls":
      return `模型调用次数预算已用尽（${used} / ${limit}）`;
    default:
      return `运行时长预算已用尽（${Math.round(used)}s / ${limit}s）`;
  }
}

export function budgetWarningMessage(status: BudgetStatus) {
  if (!status.dimension) return "已接近运行预算上限";
  const label: Record<keyof BudgetLimits, string> = {
    maxTokens: "token",
    maxCostUsd: "费用",
    maxModelCalls: "模型调用次数",
    maxDurationSeconds: "运行时长",
  };
  const used = status.dimension === "maxCostUsd" ? `$${Number(status.used).toFixed(4)}` : Math.round(Number(status.used));
  return `${label[status.dimension]}预算已使用 80%（${used} / ${status.limit}），接近硬上限`;
}

/** Rolls one role's usage into the run document (COST-001). */
export function mergeRoleUsage(run: Run, entry: { role: string; provider: string; model: string; usage: RunUsage; calls?: number }) {
  const roles = run.usageRoles ? [...run.usageRoles] : [];
  const index = roles.findIndex((item) => item.role === entry.role && item.model === entry.model);
  const calls = entry.calls ?? 1;
  if (index === -1) {
    roles.push({
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: entry.usage.cacheWriteTokens ?? 0,
      estimatedCost: entry.usage.estimatedCost,
      calls,
    });
  } else {
    const current = roles[index];
    roles[index] = {
      ...current,
      inputTokens: current.inputTokens + entry.usage.inputTokens,
      outputTokens: current.outputTokens + entry.usage.outputTokens,
      cacheReadTokens: (current.cacheReadTokens ?? 0) + (entry.usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (entry.usage.cacheWriteTokens ?? 0),
      estimatedCost: current.estimatedCost + entry.usage.estimatedCost,
      calls: current.calls + calls,
    };
  }
  run.usageRoles = roles;
  run.modelCalls = (run.modelCalls ?? 0) + calls;
  return roles;
}
