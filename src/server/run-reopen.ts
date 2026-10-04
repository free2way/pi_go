import type { RunState } from "../shared/types.js";

/**
 * B1 — reopening a delivered (`completed`) run. Productizes the manual flow: an
 * admin may reopen it, or the run's owner when they explicitly confirm. The run
 * branch/worktree is intentionally left untouched (only the run record moves).
 */

export type ReopenPlan =
  | { allowed: true; targetState: "needs_human"; reason: "admin" | "owner-confirmed" }
  | { allowed: false; status: 403 | 409; code: "ADMIN_REQUIRED" | "REOPEN_NOT_ALLOWED" | "CONFIRM_REQUIRED"; message: string };

export function planReopen(input: {
  state: RunState;
  isAdmin: boolean;
  isOwner: boolean;
  confirm?: boolean;
}): ReopenPlan {
  if (input.state !== "completed") {
    return {
      allowed: false,
      status: 409,
      code: "REOPEN_NOT_ALLOWED",
      message: "仅「已完成」的任务可以重新打开",
    };
  }
  if (input.isAdmin) return { allowed: true, targetState: "needs_human", reason: "admin" };
  if (!input.isOwner) {
    return { allowed: false, status: 403, code: "ADMIN_REQUIRED", message: "仅管理员或任务所有者可以重新打开任务" };
  }
  if (input.confirm !== true) {
    return { allowed: false, status: 409, code: "CONFIRM_REQUIRED", message: "重新打开需要显式确认（confirm: true）" };
  }
  return { allowed: true, targetState: "needs_human", reason: "owner-confirmed" };
}

/** Event metadata for `run.reopened` (backward compatible: adds a new type only). */
export function reopenEventMeta(input: { reopenedBy: string; reason: "admin" | "owner-confirmed"; note?: string }) {
  return {
    reopenedBy: input.reopenedBy,
    reason: input.reason,
    ...(input.note ? { note: input.note } : {}),
  };
}
