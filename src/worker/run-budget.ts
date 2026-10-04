import type { Run, RunRoleUsage, RunUsage } from "../shared/types.js";
import type { UsageTotals } from "./pi-events.js";
import { budgetWarningMessage, evaluateBudget, mergeRoleUsage, readBudgetLimits, type BudgetLimits } from "./budget.js";

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
  const warned = new Set<string>();
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
  const persist = (patch: Partial<Run>) => options.persist?.(patch);
  return {
    reserve() {
      const status = evaluateBudget({
        usage: currentUsage(),
        modelCalls: (run.modelCalls ?? 0) + pendingCalls,
        elapsedMs: Date.now() - startedAt,
        limits,
      });
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
      const status = evaluateBudget({ usage: currentUsage(), modelCalls: run.modelCalls ?? 0, elapsedMs: Date.now() - startedAt, limits });
      if (status.state !== "ok" && status.dimension && !warned.has(status.dimension)) {
        warned.add(status.dimension);
        await options.onWarning?.(budgetWarningMessage(status));
      }
    },
  };
}

function emptyUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
}
