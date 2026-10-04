import type { RunState } from "../shared/types.js";

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
