import type { AgileRelease, ReleaseDeployRecord, StoryStatus } from "../shared/agile.js";
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
 * HTTP 202 is `ok` (the deploy system accepted an asynchronous request).
 */
export function shapeReleaseDeployOutcome(
  plan: PostMergeDeployPlan,
  execution: ReleaseExecutionOutcome | undefined,
  at: string,
): ReleaseDeployRecord {
  if (!plan.configured) return { status: "not_configured", detail: plan.reason, at };
  if (plan.kind === "unsupported") return { status: "unsupported", detail: plan.reason, at };
  if (!execution) return { status: "failed", detail: "deploy hook configured but no execution outcome was recorded", at };
  if (execution.status === "succeeded") return { status: "ok", detail: execution.detail, at };
  if (execution.status === "triggered") return { status: "ok", detail: execution.detail, at };
  return { status: "failed", detail: execution.detail, at };
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
