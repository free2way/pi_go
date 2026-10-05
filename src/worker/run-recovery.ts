import type { Run, RunState } from "../shared/types.js";
import { evaluateBudget, type BudgetLimits } from "./budget.js";
import { runDeadlineDelayMs } from "./run-deadline.js";

/**
 * NEW-04 / AT-RUN-008/011 / REL-002: recovery of a job whose Worker died
 * mid-flight. Re-claiming a started job used to force the run back to
 * `preparing`, but the state machine forbids `developing|checking|reviewing ->
 * preparing`, so recovery failed with `Illegal run state transition` and the
 * run was parked as `needs_human`.
 *
 * A reclaimed job instead preserves its current phase (a self-transition is a
 * no-op for the state machine) and resumes from the stored checkpoints. Only an
 * explicit human action chooses its own entry state (`resume` re-prepares,
 * `retryReview` re-enters review).
 */
export type RecoveryPhase = "planning" | "development" | "checks" | "review";

export interface RecoveryStateInput {
  /** Run state persisted by the previous worker. */
  current: RunState;
  /** Human-triggered continue from `needs_human`. */
  resume?: boolean;
  /** Human-triggered reviewer-only retry. */
  retryReview?: boolean;
}

export function recoveryUpdateState(input: RecoveryStateInput): RunState {
  if (input.retryReview) return "reviewing";
  if (input.resume) {
    // 人工"继续开发"：服务器已把状态推进到工作阶段（developing/checking/reviewing），
    // 此时必须保留当前阶段——强行回到 preparing 会被状态机拒绝
    // （developing|checking|reviewing -> preparing 非法），任务会被打回 needs_human。
    // 只有从还没有工作阶段的入口（如 needs_human）恢复时才重新 prepare。
    if (input.current === "developing" || input.current === "checking" || input.current === "reviewing") {
      return input.current;
    }
    return "preparing";
  }
  return input.current;
}

/** Pipeline phase the worker continues from, based on the preserved state. */
export function recoveryResumePhase(current: RunState): RecoveryPhase {
  switch (current) {
    case "developing":
      return "development";
    case "checking":
      return "checks";
    case "reviewing":
      return "review";
    default:
      return "planning";
  }
}

/** The max-rounds terminal message, shared by the loop exit and the recovery guard. */
export const MAX_ROUNDS_MESSAGE = "达到最大审核轮次，需要人工处理";

export type RecoveryStopReason = "max_rounds" | "budget_exhausted" | "deadline_exceeded";

export interface RecoveryStop {
  stop: true;
  reason: RecoveryStopReason;
  /** Event type the stop is recorded with (existing semantics). */
  eventType: string;
  message: string;
}

export interface RecoveryProceed {
  stop: false;
}

export type RecoveryPlan = RecoveryStop | RecoveryProceed;

export interface RecoveryPlanningInput {
  /** Run state persisted by the previous worker. */
  state: RunState;
  /**
   * True for an automatic reclaim of a started job. Human `resume`/`retryReview`
   * choose their own entry point and a fresh window, so they are never stopped
   * by this guard.
   */
  recovery: boolean;
  resume?: boolean;
  retryReview?: boolean;
  /** Round counters persisted on the run document. */
  round?: number;
  maxRounds?: number;
  /** Persisted usage/model calls already spent by the run. */
  usage?: Run["usage"];
  modelCalls?: number;
  /** Hard limits the run is evaluated against (run budget or worker defaults). */
  limits?: BudgetLimits;
  createdAt?: string;
  deadlineBaseAt?: string;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: number;
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * R3-001 / R3-FINAL-ROUND-AMBIGUOUS: pure recovery policy evaluated *before* the
 * worktree-dependent recovery/preparation steps.
 *
 * A reclaimed job used to reach the missing-worktree failure first, so a run
 * that had already reached a terminal stop condition (max rounds, exhausted
 * budget, elapsed deadline) was reprocessed instead of stopping. These terminal
 * conditions are independent of the worktree, so they are evaluated up front and
 * reported with their existing event types/messages. The worktree is still
 * required (fail-closed) for a claim that genuinely resumes mid-flight.
 *
 * Round-awareness: a reclaim at `round >= maxRounds` stops with the existing
 * max-rounds message instead of re-entering the loop. Sparse/undefined
 * `maxRounds` (legacy run documents) proceeds, so the guard is backward
 * compatible.
 */
export function planRecovery(input: RecoveryPlanningInput): RecoveryPlan {
  // Human actions (resume / retry review) own their entry state and get a fresh
  // deadline window; never pre-empt them with an automatic stop.
  if (!input.recovery || input.resume || input.retryReview) return { stop: false };

  // 1. Maximum rounds already reached (or exceeded).
  if (finite(input.round) && finite(input.maxRounds) && input.maxRounds >= 1 && input.round >= input.maxRounds) {
    return { stop: true, reason: "max_rounds", eventType: "run.needs_human", message: MAX_ROUNDS_MESSAGE };
  }

  // 2. Hard budget (tokens / cost / model calls) already exhausted. Duration is
  // handled by the deadline branch below so the two keep distinct semantics.
  if (input.limits) {
    const usage = input.usage;
    const status = evaluateBudget({
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        totalTokens: usage?.totalTokens,
        estimatedCost: usage?.estimatedCost ?? 0,
      },
      modelCalls: input.modelCalls ?? 0,
      elapsedMs: 0,
      limits: { ...input.limits, maxDurationSeconds: 0 },
    });
    if (status.state === "exhausted") {
      return {
        stop: true,
        reason: "budget_exhausted",
        eventType: "run.budget_exhausted",
        message: `运行预算已用尽，已停止新的模型调用：${status.reason ?? "运行预算已用尽"}`,
      };
    }
  }

  // 3. Duration deadline already elapsed (0/absent = unlimited, so no stop).
  if (input.limits) {
    const createdAt = input.createdAt ? Date.parse(input.createdAt) : Number.NaN;
    if (Number.isFinite(createdAt)) {
      const now = input.now ?? Date.now();
      const delayMs = runDeadlineDelayMs({
        startedAt: now,
        createdAt,
        maxDurationSeconds: input.limits.maxDurationSeconds,
        deadlineBaseAt: input.deadlineBaseAt ? Date.parse(input.deadlineBaseAt) : undefined,
        now,
      });
      if (delayMs !== undefined && delayMs <= 0) {
        return {
          stop: true,
          reason: "deadline_exceeded",
          eventType: "run.deadline_exceeded",
          message: `运行超过时限预算（${input.limits.maxDurationSeconds}s），已终止本次执行并转人工处理`,
        };
      }
    }
  }

  return { stop: false };
}
