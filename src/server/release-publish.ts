import { RELEASE_DEPLOY_STALE_MS, type AgileRelease, type ReleaseDeployRecord, type StoryStatus } from "../shared/agile.js";
import type { RunState } from "../shared/types.js";
import type { ReleaseExecutionOutcome } from "./release-execution.js";
import type { PostMergeDeployPlan } from "./run-merge.js";

/**
 * Release publish action (Sprint 5) — pure planning/shaping helpers.
 *
 * The route stays a thin adapter: guards and the deploy-outcome mapping live
 * here so they can be unit-tested without a database or the Fastify app. The
 * deploy transport itself is reused from `executeRelease` (never duplicated).
 */

/** A deploy that is still `pending` after this long is timed out and retryable. */
export { RELEASE_DEPLOY_STALE_MS };

/**
 * `release.requireAdmin: true` (config/workflow.example.yaml) makes publishing a
 * release administrator-only, exactly like `POST /api/runs/:id/publish`. Owner
 * status grants no exemption: a non-admin owner is still refused.
 */
export type ReleasePublishGate =
  | { kind: "ready" }
  | { kind: "forbidden"; status: 403; code: "ADMIN_REQUIRED"; message: string };

export function planReleasePublishGate(input: { isAdmin: boolean }): ReleasePublishGate {
  if (!input.isAdmin) {
    return { kind: "forbidden", status: 403, code: "ADMIN_REQUIRED", message: "仅管理员可以发布代码" };
  }
  return { kind: "ready" };
}

/**
 * Stable deployment identity for a release. Mirrors `releaseDeliveryId` for runs
 * (stable across retries so the receiver can de-duplicate; the release is the
 * deployment unit, so its id is the `run` slot of the documented
 * `run+commit+environment` key).
 */
export function releaseDeployDeliveryId(releaseId: string) {
  return `release-publish:${releaseId}`;
}

/**
 * Whether the release publish is already settled and must not be confirmed
 * again: a `released` release whose deploy reached a final, non-retryable state
 * (`ok`/`not_configured`/`unsupported`) or that never recorded a deploy. A
 * `failed`/timed-out deploy is deliberately *not* terminal — see
 * `planReleaseDeployAttempt`, which allows an explicit retry.
 */
export function isReleasePublishTerminal(release: Pick<AgileRelease, "status" | "deploy">): boolean {
  const deploy = release.deploy ?? null;
  if (release.status !== "released") return false;
  if (!deploy) return true;
  return deploy.status === "ok" || deploy.status === "not_configured" || deploy.status === "unsupported";
}

export type ReleaseDeployDecision =
  | { kind: "ready"; deliveryId: string; attempt: number; expired?: ReleaseDeployRecord }
  | { kind: "conflict"; status: 409; code: string; message: string };

/**
 * Decides whether a confirmed publish may start a new deploy attempt, and which
 * attempt number it is. The attempt is derived from the *observed* deploy state
 * (never from a counter), so two simultaneous confirms for the same state compute
 * the same attempt and therefore the same DB idempotency key — exactly one wins.
 *
 * - first publish (or a publish that never recorded a deploy) → attempt 1;
 * - already succeeded / nothing to wait for → `RELEASE_RELEASED` (409);
 * - `failed` → only with an explicit `retry` (`RELEASE_RETRY_REQUIRED`);
 * - `pending` → refused until the bounded timeout, then only with `retry`; a
 *   timed-out attempt is returned as `expired` so the caller records it failed.
 */
export function planReleaseDeployAttempt(input: {
  release: Pick<AgileRelease, "id" | "status" | "deploy">;
  retry?: boolean;
  now: string;
  staleAfterMs?: number;
}): ReleaseDeployDecision {
  const deliveryId = releaseDeployDeliveryId(input.release.id);
  const deploy = input.release.deploy ?? null;
  const retry = input.retry === true;
  if (!deploy) {
    if (input.release.status === "released") {
      return { kind: "conflict", status: 409, code: "RELEASE_RELEASED", message: "发布已发布，不可重复发布" };
    }
    return { kind: "ready", deliveryId, attempt: 1 };
  }
  const nextAttempt = (deploy.attempt ?? 1) + 1;
  if (deploy.status === "ok" || deploy.status === "not_configured" || deploy.status === "unsupported") {
    return { kind: "conflict", status: 409, code: "RELEASE_RELEASED", message: "发布已发布，不可重复发布" };
  }
  if (deploy.status === "failed") {
    if (!retry) {
      return { kind: "conflict", status: 409, code: "RELEASE_RETRY_REQUIRED", message: "上次部署失败，请明确选择重试部署" };
    }
    return { kind: "ready", deliveryId, attempt: nextAttempt };
  }
  // pending: bounded verification — only a timed-out attempt may be retried.
  const startedAt = deploy.startedAt ?? deploy.at;
  const age = Date.parse(input.now) - Date.parse(startedAt);
  const staleAfterMs = input.staleAfterMs ?? RELEASE_DEPLOY_STALE_MS;
  const stale = Number.isFinite(age) && age >= staleAfterMs;
  if (!stale) {
    return retry
      ? { kind: "conflict", status: 409, code: "RELEASE_IN_PROGRESS", message: "部署正在进行中；仅可在回调超时后重试" }
      : { kind: "conflict", status: 409, code: "RELEASE_AWAITING_RESULT", message: "部署已触发，正在等待部署系统回调；超时后可显式重试" };
  }
  const expired: ReleaseDeployRecord = {
    ...deploy,
    status: "failed",
    detail: `等待部署系统回调超时（超过 ${Math.round(staleAfterMs / 60_000)} 分钟未收到结果）`,
    at: input.now,
    finishedAt: input.now,
  };
  if (!retry) {
    return { kind: "conflict", status: 409, code: "RELEASE_DEPLOY_TIMEOUT", message: `${expired.detail}，请显式重试部署` };
  }
  return { kind: "ready", deliveryId, attempt: nextAttempt, expired };
}

/** One release story, already reconciled to its derived status. */
export interface ReleasePublishStory {
  storyId: string;
  title: string;
  status: StoryStatus;
  /** Derived reason; present only when `status` is `blocked`. */
  reason?: string;
  /** Latest linked run state, echoed to the UI when the story is blocked. */
  runState?: RunState | null;
}

export interface ReleasePublishBlockedStory extends ReleasePublishStory {
  reason: string;
}

export type ReleasePublishPlan =
  | { kind: "empty"; status: 409; code: "RELEASE_EMPTY"; message: string }
  | { kind: "blocked"; status: 409; code: "RELEASE_BLOCKED"; message: string; blocked: ReleasePublishBlockedStory[] }
  | { kind: "ready" };

/**
 * Publish guards: a release must reference at least one story, and none of its
 * stories may currently be `blocked` (manual or run-derived). Returns the blocked
 * stories with their reasons so the caller can answer 409 `RELEASE_BLOCKED`.
 */
export function planReleasePublish(input: { stories: ReleasePublishStory[]; label?: string }): ReleasePublishPlan {
  const label = input.label?.trim() || "该发布";
  if (input.stories.length === 0) {
    return { kind: "empty", status: 409, code: "RELEASE_EMPTY", message: `${label}不包含任何故事，无法发布` };
  }
  const blocked: ReleasePublishBlockedStory[] = input.stories
    .filter((story) => story.status === "blocked")
    .map((story) => ({ ...story, reason: story.reason?.trim() || "阻塞（无原因说明）" }));
  if (blocked.length > 0) {
    return {
      kind: "blocked",
      status: 409,
      code: "RELEASE_BLOCKED",
      message: `${label}仍有 ${blocked.length} 个阻塞故事，需先解除阻塞`,
      blocked,
    };
  }
  return { kind: "ready" };
}

/**
 * Maps the deploy plan + execution outcome onto the release's recorded deploy
 * status. A configured-but-failing hook is always `failed` (never skipped); an
 * HTTP 202 is only `pending` — the deploy system accepted an asynchronous
 * request and the final result must arrive via callback (or the bounded timeout
 * marks it failed), so it is never recorded as premature success.
 */
export function shapeReleaseDeployOutcome(
  plan: PostMergeDeployPlan,
  execution: ReleaseExecutionOutcome | undefined,
  at: string,
  identity: { deliveryId?: string; attempt?: number } = {},
): ReleaseDeployRecord {
  const id = {
    ...(identity.deliveryId ? { deliveryId: identity.deliveryId } : {}),
    ...(identity.attempt === undefined ? {} : { attempt: identity.attempt }),
  };
  if (!plan.configured) return { status: "not_configured", detail: plan.reason, at, ...id };
  if (plan.kind === "unsupported") return { status: "unsupported", detail: plan.reason, at, ...id };
  if (!execution) return { status: "failed", detail: "deploy hook configured but no execution outcome was recorded", at, ...id };
  if (execution.status === "succeeded") return { status: "ok", detail: execution.detail, at, finishedAt: at, ...id };
  if (execution.status === "triggered") return { status: "pending", detail: execution.detail, at, startedAt: at, ...id };
  return { status: "failed", detail: execution.detail, at, finishedAt: at, ...id };
}

/** Payload sent to the deploy hook for a release publish (reuses `executeRelease`). */
export function buildReleaseDeployPayload(input: {
  release: Pick<AgileRelease, "id" | "projectId" | "name" | "version">;
  stories: Array<Pick<ReleasePublishStory, "storyId" | "title" | "status">>;
  releasedAt: string;
  releasedBy: string;
  note?: string;
  callbackUrl?: string;
}) {
  return {
    event: "release.published",
    releaseId: input.release.id,
    projectId: input.release.projectId,
    name: input.release.name,
    version: input.release.version,
    releasedAt: input.releasedAt,
    releasedBy: input.releasedBy,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    stories: input.stories.map((story) => ({ storyId: story.storyId, title: story.title, status: story.status })),
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
  };
}
