import { createHash } from "node:crypto";
import type { Run, RunReleaseRecord } from "../shared/types.js";

/** A crashed synchronous publisher may be retried with the same delivery id. */
export const RELEASE_STALE_MS = 2 * 60_000;

export function isActiveRelease(run: Pick<Run, "release">) {
  return run.release?.status === "publishing" || run.release?.status === "triggered";
}

export type ReleaseStartDecision =
  | { kind: "ready"; release: RunReleaseRecord }
  | { kind: "already-succeeded"; release: RunReleaseRecord }
  | { kind: "conflict"; status: 409; code: string; message: string };

/** Stable across retries, and different for every run/commit/environment tuple. */
export function releaseDeliveryId(runId: string, commit: string, environment: string) {
  const digest = createHash("sha256").update(`${runId}\0${commit}\0${environment}`).digest("hex").slice(0, 24);
  return `release_${digest}`;
}

/**
 * Plans an explicit release without mutating the run. The returned record is
 * persisted before any external hook is invoked.
 */
export function planReleaseStart(input: {
  run: Run;
  environment: string;
  requestedBy: string;
  now: string;
  kind: "webhook" | "command";
  retry?: boolean;
  staleAfterMs?: number;
}): ReleaseStartDecision {
  const { run } = input;
  if (run.state !== "completed") {
    return { kind: "conflict", status: 409, code: "RUN_NOT_RELEASE_READY", message: "只有已完成审核的任务可以发布" };
  }
  if (!run.merge) {
    return { kind: "conflict", status: 409, code: "MERGE_REQUIRED", message: "发布前必须先将审核通过的代码合并到工作区默认分支" };
  }

  const existing = run.release;
  const sameTarget = existing?.commit === run.merge.commit && existing.environment === input.environment;
  const stagingPromotion = existing?.status === "succeeded"
    && existing.commit === run.merge.commit
    && existing.environment === "staging"
    && input.environment === "production";
  if (existing && !sameTarget && !stagingPromotion) {
    return { kind: "conflict", status: 409, code: "RELEASE_TARGET_CHANGED", message: "已有发布记录与当前 commit 或环境不一致，请先完成或回滚该发布" };
  }
  if (existing?.status === "succeeded" && !stagingPromotion) return { kind: "already-succeeded", release: existing };

  if (existing?.status === "triggered" || existing?.status === "publishing") {
    const age = Date.parse(input.now) - Date.parse(existing.startedAt);
    const staleAfterMs = input.staleAfterMs ?? RELEASE_STALE_MS;
    if (!input.retry || !Number.isFinite(age) || age < staleAfterMs) {
      return existing.status === "triggered"
        ? { kind: "conflict", status: 409, code: "RELEASE_AWAITING_RESULT", message: "发布已触发，正在等待部署系统回调；超时后可显式重试" }
        : { kind: "conflict", status: 409, code: "RELEASE_IN_PROGRESS", message: "代码正在发布中；仅可在执行超时后使用重试" };
    }
  }
  if (existing?.status === "failed" && !input.retry) {
    return { kind: "conflict", status: 409, code: "RELEASE_RETRY_REQUIRED", message: "上次发布失败，请明确选择重试发布" };
  }

  const requestedAt = stagingPromotion ? input.now : existing?.requestedAt ?? input.now;
  const deliveryId = stagingPromotion ? releaseDeliveryId(run.id, run.merge.commit, input.environment) : existing?.deliveryId ?? releaseDeliveryId(run.id, run.merge.commit, input.environment);
  return {
    kind: "ready",
    release: {
      deliveryId,
      status: "publishing",
      environment: input.environment,
      commit: run.merge.commit,
      targetBranch: run.merge.targetBranch,
      requestedAt,
      requestedBy: input.requestedBy,
      startedAt: input.now,
      attempt: stagingPromotion ? 1 : (existing?.attempt ?? 0) + 1,
      kind: input.kind,
    },
  };
}

/** CAS guard: only the exact persisted attempt may record its hook result. */
export function sameReleaseAttempt(current: Run, expected: RunReleaseRecord) {
  const release = current.release;
  return Boolean(
    release
    && release.deliveryId === expected.deliveryId
    && release.attempt === expected.attempt
    && release.status === "publishing",
  );
}
