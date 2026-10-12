import { createHash } from "node:crypto";
import type { Run, RunRollbackRecord } from "../shared/types.js";

const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const ROLLBACK_STALE_MS = 2 * 60_000;

export type RollbackStartDecision =
  | { kind: "ready"; rollback: RunRollbackRecord }
  | { kind: "conflict"; status: 409; code: string; message: string };

export function rollbackDeliveryId(runId: string, commit: string, digest: string) {
  const value = createHash("sha256").update(`${runId}\0${commit}\0${digest}`).digest("hex").slice(0, 24);
  return `rollback_${value}`;
}

/**
 * Claims a rollback only from immutable evidence already persisted by a
 * successful production release. A request can select a run, never an image.
 */
export function planRollbackStart(input: {
  run: Run;
  requestedBy: string;
  reason: string;
  now: string;
  retry?: boolean;
  staleAfterMs?: number;
}): RollbackStartDecision {
  const release = input.run.release;
  if (input.run.state !== "completed" || !release || release.status !== "succeeded" || release.environment !== "production") {
    return { kind: "conflict", status: 409, code: "ROLLBACK_TARGET_NOT_PRODUCTION", message: "只能回滚到已成功发布到 production 的任务版本" };
  }
  if (!release.image?.trim() || !IMAGE_DIGEST.test(release.imageDigest ?? "")) {
    return { kind: "conflict", status: 409, code: "ROLLBACK_EVIDENCE_REQUIRED", message: "目标 production 发布缺少不可变镜像证据" };
  }
  const current = input.run.rollback;
  if (current?.status === "publishing" || current?.status === "triggered") {
    const age = Date.parse(input.now) - Date.parse(current.startedAt);
    const staleAfterMs = input.staleAfterMs ?? ROLLBACK_STALE_MS;
    if (!input.retry || !Number.isFinite(age) || age < staleAfterMs) {
      return { kind: "conflict", status: 409, code: "ROLLBACK_IN_PROGRESS", message: "回滚正在执行或等待回调；超时后可显式重试" };
    }
  }
  if (current?.status === "failed" && !input.retry) {
    return { kind: "conflict", status: 409, code: "ROLLBACK_RETRY_REQUIRED", message: "上次回滚失败，请明确选择重试" };
  }
  return {
    kind: "ready",
    rollback: {
      deliveryId: current?.deliveryId ?? rollbackDeliveryId(input.run.id, release.commit, release.imageDigest!),
      status: "publishing",
      environment: "production",
      commit: release.commit,
      image: release.image,
      imageDigest: release.imageDigest!,
      requestedAt: current?.requestedAt ?? input.now,
      requestedBy: input.requestedBy,
      startedAt: input.now,
      attempt: (current?.attempt ?? 0) + 1,
      reason: input.reason.trim(),
    },
  };
}

export function sameRollbackAttempt(current: Run, expected: RunRollbackRecord) {
  return Boolean(current.rollback
    && current.rollback.deliveryId === expected.deliveryId
    && current.rollback.attempt === expected.attempt
    && current.rollback.status === "publishing");
}

export function buildRollbackPayload(input: {
  run: Pick<Run, "id" | "title" | "repository">;
  rollback: RunRollbackRecord;
  callbackUrl: string;
}) {
  return {
    event: "run.rollback_requested",
    runId: input.run.id,
    title: input.run.title,
    repository: input.run.repository,
    deliveryId: input.rollback.deliveryId,
    attempt: input.rollback.attempt,
    environment: "production",
    commit: input.rollback.commit,
    expectedImageDigest: input.rollback.imageDigest,
    reason: input.rollback.reason,
    callbackUrl: input.callbackUrl,
  };
}
