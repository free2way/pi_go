import { releasesStoryBlocks } from "./run-state.js";
import type { ModelSelection, Run } from "./types.js";

/**
 * Sprint 3 batch 1 — agile domain model shared by the server and the client.
 *
 * The Run stays the execution unit; a story is a planning unit that can be
 * "submitted as a run" one or more times. Everything here is pure data plus the
 * pure derivations (`deriveStoryStatus`, `buildStoryRunInput`, board mapping),
 * so it can be unit-tested and reused by the UI without a server round-trip.
 */

/**
 * Priority scale: MoSCoW. Chosen over P0..P3 because it encodes *scope*
 * commitment (what must ship in the increment) rather than just ordering, which
 * matches how acceptance criteria are written in this app.
 */
export type StoryPriority = "must" | "should" | "could" | "wont";
export const STORY_PRIORITIES: StoryPriority[] = ["must", "should", "could", "wont"];
export const STORY_PRIORITY_LABELS: Record<StoryPriority, string> = {
  must: "必须",
  should: "应该",
  could: "可以",
  wont: "本次不做",
};

/**
 * Estimate scale: Fibonacci story points (`1,2,3,5,8,13`). Chosen over T-shirt
 * sizes because points are additive across a sprint, while the UI still shows a
 * human label. `null` means "未估算".
 */
export const STORY_ESTIMATES = [1, 2, 3, 5, 8, 13] as const;
export const STORY_ESTIMATE_LABELS: Record<number, string> = {
  1: "1 点 · 很小",
  2: "2 点 · 小",
  3: "3 点 · 偏小",
  5: "5 点 · 中",
  8: "8 点 · 大",
  13: "13 点 · 很大",
};

export type StoryStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "in_review"
  | "awaiting_acceptance"
  | "done"
  | "blocked";

export const STORY_STATUSES: StoryStatus[] = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "awaiting_acceptance",
  "done",
  "blocked",
];
export const STORY_STATUS_LABELS: Record<StoryStatus, string> = {
  backlog: "待办",
  ready: "就绪",
  in_progress: "开发中",
  in_review: "审核中",
  awaiting_acceptance: "待验收",
  done: "完成",
  blocked: "阻塞",
};

export type SprintStatus = "planned" | "active" | "closed";
export const SPRINT_STATUSES: SprintStatus[] = ["planned", "active", "closed"];
export const SPRINT_STATUS_LABELS: Record<SprintStatus, string> = {
  planned: "已计划",
  active: "进行中",
  closed: "已关闭",
};

export type ReleaseStatus = "planned" | "in_progress" | "released" | "cancelled";
export const RELEASE_STATUSES: ReleaseStatus[] = ["planned", "in_progress", "released", "cancelled"];
export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  planned: "已计划",
  in_progress: "进行中",
  released: "已发布",
  cancelled: "已取消",
};

export type RunBudget = NonNullable<Run["budget"]>;

/**
 * Outcome of the post-publish deploy hook. `not_configured`/`unsupported` mirror
 * `planPostMergeDeploy`; `ok` means a *confirmed* success (synchronous 2xx, or an
 * asynchronous request whose callback reported success); `pending` means the
 * deploy system accepted an asynchronous request (HTTP 202) and the final result
 * has not arrived yet; `failed` is any non-2xx/transport error *or* a timed-out
 * `pending` attempt. A configured-but-failing hook is always recorded, never
 * silently skipped.
 */
export type ReleaseDeployStatus = "not_configured" | "unsupported" | "pending" | "ok" | "failed";
export type ReleaseEnvironment = "staging" | "production";
/**
 * A `pending` deploy older than this is considered timed out: the server
 * materializes it as `failed` (bounded verification, no callback ever arrived)
 * and an explicit retry becomes possible. Shared so the client can offer the
 * retry at the same threshold instead of guessing.
 */
export const RELEASE_DEPLOY_STALE_MS = 2 * 60 * 1000;
export interface ReleaseDeployRecord {
  environment?: ReleaseEnvironment;
  status: ReleaseDeployStatus;
  detail: string;
  /** Last update time of this record. */
  at: string;
  /** Stable deployment identity (`release-publish:<releaseId>`); set once a deploy was attempted. */
  deliveryId?: string;
  /** 1-based deploy attempt; a retry increments it while reusing `deliveryId`. */
  attempt?: number;
  /** When the attempt started; a `pending` record older than the timeout is retryable. */
  startedAt?: string;
  /** When the attempt reached a final status. */
  finishedAt?: string;
  /** Deployment URL / id reported by the deploy system or its callback. */
  url?: string;
  deploymentId?: string;
}

/**
 * Why a deploy settlement was refused without any state change. The callback /
 * settle path must match the exact in-flight attempt, so:
 * - `stale_attempt` — the settle names a different attempt than the in-flight
 *   one (or carries no attempt at all): a late callback from a previous attempt.
 * - `not_pending` — the named attempt is no longer `pending` (already settled).
 */
export type ReleaseDeploySettlementRejection = "stale_attempt" | "not_pending";

export interface AgileProject {
  id: string;
  ownerId: string;
  name: string;
  /** Short unique prefix (e.g. `AUTH`) used to reference stories, like `AUTH-12`. */
  key: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 该项目下的子对象数量（story / 迭代 / 发布）。只有**列表**接口会带它，
   * 用途是"删除前如实告知会一并删掉什么"，单项读取不带（避免无谓的查询）。
   */
  counts?: { stories: number; sprints: number; releases: number };
}

export interface AgileStory {
  id: string;
  projectId: string;
  ownerId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: StoryPriority;
  estimate: number | null;
  definitionOfDone: string[];
  developerModel: ModelSelection | null;
  reviewerModel: ModelSelection | null;
  budget: RunBudget | null;
  maxParallel: number | null;
  status: StoryStatus;
  /** `null` = backlog (not committed to a sprint). */
  sprintId: string | null;
  workspaceId: string | null;
  /**
   * Manual block metadata (Kanban blocked-management). `null`/absent unless an
   * operator blocked the story; a run-derived block keeps its reason in the run
   * summary and leaves these fields untouched.
   */
  blockedReason?: string | null;
  blockedAt?: string | null;
  blockedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgileSprint {
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  goal: string;
  startDate: string | null;
  endDate: string | null;
  status: SprintStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgileRelease {
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  version: string;
  notes: string;
  status: ReleaseStatus;
  storyIds: string[];
  /** Set when the release was published (status `released`); else `null`. */
  releasedAt?: string | null;
  releasedBy?: string | null;
  /**
   * Deploy hook outcome; `null` before publish. An async (HTTP 202) hook stays
   * `pending` until its callback arrives or the bounded timeout marks it failed.
   */
  deploy?: ReleaseDeployRecord | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 4: a saved model combination reusable when creating a run or a story.
 * Lightweight and owner-scoped; `budget`/`maxParallel` are optional so a
 * template may only pin the two models.
 */
export interface ModelTemplate {
  id: string;
  ownerId: string;
  name: string;
  developerModel: ModelSelection;
  reviewerModel: ModelSelection;
  budget: RunBudget | null;
  maxParallel: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The subset of fields a template fills into the run/story forms. */
export interface TemplateApplication {
  developerModel: ModelSelection;
  reviewerModel: ModelSelection;
  budget?: RunBudget;
  maxParallel?: number;
}

/**
 * Pure shaping of the payload the UI writes into a form when a template is
 * picked: unset budget/parallel stay omitted so they never overwrite a value the
 * operator already typed (the picker only fills fields, it never submits).
 */
export function applyModelTemplate(
  template: Pick<ModelTemplate, "developerModel" | "reviewerModel" | "budget" | "maxParallel">,
): TemplateApplication {
  return {
    developerModel: template.developerModel,
    reviewerModel: template.reviewerModel,
    ...(template.budget ? { budget: template.budget } : {}),
    ...(template.maxParallel !== null ? { maxParallel: template.maxParallel } : {}),
  };
}


/** One linked run, flattened to the counters the story detail renders. */
export interface StoryRunSummary {
  runId: string;
  state: Run["state"];
  round: number;
  findings: { resolved: number; total: number };
  checks: { passed: number; failed: number };
  cost: number;
  summary: string;
  linkedAt: string;
  updatedAt: string;
}

export interface StoryDetail extends AgileStory {
  runs: StoryRunSummary[];
}

export type BoardColumnId = "todo" | "in_progress" | "in_review" | "awaiting_acceptance" | "done" | "blocked";

/**
 * Sprint board columns. `todo` intentionally folds `backlog` + `ready` together:
 * on the board both mean "not started yet", while the story lists still show the
 * fine-grained status. `in_review` is fed by the reconciler mapping an active
 * `reviewing` run to `in_review` (see `deriveStoryStatus`).
 */
export const BOARD_COLUMNS: Array<{ id: BoardColumnId; label: string; statuses: StoryStatus[] }> = [
  { id: "todo", label: "待办", statuses: ["backlog", "ready"] },
  { id: "in_progress", label: "开发中", statuses: ["in_progress"] },
  { id: "in_review", label: "审核中", statuses: ["in_review"] },
  { id: "awaiting_acceptance", label: "待验收", statuses: ["awaiting_acceptance"] },
  { id: "done", label: "完成", statuses: ["done"] },
  { id: "blocked", label: "阻塞", statuses: ["blocked"] },
];

export function boardColumnFor(status: StoryStatus): BoardColumnId {
  const column = BOARD_COLUMNS.find((candidate) => candidate.statuses.includes(status));
  return column?.id ?? "todo";
}

export interface StoryStatusDerivation {
  status: StoryStatus;
  /** Why a run pushed the story to `blocked`; empty for other statuses. */
  reason?: string;
}

/**
 * Pure reconciler: derive a story status from its latest linked run, overlaid
 * with an optional *manual* block (Kanban blocked-management).
 *
 * Returns `undefined` when neither a run is linked nor a manual block is set, so
 * manual planning state (`backlog`/`ready`) is never clobbered.
 *
 * Precedence (documented in docs/14-agile-domain-model.md): a run waiting for a
 * human (`needs_human`) is `blocked` with the *run's* reason even if it carries
 * an old acceptance snapshot (a reopened run keeps `acceptance`) and even if a
 * manual block is set. A *terminal* run (completed/failed/cancelled) never holds
 * a run-level block — a cancelled/failed run is final, so there is nothing left
 * to resolve and the story is released (see `releasesStoryBlocks`); a completed
 * run moves the story to awaiting acceptance. An accepted run is `done` (a manual
 * block never un-dones a delivered story); otherwise a manual block wins over the
 * derived active statuses (`in_progress`/`in_review`/`awaiting_acceptance`) and
 * shows the manual reason; then a finished run awaits acceptance, a failed or
 * cancelled run returns the story to `ready` (retryable — it delivered nothing,
 * and `in_progress` used to deadlock the story: see docs/19), an active
 * `reviewing` run is `in_review`, and every other active state is `in_progress`.
 */
export function deriveStoryStatus(
  run: Pick<Run, "state" | "summary" | "acceptance"> | undefined | null,
  manual?: { blockedReason?: string | null } | null,
): StoryStatusDerivation | undefined {
  const manualReason = manual?.blockedReason?.trim() || undefined;
  if (!run) return manualReason ? { status: "blocked", reason: manualReason } : undefined;
  const reason = run.summary?.trim() || undefined;
  // Only `needs_human` parks the story at the run level. Terminal end states
  // (failed/cancelled) used to block too, which deadlocked the board: the run
  // could never advance again, yet manual unblock refused with BLOCKED_BY_RUN.
  if (run.state === "needs_human") {
    return { status: "blocked", reason: reason ?? "运行需要人工处理" };
  }
  if (run.acceptance) return { status: "done" };
  if (manualReason) return { status: "blocked", reason: manualReason };
  if (run.state === "completed") return { status: "awaiting_acceptance" };
  if (run.state === "reviewing") return { status: "in_review" };
  // A failed/cancelled run delivered nothing and can never advance, so the story
  // is retryable again (`ready`) instead of being stuck at `in_progress`, which
  // made the submit guard refuse it forever.
  if (releasesStoryBlocks(run.state)) return { status: "ready" };
  // queued / preparing / developing / checking
  return { status: "in_progress" };
}

/** Compose the run task text from a story's description + AC + DoD. */
export function composeStoryTask(story: Pick<AgileStory, "title" | "description" | "acceptanceCriteria" | "definitionOfDone">): string {
  const sections: string[] = [];
  const description = story.description.trim();
  if (description) sections.push(description);
  const criteria = story.acceptanceCriteria.map((item) => item.trim()).filter(Boolean);
  if (criteria.length > 0) {
    sections.push(["## 验收标准", ...criteria.map((item, index) => `${index + 1}. ${item}`)].join("\n"));
  }
  const dod = story.definitionOfDone.map((item) => item.trim()).filter(Boolean);
  if (dod.length > 0) {
    sections.push(["## 完成定义", ...dod.map((item) => `- ${item}`)].join("\n"));
  }
  return sections.join("\n\n").trim();
}

export interface StoryRunInput {
  title: string;
  task: string;
  acceptanceCriteria?: string;
  workspaceId?: string;
  checks: string[];
  developerModel?: ModelSelection;
  reviewerModel?: ModelSelection;
  budget?: RunBudget;
  maxParallel?: number;
}

/**
 * Pure builder for the `POST /api/runs` payload behind `POST /api/stories/:id/runs`.
 * Checks default to the workspace's registered commands; models, budget and
 * parallel come from the story when set, so appending to an existing call never
 * changes its meaning.
 */
export function buildStoryRunInput(
  story: AgileStory,
  options: { checks?: string[]; workspaceId?: string } = {},
): StoryRunInput {
  const criteria = story.acceptanceCriteria.map((item) => item.trim()).filter(Boolean);
  const task = composeStoryTask(story);
  return {
    title: story.title.trim().slice(0, 80),
    task: task || story.title.trim(),
    ...(criteria.length > 0 ? { acceptanceCriteria: criteria.join("\n") } : {}),
    ...(options.workspaceId ?? story.workspaceId ? { workspaceId: options.workspaceId ?? story.workspaceId ?? undefined } : {}),
    checks: (options.checks ?? []).map((item) => item.trim()).filter(Boolean),
    ...(story.developerModel ? { developerModel: story.developerModel } : {}),
    ...(story.reviewerModel ? { reviewerModel: story.reviewerModel } : {}),
    ...(story.budget ? { budget: story.budget } : {}),
    ...(story.maxParallel !== null ? { maxParallel: story.maxParallel } : {}),
  };
}

/** Flatten a run into the counters the story detail shows for it. */
export function summarizeStoryRun(run: Run, linkedAt: string): StoryRunSummary {
  return {
    runId: run.id,
    state: run.state,
    round: run.round,
    findings: {
      resolved: run.findings.filter((finding) => finding.resolved).length,
      total: run.findings.length,
    },
    checks: {
      passed: run.checks.filter((check) => check.status === "passed").length,
      failed: run.checks.filter((check) => check.status === "failed").length,
    },
    cost: run.usage?.estimatedCost ?? 0,
    summary: run.summary,
    linkedAt,
    updatedAt: run.updatedAt,
  };
}

/**
 * Pick the run a story's status should be derived from: the most recently linked
 * one, falling back to whichever linked run was updated last when links share a
 * timestamp (second granularity in the link table).
 */
export function latestLinkedRun<T extends { run: Run; linkedAt: string }>(entries: T[]): T | undefined {
  return [...entries].sort((left, right) => {
    const byLink = right.linkedAt.localeCompare(left.linkedAt);
    if (byLink !== 0) return byLink;
    return right.run.updatedAt.localeCompare(left.run.updatedAt);
  })[0];
}
