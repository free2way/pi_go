import { BOARD_COLUMNS, boardColumnFor, type AgileProject, RELEASE_DEPLOY_STALE_MS, type AgileStory, type BoardColumnId, type ReleaseDeployRecord, type ReleaseStatus, type SprintStatus, type StoryPriority, type StoryStatus } from "../shared/agile";
import type { ReleaseRetrospective, ReleaseSummary } from "../shared/agile-metrics";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";

export interface BoardColumnGroup {
  id: BoardColumnId;
  stories: AgileStory[];
}

/** Buckets stories into the six fixed sprint-board columns. */
export function groupStoriesByColumn(stories: AgileStory[]): BoardColumnGroup[] {
  return BOARD_COLUMNS.map((column) => ({
    id: column.id,
    stories: stories.filter((story) => boardColumnFor(story.status) === column.id),
  }));
}

/** Catalog key for a board column's label (the label itself lives in the catalog). */
export function boardColumnKey(id: BoardColumnId): MessageKey {
  return `agile.board.${id}` as MessageKey;
}

/** One textarea line per acceptance criterion / definition-of-done item. */
export function splitLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

const PRIORITY_KEYS: Record<StoryPriority, MessageKey> = {
  must: "agile.priority.must",
  should: "agile.priority.should",
  could: "agile.priority.could",
  wont: "agile.priority.wont",
};

export function priorityKey(priority: AgileStory["priority"]): MessageKey {
  return PRIORITY_KEYS[priority] ?? "common.unknown";
}

export function priorityLabel(priority: AgileStory["priority"], locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, priorityKey(priority));
}

const ESTIMATE_VALUES = [1, 2, 3, 5, 8, 13];

/** Catalog key for an estimate, or `null` for a value outside the scale. */
export function estimateKey(estimate: number | null): MessageKey | null {
  if (estimate === null) return "agile.estimate.none";
  if (ESTIMATE_VALUES.includes(estimate)) return `agile.estimate.${estimate}` as MessageKey;
  return null;
}

export function estimateLabel(estimate: number | null, locale: Locale = DEFAULT_LOCALE): string {
  const key = estimateKey(estimate);
  if (key) return t(locale, key);
  return t(locale, "agile.points", { count: estimate ?? 0 });
}

/** Story reference shown on cards: `AUTH-3` using its index within the project. */
export function storyReference(key: string, index: number): string {
  return `${key}-${index + 1}`;
}

/** Client-side total of the estimates in a board column ("点数" summary). */
export function columnPoints(group: BoardColumnGroup): number {
  return group.stories.reduce((total, story) => total + (story.estimate ?? 0), 0);
}

/**
 * Stable export payload for the 「导出回顾 (JSON)」 action: the summary and the
 * retrospective exactly as the API returned them, plus a schema marker so a
 * later importer can tell revisions apart.
 */
export function releaseExportPayload(input: {
  summary: ReleaseSummary;
  retrospective: ReleaseRetrospective;
}): { schemaVersion: number; exportedAt: string; summary: ReleaseSummary; retrospective: ReleaseRetrospective } {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    summary: input.summary,
    retrospective: input.retrospective,
  };
}

export function releaseExportJson(input: { summary: ReleaseSummary; retrospective: ReleaseRetrospective }): string {
  return JSON.stringify(releaseExportPayload(input), null, 2);
}

/** Filesystem-safe download name, e.g. `release-v1.2.0-checkout-retrospective.json`. */
export function releaseExportFilename(summary: Pick<ReleaseSummary, "version" | "name" | "releaseId">): string {
  const raw = `${summary.version}-${summary.name}`.trim();
  const safe = raw.replace(/[^\w.-]+/g, "_").replace(/^[_.-]+|[_.-]+$/g, "");
  return `release-${safe || summary.releaseId}-retrospective.json`;
}

const STORY_STATUS_KEYS: Record<StoryStatus, MessageKey> = {
  backlog: "agile.storyStatus.backlog",
  ready: "agile.storyStatus.ready",
  in_progress: "agile.storyStatus.in_progress",
  in_review: "agile.storyStatus.in_review",
  awaiting_acceptance: "agile.storyStatus.awaiting_acceptance",
  done: "agile.storyStatus.done",
  blocked: "agile.storyStatus.blocked",
};

export function storyStatusKey(status: StoryStatus): MessageKey {
  return STORY_STATUS_KEYS[status] ?? "common.unknown";
}

export function storyStatusLabel(status: StoryStatus, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, storyStatusKey(status));
}

const SPRINT_STATUS_KEYS: Record<SprintStatus, MessageKey> = {
  planned: "agile.sprintStatus.planned",
  active: "agile.sprintStatus.active",
  closed: "agile.sprintStatus.closed",
};

export function sprintStatusKey(status: SprintStatus): MessageKey {
  return SPRINT_STATUS_KEYS[status] ?? "common.unknown";
}

const RELEASE_STATUS_KEYS: Record<ReleaseStatus, MessageKey> = {
  planned: "agile.releaseStatus.planned",
  in_progress: "agile.releaseStatus.in_progress",
  released: "agile.releaseStatus.released",
  cancelled: "agile.releaseStatus.cancelled",
};

export function releaseStatusKey(status: ReleaseStatus): MessageKey {
  return RELEASE_STATUS_KEYS[status] ?? "common.unknown";
}

const DEPLOY_STATUS_KEYS: Record<ReleaseDeployRecord["status"], MessageKey> = {
  not_configured: "agile.deployStatus.not_configured",
  unsupported: "agile.deployStatus.unsupported",
  pending: "agile.deployStatus.pending",
  ok: "agile.deployStatus.ok",
  failed: "agile.deployStatus.failed",
};

export function deployStatusKey(status: ReleaseDeployRecord["status"]): MessageKey {
  return DEPLOY_STATUS_KEYS[status] ?? "common.unknown";
}

export type ReleaseDeployAction = "publish" | "promote" | "retry" | "waiting" | "done";

/** Catalog keys for the deploy button (labels live in the catalog). */
export const RELEASE_DEPLOY_ACTION_KEYS: Record<ReleaseDeployAction, MessageKey> = {
  publish: "agile.deployAction.publish",
  promote: "agile.deployAction.promote",
  retry: "agile.deployAction.retry",
  waiting: "agile.deployAction.waiting",
  done: "agile.deployAction.done",
};

/**
 * What the publish button should offer, derived from the release's deploy record:
 * a first publish, an explicit retry after a failure/timeout, a wait while an
 * asynchronous deploy is still pending (before the shared timeout), or nothing
 * (successfully deployed / nothing to deploy).
 */
export function releaseDeployAction(deploy: ReleaseDeployRecord | null | undefined, now = Date.now()): ReleaseDeployAction {
  if (!deploy) return "publish";
  if (deploy.status === "ok" && deploy.environment === "staging") return "promote";
  if (deploy.status === "failed") return "retry";
  if (deploy.status === "pending") {
    const startedAt = Date.parse(deploy.startedAt ?? deploy.at);
    const age = now - startedAt;
    return Number.isFinite(age) && age >= RELEASE_DEPLOY_STALE_MS ? "retry" : "waiting";
  }
  return "done";
}

/** 项目内容摘要：`3 个迭代 · 12 个 story · 2 个发布`（计数由列表接口提供）。 */
export function projectContentsLabel(project: AgileProject, locale: Locale = DEFAULT_LOCALE): string {
  const counts = project.counts;
  if (!counts) return "";
  return t(locale, "agile.manage.contents", { sprints: counts.sprints, stories: counts.stories, releases: counts.releases });
}

/**
 * 删除前的如实告知。服务端会在一个事务里级联清理 story_runs → stories → sprints → releases → 项目，
 * 所以这里必须把"会一并删掉什么"说清楚；没有计数时退化成通用措辞（不假装知道数量）。
 */
export function projectDeletionWarning(project: AgileProject, locale: Locale = DEFAULT_LOCALE): string {
  const counts = project.counts ?? { sprints: 0, stories: 0, releases: 0 };
  return t(locale, "agile.manage.warning", { sprints: counts.sprints, stories: counts.stories, releases: counts.releases });
}
