/**
 * B1 — two-phase, compensating "approve = merge" coordinator.
 *
 * The old flow called the worker (which mutated Git) *before* persisting the
 * merge record, so a DB failure or a concurrent approval could leave the
 * workspace merged while the run still showed unfinished. This module performs:
 *
 *   phase 1  claim the merge with a guarded CAS write of `run.mergePending`
 *            (state `in_progress`, carrying the whole intended approval payload);
 *            a concurrent approval loses the CAS and gets `MERGE_IN_PROGRESS`.
 *   phase 2  call the worker; on success record the durable retry intent
 *            (`committed_unrecorded` + commit/strategy) and then finalize the
 *            run (`merge` + `state: completed` + acceptance) and clear the marker.
 *
 * A bounded replay (`replayPendingMerge`) is invoked from run reads, so a
 * `committed_unrecorded` marker always converges to the merged commit — the
 * database never stays silent about a workspace that already merged. Every
 * write is idempotent (CAS + a stable delivery id on the `run.merged` event), so
 * running the replay more than once records the merge exactly once.
 *
 * The pure planners (`planMergeBegin`, `planMergeReplay`) are side-effect free
 * and unit-tested without a database.
 */

import type { Run, RunMergePending, RunMergeRecord, RunEvent } from "../shared/types.js";
import type { AppendEventOptions, GuardedUpdateResult, UpdateGuard } from "./store.js";
import type { MergeResult } from "../shared/merge.js";
import { buildMergeRecord } from "./run-merge.js";

export const MERGE_IN_PROGRESS_CODE = "MERGE_IN_PROGRESS" as const;
export const MERGE_RECORD_FAILED_CODE = "MERGE_RECORD_FAILED" as const;

/**
 * A pending `in_progress` marker older than this is treated as abandoned (the
 * web process crashed before the worker returned) and is cleared by the replay
 * so the operator can retry. Kept comfortably above the worker merge timeout.
 */
export const MERGE_PENDING_STALE_MS = 10 * 60_000;

/** The subset of the run store the coordinator needs (structurally satisfied by RunStoreLike). */
export interface MergeApprovalStore {
  getRun(id: string, owner?: string | string[]): Run | undefined;
  updateRun(id: string, patch: Partial<Run>): Promise<Run>;
  updateRunGuarded(id: string, guard: UpdateGuard, patch: Partial<Run>): Promise<GuardedUpdateResult>;
  appendEvent(event: Omit<RunEvent, "seq">, options?: AppendEventOptions): Promise<RunEvent>;
}

export function mergeInProgressMessage() {
  return "该任务正在合并中，请稍后重试（MERGE_IN_PROGRESS）";
}

/** Guard that only the current token holder may write. */
export function tokenGuard(token: string): UpdateGuard {
  return (run) =>
    run.mergePending?.token === token
      ? { allow: true }
      : { allow: false, code: MERGE_IN_PROGRESS_CODE, message: mergeInProgressMessage() };
}

/** Phase-1 guard: nobody may claim a merge that is already recorded or in flight. */
export const startMergeGuard: UpdateGuard = (run) =>
  run.merge || run.mergePending
    ? { allow: false, code: MERGE_IN_PROGRESS_CODE, message: mergeInProgressMessage() }
    : { allow: true };

// --------------------------------------------------------------------- planners

export type MergeBeginDecision =
  | { kind: "start"; pending: RunMergePending }
  | { kind: "converge"; pending: RunMergePending }
  | { kind: "already-merged"; merge: RunMergeRecord }
  | { kind: "conflict"; status: 409; code: typeof MERGE_IN_PROGRESS_CODE; message: string };

/**
 * Decides how a merge-requested acceptance proceeds from the current run. The
 * caller passes the candidate marker it wants to claim with:
 * - no marker and no merge      -> `start`
 * - a `committed_unrecorded` one -> `converge` (never call the worker again)
 * - `merge` already recorded    -> `already-merged` (idempotent finalize)
 * - an `in_progress` one        -> `conflict` (another approval owns it)
 */
export function planMergeBegin(input: { run: Pick<Run, "merge" | "mergePending">; pending: RunMergePending }): MergeBeginDecision {
  const { run, pending } = input;
  if (run.merge) return { kind: "already-merged", merge: run.merge };
  const existing = run.mergePending;
  if (existing) {
    if (existing.state === "committed_unrecorded" && existing.commit && existing.strategy && existing.targetBranch) {
      return { kind: "converge", pending: existing };
    }
    return { kind: "conflict", status: 409, code: MERGE_IN_PROGRESS_CODE, message: mergeInProgressMessage() };
  }
  return { kind: "start", pending };
}

/** Builds the merge record from a durable pending marker (replay path). */
export function mergeRecordFromPending(pending: RunMergePending): RunMergeRecord | undefined {
  if (!pending.commit || !pending.strategy || !pending.targetBranch) return undefined;
  return buildMergeRecord({
    commit: pending.commit,
    strategy: pending.strategy,
    targetBranch: pending.targetBranch,
    mergedAt: pending.mergedAt ?? pending.startedAt,
    mergedBy: pending.approval.acceptedBy,
  });
}

export type MergeReplayPlan =
  | { kind: "none" }
  | { kind: "finalize"; pending: RunMergePending; merge: RunMergeRecord }
  | { kind: "clear-pending"; pending: RunMergePending };

/**
 * Decides what (if anything) a run read must do to converge a leftover marker:
 * - a `committed_unrecorded` marker with a commit -> `finalize`
 * - a marker whose merge is already recorded      -> `clear-pending`
 * - a stale `in_progress` marker (crashed request) -> `clear-pending`
 * - a fresh `in_progress` marker                   -> `none` (still in flight)
 */
export function planMergeReplay(
  run: Pick<Run, "state" | "merge" | "mergePending">,
  nowMs: number,
): MergeReplayPlan {
  const pending = run.mergePending;
  if (!pending) return { kind: "none" };
  if (run.merge) return { kind: "clear-pending", pending };
  if (pending.state === "committed_unrecorded") {
    const merge = mergeRecordFromPending(pending);
    if (!merge) return { kind: "none" };
    // Never force a terminal state into `completed`; only an open (or already
    // accepted) run may be converged.
    if (run.state !== "needs_human" && run.state !== "completed") return { kind: "clear-pending", pending };
    return { kind: "finalize", pending, merge };
  }
  // An abandoned in_progress marker (the request died before the worker
  // returned) is only cleared once genuinely stale, so a live merge is never
  // disturbed.
  const startedMs = Date.parse(pending.startedAt);
  if (Number.isFinite(startedMs) && nowMs - startedMs > MERGE_PENDING_STALE_MS) {
    return { kind: "clear-pending", pending };
  }
  return { kind: "none" };
}

/** The single patch that records a merge and finishes the acceptance. */
export function buildMergeFinalizePatch(input: {
  run: Pick<Run, "humanNotes">;
  pending: RunMergePending;
  merge: RunMergeRecord;
}): Partial<Run> {
  const { pending, merge } = input;
  const { acceptedAt, acceptedBy, summary, note, acceptance } = pending.approval;
  return {
    state: "completed",
    approvedAt: acceptedAt,
    approvedBy: acceptedBy,
    summary,
    acceptance,
    merge,
    mergePending: undefined,
    ...(note
      ? { humanNotes: [{ at: acceptedAt, kind: "approve_accept" as const, note, by: acceptedBy }] }
      : {}),
  };
}

// ----------------------------------------------------------------- coordinator

export interface MergeApprovalRequest {
  run: Run;
  /** Unique token for this attempt (the caller generates it). */
  token: string;
  targetBranch: string | null;
  approval: RunMergePending["approval"];
  startedAt: string;
  /** Calls the worker merge endpoint; may throw for transport failures. */
  callWorker: (targetBranch: string | null) => Promise<MergeResult>;
}

export type MergeApprovalOutcome =
  | { kind: "merged"; merge: RunMergeRecord; run: Run; replayed: boolean }
  | { kind: "conflict"; status: 409; code: typeof MERGE_IN_PROGRESS_CODE; message: string }
  | { kind: "worker-error"; status: number; code: string; error: string; conflictingPaths?: string[] }
  | { kind: "record-failed"; status: 503; code: typeof MERGE_RECORD_FAILED_CODE; error: string; merge: RunMergeRecord };

const WORKSPACE_MERGE_ERRORS = ["MERGE_CONFLICT", "RUN_DIRECTORY_MISSING", "WORKSPACE_DIRTY", "TARGET_BRANCH_UNAVAILABLE", "MERGE_FETCH_FAILED", "TARGET_BRANCH_UNKNOWN"];

async function appendMergedEvent(store: MergeApprovalStore, run: Run, merge: RunMergeRecord) {
  // The delivery id makes the event idempotent, so a replay (or a duplicate
  // approval) can never append the same merge twice.
  await store.appendEvent(
    {
      runId: run.id,
      round: run.round,
      source: "system",
      type: "run.merged",
      message: `已合并到 ${merge.targetBranch}（${merge.strategy}）：${merge.commit.slice(0, 10)}`,
      at: merge.mergedAt,
      meta: { ...merge },
    },
    { deliveryId: `merge:${merge.commit}` },
  );
}

/**
 * Finalizes one merge (fresh or replayed) with a single guarded CAS write:
 * records `run.merge`, moves to `completed`, writes the acceptance snapshot and
 * clears the pending marker. The event append is best-effort and idempotent.
 */
async function finalizeMerge(
  store: MergeApprovalStore,
  run: Run,
  pending: RunMergePending,
  merge: RunMergeRecord,
  guard: UpdateGuard,
  replayed: boolean,
): Promise<MergeApprovalOutcome> {
  let result: GuardedUpdateResult;
  try {
    result = await store.updateRunGuarded(run.id, guard, buildMergeFinalizePatch({ run, pending, merge }));
  } catch (error) {
    return { kind: "record-failed", status: 503, code: MERGE_RECORD_FAILED_CODE, error: (error as Error).message, merge };
  }
  if (!result.ok) {
    return { kind: "record-failed", status: 503, code: MERGE_RECORD_FAILED_CODE, error: result.message, merge };
  }
  await appendMergedEvent(store, result.run, merge).catch(() => undefined);
  return { kind: "merged", merge, run: result.run, replayed };
}

export async function coordinateApprovedMerge(
  store: MergeApprovalStore,
  request: MergeApprovalRequest,
): Promise<MergeApprovalOutcome> {
  const candidate: RunMergePending = {
    token: request.token,
    state: "in_progress",
    sourceBranch: request.run.branch,
    targetBranch: request.targetBranch,
    startedAt: request.startedAt,
    startedBy: request.approval.acceptedBy,
    approval: request.approval,
  };

  // ---- Phase 1: claim the merge (guarded CAS, replanned on a lost race).
  let current = request.run;
  let claimed: Run | undefined;
  for (let attempt = 0; attempt < 3 && !claimed; attempt += 1) {
    const decision = planMergeBegin({ run: current, pending: candidate });
    if (decision.kind === "conflict") {
      return { kind: "conflict", status: decision.status, code: decision.code, message: decision.message };
    }
    if (decision.kind === "converge") {
      const merge = mergeRecordFromPending(decision.pending);
      if (!merge) return { kind: "conflict", status: 409, code: MERGE_IN_PROGRESS_CODE, message: mergeInProgressMessage() };
      return finalizeMerge(store, current, decision.pending, merge, tokenGuard(decision.pending.token), true);
    }
    if (decision.kind === "already-merged") {
      return finalizeMerge(store, current, candidate, decision.merge, () => ({ allow: true }), true);
    }
    const result = await store.updateRunGuarded(current.id, startMergeGuard, { mergePending: candidate });
    if (result.ok) claimed = result.run;
    else current = result.run;
  }
  if (!claimed) {
    return { kind: "conflict", status: 409, code: MERGE_IN_PROGRESS_CODE, message: mergeInProgressMessage() };
  }

  // ---- Phase 2: worker merge.
  let workerResult: MergeResult;
  try {
    workerResult = await request.callWorker(request.targetBranch);
  } catch (error) {
    await store.updateRunGuarded(claimed.id, tokenGuard(candidate.token), { mergePending: undefined }).catch(() => undefined);
    return { kind: "worker-error", status: 503, code: "MERGE_UNAVAILABLE", error: (error as Error).message };
  }
  if (!workerResult.ok) {
    await store.updateRunGuarded(claimed.id, tokenGuard(candidate.token), { mergePending: undefined }).catch(() => undefined);
    return {
      kind: "worker-error",
      status: WORKSPACE_MERGE_ERRORS.includes(workerResult.code) ? 409 : 503,
      code: workerResult.code,
      error: workerResult.error,
      ...(workerResult.conflictingPaths ? { conflictingPaths: workerResult.conflictingPaths } : {}),
    };
  }

  const mergedAt = new Date().toISOString();
  const merge = buildMergeRecord({
    commit: workerResult.commit,
    strategy: workerResult.strategy,
    targetBranch: workerResult.targetBranch,
    mergedAt,
    mergedBy: request.approval.acceptedBy,
  });

  // Phase 2a: persist the durable retry intent *before* the full record, so a
  // failure while finalizing still leaves the commit recoverable.
  const intent: RunMergePending = {
    ...candidate,
    state: "committed_unrecorded",
    targetBranch: workerResult.targetBranch,
    commit: workerResult.commit,
    strategy: workerResult.strategy,
    mergedAt,
  };
  try {
    const intentWrite = await store.updateRunGuarded(claimed.id, tokenGuard(candidate.token), { mergePending: intent });
    if (!intentWrite.ok) {
      return { kind: "record-failed", status: 503, code: MERGE_RECORD_FAILED_CODE, error: intentWrite.message, merge };
    }
  } catch (error) {
    return { kind: "record-failed", status: 503, code: MERGE_RECORD_FAILED_CODE, error: (error as Error).message, merge };
  }

  // Phase 2b: finalize. If this write fails, the intent above makes the merge
  // recoverable and `replayPendingMerge` converges it exactly once.
  return finalizeMerge(store, claimed, intent, merge, tokenGuard(candidate.token), false);
}

/**
 * Bounded, idempotent convergence invoked from run reads. Never throws: a
 * transient database failure simply leaves the marker for the next read.
 */
export async function replayPendingMerge(
  store: MergeApprovalStore,
  runId: string,
  nowMs = Date.now(),
): Promise<Run | undefined> {
  const run = store.getRun(runId);
  if (!run) return undefined;
  const plan = planMergeReplay(run, nowMs);
  if (plan.kind === "none") return run;
  try {
    if (plan.kind === "clear-pending") {
      const cleared = await store.updateRunGuarded(runId, tokenGuard(plan.pending.token), { mergePending: undefined });
      return cleared.ok ? cleared.run : run;
    }
    const outcome = await finalizeMerge(store, run, plan.pending, plan.merge, tokenGuard(plan.pending.token), true);
    return outcome.kind === "merged" ? outcome.run : run;
  } catch {
    return run;
  }
}
