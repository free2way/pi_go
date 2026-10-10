import { describe, expect, it } from "vitest";
import { RELEASE_DEPLOY_STALE_MS } from "../shared/agile.js";
import { deriveStoryStatus, type AgileProject, type AgileStory } from "../shared/agile";
import type { ReleaseRetrospective, ReleaseSummary } from "../shared/agile-metrics";
import { agileReleaseProgressView, columnPoints, estimateKey, estimateLabel, groupStoriesByColumn, priorityKey, priorityLabel, releaseDeployAction, releaseExportFilename, releaseExportJson, splitLines, storyReference, boardColumnKey, RELEASE_DEPLOY_ACTION_KEYS , projectContentsLabel, projectDeletionWarning } from "./agile-view";
import { t } from "../shared/i18n";

function story(overrides: Partial<AgileStory>): AgileStory {
  return {
    id: `story_${Math.random().toString(36).slice(2)}`,
    projectId: "proj_1",
    ownerId: "user_a",
    title: "故事",
    description: "",
    acceptanceCriteria: [],
    priority: "should",
    estimate: null,
    definitionOfDone: [],
    developerModel: null,
    reviewerModel: null,
    budget: null,
    maxParallel: null,
    status: "backlog",
    sprintId: null,
    workspaceId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupStoriesByColumn", () => {
  it("buckets stories into the six fixed columns, folding backlog+ready into 待办", () => {
    const groups = groupStoriesByColumn([
      story({ status: "backlog" }),
      story({ status: "ready" }),
      story({ status: "in_progress" }),
      story({ status: "in_review" }),
      story({ status: "awaiting_acceptance" }),
      story({ status: "done" }),
      story({ status: "blocked" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["todo", "in_progress", "in_review", "awaiting_acceptance", "done", "blocked"]);
    // Column labels are rendered from the catalog, not baked into the helper.
    expect(groups.map((group) => t("zh", boardColumnKey(group.id)))).toEqual(["待办", "开发中", "审核中", "待验收", "完成", "阻塞"]);
    expect(t("en", boardColumnKey("todo"))).toBe("To do");
    expect(groups.map((group) => group.stories.length)).toEqual([2, 1, 1, 1, 1, 1]);
  });

  it("sums the estimates per column", () => {
    const groups = groupStoriesByColumn([story({ status: "ready", estimate: 3 }), story({ status: "ready", estimate: 5 })]);
    expect(columnPoints(groups[0])).toBe(8);
    expect(columnPoints(groups[1])).toBe(0);
  });

  it("populates 审核中 from a story whose latest run is reviewing", () => {
    const derived = deriveStoryStatus({ state: "reviewing", summary: "", acceptance: undefined });
    expect(derived?.status).toBe("in_review");
    const reviewColumn = groupStoriesByColumn([story({ status: derived!.status })]).find((group) => group.id === "in_review")!;
    expect(reviewColumn.stories).toHaveLength(1);
    expect(groupStoriesByColumn([story({ status: derived!.status })]).find((group) => group.id === "in_progress")!.stories).toHaveLength(0);
  });
});

describe("agile view helpers", () => {
  it("splits textarea lines and drops blanks", () => {
    expect(splitLines("a\n\n  b  \nc")).toEqual(["a", "b", "c"]);
  });

  it("labels priorities and estimates, including the unestimated case", () => {
    expect(priorityKey("must")).toBe("agile.priority.must");
    expect(priorityLabel("must")).toBe("必须");
    expect(priorityLabel("must", "en")).toBe("Must");
    expect(estimateKey(5)).toBe("agile.estimate.5");
    expect(estimateKey(null)).toBe("agile.estimate.none");
    expect(estimateKey(99)).toBeNull();
    expect(estimateLabel(5)).toContain("5 点");
    expect(estimateLabel(null)).toBe("未估算");
    expect(estimateLabel(99)).toBe("99 点");
  });

  it("builds a story reference from the project key and 1-based index", () => {
    expect(storyReference("AUTH", 0)).toBe("AUTH-1");
    expect(storyReference("AUTH", 11)).toBe("AUTH-12");
  });
});

describe("release export helpers", () => {
  const summary = {
    releaseId: "rel_1",
    projectId: "proj_1",
    name: "Checkout",
    version: "v1.2.0",
    status: "released",
    releasedAt: null,
    releasedBy: null,
    deploy: null,
    generatedAt: "2026-02-01T00:00:00.000Z",
    stories: [],
    totals: { stories: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0, runs: 0 },
    usage: { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0, runs: 0 },
    modelCombinations: [],
    merges: [],
    deployments: [],
  } as ReleaseSummary;
  const retrospective = {
    releaseId: "rel_1",
    projectId: "proj_1",
    name: "Checkout",
    version: "v1.2.0",
    releasedAt: null,
    releasedBy: null,
    deploy: null,
    generatedAt: "2026-02-01T00:00:00.000Z",
    totals: { stories: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0, runs: 0 },
    cycleTime: { samples: 0, medianSeconds: 0, p90Seconds: 0, items: [] },
    rework: { completed: 0, reworked: 0, rate: 0 },
    reviewFindings: { total: 0, resolved: 0, notConverging: 0 },
    notConvergingRuns: 0,
    reviewTrend: [],
    costPerCompletedStory: 0,
    usage: { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0, runs: 0 },
    blockedStories: [],
  } as ReleaseRetrospective;

  it("serializes a schema-versioned payload with both datasets", () => {
    const payload = JSON.parse(releaseExportJson({ summary, retrospective }));
    expect(payload.schemaVersion).toBe(1);
    expect(typeof payload.exportedAt).toBe("string");
    expect(payload.summary.version).toBe("v1.2.0");
    expect(payload.retrospective.notConvergingRuns).toBe(0);
  });

  it("derives a filesystem-safe filename and falls back to the release id", () => {
    expect(releaseExportFilename(summary)).toBe("release-v1.2.0-Checkout-retrospective.json");
    expect(releaseExportFilename({ version: " v1 ", name: "结账 发布", releaseId: "rel_9" })).toBe("release-v1-retrospective.json");
    expect(releaseExportFilename({ version: "", name: "", releaseId: "rel_9" })).toBe("release-rel_9-retrospective.json");
  });
});

describe("releaseDeployAction", () => {
  const now = Date.parse("2026-01-02T00:10:00.000Z");

  it("offers a first publish when no deploy was attempted", () => {
    expect(releaseDeployAction(null, now)).toBe("publish");
    expect(releaseDeployAction(undefined, now)).toBe("publish");
  });

  it("offers a retry after a failed deploy", () => {
    expect(releaseDeployAction({ status: "failed", detail: "HTTP 503", at: "2026-01-02T00:00:00.000Z" }, now)).toBe("retry");
  });

  it("waits while a pending deploy is inside the timeout, then offers a retry", () => {
    const deploy = { status: "pending" as const, detail: "HTTP 202", at: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-02T00:00:00.000Z" };
    const started = Date.parse("2026-01-02T00:00:00.000Z");
    expect(releaseDeployAction(deploy, started + RELEASE_DEPLOY_STALE_MS - 1_000)).toBe("waiting");
    expect(releaseDeployAction(deploy, started + RELEASE_DEPLOY_STALE_MS + 1_000)).toBe("retry");
  });

  it("is done for ok / not_configured / unsupported", () => {
    expect(releaseDeployAction({ status: "ok", environment: "staging", detail: "HTTP 200", at: "2026-01-02T00:00:00.000Z" }, now)).toBe("promote");
    expect(releaseDeployAction({ status: "ok", detail: "HTTP 200", at: "2026-01-02T00:00:00.000Z" }, now)).toBe("done");
    expect(releaseDeployAction({ status: "not_configured", detail: "未配置", at: "2026-01-02T00:00:00.000Z" }, now)).toBe("done");
    expect(releaseDeployAction({ status: "unsupported", detail: "无效", at: "2026-01-02T00:00:00.000Z" }, now)).toBe("done");
  });

  it("exposes catalog keys for the publish button", () => {
    expect(t("zh", RELEASE_DEPLOY_ACTION_KEYS.retry)).toBe("重试部署");
    expect(t("en", RELEASE_DEPLOY_ACTION_KEYS.retry)).toBe("Retry deploy");
  });
});

describe("agileReleaseProgressView", () => {
  it("shows request, registration and final-result progress without inventing Run deploy stages", () => {
    expect(agileReleaseProgressView(undefined)).toEqual({
      status: "running",
      request: "active",
      registration: "waiting",
      result: "waiting",
    });
    expect(agileReleaseProgressView({ status: "pending", detail: "HTTP 202", at: "2026-01-02T00:00:00.000Z" })).toEqual({
      status: "running",
      request: "done",
      registration: "active",
      result: "waiting",
    });
    expect(agileReleaseProgressView({ status: "ok", detail: "registered", at: "2026-01-02T00:00:00.000Z" }).status).toBe("succeeded");
    expect(agileReleaseProgressView({ status: "failed", detail: "callback failed", at: "2026-01-02T00:00:00.000Z" })).toMatchObject({
      status: "failed",
      registration: "failed",
      result: "failed",
    });
  });
});

describe("项目管理（删除前告知）", () => {
  const project = (counts?: AgileProject["counts"]): AgileProject => ({
    id: "proj_1",
    ownerId: "user_a",
    name: "身份与权限",
    key: "AUTH",
    description: "",
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    ...(counts ? { counts } : {}),
  });

  it("内容摘要用真实计数；没有计数时不编造", () => {
    expect(projectContentsLabel(project({ sprints: 3, stories: 12, releases: 2 }))).toBe("3 个迭代 · 12 个 story · 2 个发布");
    expect(projectContentsLabel(project({ sprints: 0, stories: 0, releases: 0 }))).toBe("0 个迭代 · 0 个 story · 0 个发布");
    expect(projectContentsLabel(project())).toBe("");
    expect(projectContentsLabel(project({ sprints: 1, stories: 1, releases: 1 }), "en")).toBe("1 sprints · 1 stories · 1 releases");
  });

  it("删除警告写明会级联删掉什么（空项目也如实说 0）", () => {
    expect(projectDeletionWarning(project({ sprints: 2, stories: 5, releases: 1 }))).toBe(
      "将一并删除 2 个迭代、5 个 story、1 个发布，且不可恢复。",
    );
    expect(projectDeletionWarning(project({ sprints: 0, stories: 0, releases: 0 }))).toContain("0 个迭代");
    // 没有计数（单项读取）时退化成通用措辞，不假装知道数量
    expect(projectDeletionWarning(project())).toContain("0 个迭代");
  });
});
