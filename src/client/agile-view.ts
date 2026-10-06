import { BOARD_COLUMNS, boardColumnFor, RELEASE_DEPLOY_STALE_MS, STORY_ESTIMATE_LABELS, STORY_PRIORITY_LABELS, type AgileStory, type BoardColumnId, type ReleaseDeployRecord } from "../shared/agile";
import type { ReleaseRetrospective, ReleaseSummary } from "../shared/agile-metrics";

export interface BoardColumnGroup {
  id: BoardColumnId;
  label: string;
  stories: AgileStory[];
}

/** Buckets stories into the six fixed sprint-board columns. */
export function groupStoriesByColumn(stories: AgileStory[]): BoardColumnGroup[] {
  return BOARD_COLUMNS.map((column) => ({
    id: column.id,
    label: column.label,
    stories: stories.filter((story) => boardColumnFor(story.status) === column.id),
  }));
}

/** One textarea line per acceptance criterion / definition-of-done item. */
export function splitLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function priorityLabel(priority: AgileStory["priority"]): string {
  return STORY_PRIORITY_LABELS[priority] ?? priority;
}

export function estimateLabel(estimate: number | null): string {
  if (estimate === null) return "未估算";
  return STORY_ESTIMATE_LABELS[estimate] ?? `${estimate} 点`;
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

export type ReleaseDeployAction = "publish" | "retry" | "waiting" | "done";

export const RELEASE_DEPLOY_ACTION_LABELS: Record<ReleaseDeployAction, string> = {
  publish: "发布",
  retry: "重试部署",
  waiting: "部署进行中",
  done: "已发布",
};

/**
 * What the publish button should offer, derived from the release's deploy record:
 * a first publish, an explicit retry after a failure/timeout, a wait while an
 * asynchronous deploy is still pending (before the shared timeout), or nothing
 * (successfully deployed / nothing to deploy).
 */
export function releaseDeployAction(deploy: ReleaseDeployRecord | null | undefined, now = Date.now()): ReleaseDeployAction {
  if (!deploy) return "publish";
  if (deploy.status === "failed") return "retry";
  if (deploy.status === "pending") {
    const startedAt = Date.parse(deploy.startedAt ?? deploy.at);
    const age = now - startedAt;
    return Number.isFinite(age) && age >= RELEASE_DEPLOY_STALE_MS ? "retry" : "waiting";
  }
  return "done";
}
