import type { Run, RunMergeRecord, RunReleaseRecord } from "../shared/types.js";
import type { MergeStrategy } from "../shared/merge.js";

/**
 * A2 — server-side (admin) decision helpers for "approve = merge". The actual
 * Git work happens on the worker; these pure helpers decide whether the caller
 * may request a merge and how the (optional) post-merge deploy hook is treated.
 */

export type MergeGate =
  | { kind: "not-requested" }
  | { kind: "forbidden"; status: 403; code: "ADMIN_REQUIRED"; message: string }
  | { kind: "ready" };

/**
 * Only admins may merge a run branch into the workspace's default branch.
 * Reused by the single-run accept path and (indirectly) the batch path so the
 * rule cannot drift between them.
 */
export function planMergeGate(input: { requested: boolean; isAdmin: boolean }): MergeGate {
  if (!input.requested) return { kind: "not-requested" };
  if (!input.isAdmin) {
    return { kind: "forbidden", status: 403, code: "ADMIN_REQUIRED", message: "仅管理员可以将任务分支合并到工作区默认分支" };
  }
  return { kind: "ready" };
}

export type MergeRecord = RunMergeRecord;

/** Run field persisted after a successful merge (additive, backward compatible). */
export function buildMergeRecord(input: {
  commit: string;
  strategy: MergeStrategy;
  targetBranch: string;
  mergedAt: string;
  mergedBy: string;
}): MergeRecord {
  return { ...input };
}

/**
 * Post-merge deploy hook (`PI_POST_MERGE_DEPLOY_HOOK`):
 * - an `http(s)://` URL is called as a webhook;
 * - a `cmd:` prefix runs a bounded shell command (operator-configured only);
 * - anything else / unset is reported as not-configured, never silently skipped.
 */
export type PostMergeDeployPlan =
  | { configured: false; reason: string }
  | { configured: true; kind: "webhook"; url: string }
  | { configured: true; kind: "command"; command: string }
  | { configured: true; kind: "unsupported"; reason: string };

export function planPostMergeDeploy(hook: string | undefined | null): PostMergeDeployPlan {
  const value = (hook ?? "").trim();
  if (!value) return { configured: false, reason: "hook not configured（未设置 PI_POST_MERGE_DEPLOY_HOOK）" };
  if (/^https?:\/\/\S+$/i.test(value)) return { configured: true, kind: "webhook", url: value };
  if (value.startsWith("cmd:")) {
    const command = value.slice(4).trim();
    if (!command) return { configured: true, kind: "unsupported", reason: "deploy hook command is empty" };
    return { configured: true, kind: "command", command };
  }
  return {
    configured: true,
    kind: "unsupported",
    reason: "deploy hook must be an http(s) URL or a `cmd:` command",
  };
}

/** Payload sent to the post-merge deploy webhook / command stdin. */
export function buildDeployHookPayload(input: {
  run: Pick<Run, "id" | "title" | "repository" | "branch" | "baseSha">;
  merge: MergeRecord;
  release?: Pick<RunReleaseRecord, "deliveryId" | "environment" | "attempt" | "requestedBy">;
  callbackUrl?: string;
}) {
  return {
    event: input.release ? "run.release_requested" : "run.merged",
    runId: input.run.id,
    title: input.run.title,
    repository: input.run.repository,
    sourceBranch: input.run.branch,
    baseSha: input.run.baseSha ?? null,
    targetBranch: input.merge.targetBranch,
    commit: input.merge.commit,
    strategy: input.merge.strategy,
    mergedAt: input.merge.mergedAt,
    ...(input.release
      ? {
          deliveryId: input.release.deliveryId,
          environment: input.release.environment,
          attempt: input.release.attempt,
          requestedBy: input.release.requestedBy,
        }
      : {}),
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
  };
}
