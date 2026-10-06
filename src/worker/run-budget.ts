import type { Run, RunRoleUsage, RunUsage } from "../shared/types.js";
import type { UsageTotals } from "./pi-events.js";
import {
  BUDGET_WARNING_RATIO,
  budgetReadings,
  budgetWarningMessage,
  evaluateBudget,
  mergeRoleUsage,
  readBudgetLimits,
  type BudgetLimits,
} from "./budget.js";

/** COST-002/003: per-run budget guard shared by every model call. */
export interface RunBudgetContext {
  /**
   * AUD-10/NEW-08: atomically reserves one model-call slot before an attempt
   * starts, and throws once the hard model-call limit would be exceeded.
   */
  reserve(role: RunRoleUsage["role"]): void;
  /** Releases a reservation that never produced usage. */
  release(): void;
  /**
   * NEW-08: records one provider attempt whose call count is known but whose
   * token usage could not be determined. Counts as a model call and sets the
   * unknown-usage flag so a retried failure is never free.
   */
  recordUnknown(): void;
  record(role: RunRoleUsage["role"], input: { provider: string; model: string }, usage: UsageTotals): Promise<void>;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface CreateRunBudgetOptions {
  run: Run;
  startedAt: number;
  limits?: BudgetLimits;
  /** Live usage, defaulting to the run document. */
  usage?: () => RunUsage;
  /** Best-effort persistence hook for accounting patches. */
  persist?: (patch: Partial<Run>) => void | Promise<void>;
  onWarning?: (message: string) => Promise<void>;
}

/**
 * COST-002/003 / AT-PERF-008: wires budget limits, per-role usage and 80%
 * warnings into a running job. Reservations make parallel sub-agents account for
 * each other, so a limit of N can never be exceeded by N+1 concurrent calls.
 */
export function createRunBudget(options: CreateRunBudgetOptions): RunBudgetContext {
  const { run, startedAt } = options;
  const limits = options.limits ?? readBudgetLimits();
  const usageProvider = options.usage ?? (() => run.usage ?? emptyUsage());
  let pendingCalls = 0;
  const currentUsage = () => {
    const live = usageProvider();
    return {
      inputTokens: live.inputTokens,
      outputTokens: live.outputTokens,
      cacheReadTokens: live.cacheReadTokens ?? 0,
      cacheWriteTokens: live.cacheWriteTokens ?? 0,
      totalTokens: live.totalTokens ?? (live.inputTokens + live.outputTokens + (live.cacheReadTokens ?? 0) + (live.cacheWriteTokens ?? 0)),
      estimatedCost: live.estimatedCost,
    };
  };
  const statusAt = (usage: RunUsage, modelCalls: number) =>
    evaluateBudget({ usage, modelCalls, elapsedMs: Date.now() - startedAt, limits });
  // The 80% warning fires once per dimension on the first crossing. A resumed or
  // reclaimed run may already sit above 80% (the crossing happened in an earlier
  // execution), so seed the set from the starting usage instead of re-emitting.
  const warned = new Set<string>(
    budgetReadings({ usage: currentUsage(), modelCalls: run.modelCalls ?? 0, elapsedMs: Date.now() - startedAt, limits })
      .filter((reading) => reading.ratio >= BUDGET_WARNING_RATIO)
      .map((reading) => reading.dimension),
  );
  const persist = (patch: Partial<Run>) => options.persist?.(patch);
  return {
    reserve() {
      const status = statusAt(currentUsage(), (run.modelCalls ?? 0) + pendingCalls);
      if (status.state === "exhausted") throw new BudgetExceededError(status.reason ?? "运行预算已用尽");
      pendingCalls += 1;
    },
    release() {
      pendingCalls = Math.max(0, pendingCalls - 1);
    },
    recordUnknown() {
      pendingCalls = Math.max(0, pendingCalls - 1);
      run.modelCalls = (run.modelCalls ?? 0) + 1;
      run.usageUnknownCalls = (run.usageUnknownCalls ?? 0) + 1;
      void Promise.resolve(persist({ modelCalls: run.modelCalls, usageUnknownCalls: run.usageUnknownCalls })).catch(() => undefined);
    },
    async record(role, input, usageTotals) {
      pendingCalls = Math.max(0, pendingCalls - 1);
      const usage: RunUsage = {
        inputTokens: Math.round(usageTotals.input),
        outputTokens: Math.round(usageTotals.output),
        cacheReadTokens: Math.round(usageTotals.cacheRead),
        cacheWriteTokens: Math.round(usageTotals.cacheWrite),
        totalTokens: Math.round(usageTotals.totalTokens),
        estimatedCost: usageTotals.cost,
      };
      mergeRoleUsage(run, { role, provider: input.provider, model: input.model, usage });
      await persist({ usageRoles: run.usageRoles, modelCalls: run.modelCalls, usageUnknownCalls: run.usageUnknownCalls });
      // The caller folds this call's usage into the live tracker only after
      // `record` returns, so the pre-call snapshot would miss the crossing when a
      // single call sails past 80% (straight past 100%): evaluate the post-call
      // total explicitly. Warnings are per dimension and deduplicated, while the
      // hard cap itself is still enforced by `reserve`.
      const postCall = addUsageTotals(currentUsage(), usage);
      for (const reading of budgetReadings({ usage: postCall, modelCalls: run.modelCalls ?? 0, elapsedMs: Date.now() - startedAt, limits })) {
        if (reading.ratio < BUDGET_WARNING_RATIO || warned.has(reading.dimension)) continue;
        warned.add(reading.dimension);
        await options.onWarning?.(budgetWarningMessage({
          state: reading.ratio >= 1 ? "exhausted" : "warning",
          dimension: reading.dimension,
          used: reading.used,
          limit: reading.limit,
        }));
      }
    },
  };
}

function addUsageTotals(base: RunUsage, delta: RunUsage): RunUsage {
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
    totalTokens: (base.totalTokens ?? base.inputTokens + base.outputTokens + (base.cacheReadTokens ?? 0) + (base.cacheWriteTokens ?? 0))
      + (delta.totalTokens ?? delta.inputTokens + delta.outputTokens),
    estimatedCost: base.estimatedCost + delta.estimatedCost,
  };
}

function emptyUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
}
